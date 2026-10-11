import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { GraphFrame, GraphNode, ParamValue, PortRef, SocketDecl } from "@/core/nodes/graphTypes";
import type { INode, PortType } from "@/core/nodes/INode";
import type { GraphEditor } from "@/core/nodes/NodeGraphDocument";
import { nodeRegistry } from "@/core/nodes/nodeRegistry";
import { PORT_COLORS, canConnectTypes, isSingleLink } from "@/core/nodes/portTypes";
import {
  addNodes,
  checkConnection,
  connect,
  createNode,
  extractFragment,
  findPort,
  firstCompatiblePort,
  nodePorts,
  nodeTitle,
  setSockets,
  addFrame,
  removeFrames,
  setFrameMembership,
  updateFrame,
  pasteFragment,
  removeEdges,
  removeNodes,
  setNodePositions,
  setParam,
  type GraphFragment,
} from "@/core/nodes/graphOps";
import { GraphNodeView } from "../GraphNodeView/GraphNodeView";
import { FRAME_COLORS, GraphFrameView, type FrameRect } from "../GraphFrameView/GraphFrameView";
import { AddNodeMenu } from "../AddNodeMenu/AddNodeMenu";
import { NodeContextMenu, type ContextMenuItem } from "../NodeContextMenu/NodeContextMenu";
import { nodeLayout, socketPosition, wirePath } from "../nodeLayout";
import styles from "./NodeCanvas.module.scss";

// ─── Types ────────────────────────────────────────────────────────────────────

interface View {
  x: number;
  y: number;
  zoom: number;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
const GRID = 20;
/** Screen px a press must travel before it counts as a drag. */
const DRAG_SLOP = 3;
const DOUBLE_PRESS_MS = 400;
/** Space between framed nodes and the frame edge; the header sits above. */
const FRAME_PAD = 24;
const FRAME_HEADER = 34;
const FRAME_MIN = { width: 120, height: 60 };

/** The fixed end of a link being dragged. `anchorSide` is the side of the
 *  anchor port; the free end looks for a port on the opposite side. */
interface LinkAnchor {
  anchorSide: "in" | "out";
  anchor: PortRef;
  type: PortType;
}

interface LinkTarget {
  ref: PortRef;
  ok: boolean;
  reason: string | null;
}

type Interaction =
  | {
      kind: "pan";
      /** Right-click: what was pressed, for the context menu. */
      target?: ContextTarget;
      pointerId: number;
      button: number;
      startX: number;
      startY: number;
      view: View;
      moved: boolean;
    }
  | {
      kind: "nodes";
      pointerId: number;
      startX: number;
      startY: number;
      base: Map<string, { x: number; y: number }>;
      moved: boolean;
    }
  | {
      kind: "marquee";
      pointerId: number;
      x0: number;
      y0: number;
      base: ReadonlySet<string>;
    }
  | ({ kind: "link"; pointerId: number; detached: boolean } & LinkAnchor)
  | {
      /** Dragging a frame by its header, with the nodes inside it. */
      kind: "frame";
      pointerId: number;
      frameId: string;
      startX: number;
      startY: number;
      base: { x: number; y: number };
      nodeBase: Map<string, { x: number; y: number }>;
    }
  | {
      kind: "frame-resize";
      pointerId: number;
      frameId: string;
      startX: number;
      startY: number;
      base: { width: number; height: number };
    };

interface LinkDraft extends LinkAnchor {
  /** Free end, graph space. */
  x: number;
  y: number;
  target: LinkTarget | null;
}

/** What a right-click landed on. */
interface ContextTarget {
  nodeId?: string;
  frameId?: string;
  edgeId?: string;
}

interface ContextMenuState {
  /** Canvas-local px (where "Add Node…" opens the node list). */
  left: number;
  top: number;
  /** Screen position of the menu. */
  clientX: number;
  clientY: number;
  /** Graph-space point (paste target). */
  gx: number;
  gy: number;
}

interface MenuState {
  /** Canvas-local px. */
  left: number;
  top: number;
  /** Graph-space point new nodes are placed at. */
  gx: number;
  gy: number;
  link?: LinkAnchor;
}

/** Node clipboard, shared by every graph (paste drops nodes that don't
 *  belong to the target domain). */
let clipboard: GraphFragment | null = null;

const EMPTY_SET: ReadonlySet<string> = new Set();

// ─── Component ────────────────────────────────────────────────────────────────

interface NodeCanvasProps {
  /** The graph being edited (a root document or a nested body). */
  doc: GraphEditor;
  /** Open the body of subgraph node `nodeId` (double-click / header button). */
  onOpenBody?: (nodeId: string) => void;
  /** Leave the current body (Esc with nothing to cancel or deselect). */
  onExitBody?: () => void;
  /** Select and frame this node (a new `seq` repeats the request). */
  focusNode?: { id: string; seq: number } | null;
  /** Node to flag as the cause of a compile error. */
  errorNodeId?: string | null;
}

/**
 * Pan/zoom viewport over a node graph. Nodes are DOM elements inside a
 * transformed "world" layer and wires are SVG paths in the same layer, so
 * both share graph-space coordinates. All pointer interaction is handled
 * here via event delegation on `data-*` attributes.
 */
export function NodeCanvas({
  doc,
  errorNodeId = null,
  onOpenBody,
  onExitBody,
  focusNode = null,
}: NodeCanvasProps): React.JSX.Element {
  const graph = useSyncExternalStore(doc.subscribe, doc.getSnapshot);
  const rootRef = useRef<HTMLDivElement>(null);

  const [view, setView] = useState<View>(() => doc.view ?? { x: 40, y: 40, zoom: 1 });
  const [selection, setSelection] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [selectedFrame, setSelectedFrame] = useState<string | null>(null);
  const [editingFrame, setEditingFrame] = useState<string | null>(null);
  /** Measured header heights of frames (graph units). */
  const [headerHeights, setHeaderHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const [draft, setDraft] = useState<LinkDraft | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const viewRef = useRef(view);
  viewRef.current = view;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const interaction = useRef<Interaction | null>(null);
  /** Last pointer position, canvas-local px (paste / add-menu anchor). */
  const pointer = useRef({ x: 0, y: 0 });
  const spaceHeld = useRef(false);
  const lastNodePress = useRef<{ id: string; t: number } | null>(null);

  useEffect(() => {
    doc.view = view;
  }, [doc, view]);

  const nodeById = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, n])),
    [graph.nodes],
  );

  const connectedInputs = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of graph.edges) {
      const list = m.get(e.to.node);
      if (list) list.push(e.to.port);
      else m.set(e.to.node, [e.to.port]);
    }
    const out = new Map<string, string>();
    for (const [id, ports] of m) out.set(id, ports.sort().join(","));
    return out;
  }, [graph.edges]);

  // ── Coordinates ─────────────────────────────────────────────────────────────

  const toLocal = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = rootRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toGraph = (lx: number, ly: number): { x: number; y: number } => {
    const v = viewRef.current;
    return { x: (lx - v.x) / v.zoom, y: (ly - v.y) / v.zoom };
  };

  // ── View ────────────────────────────────────────────────────────────────────

  const onHeaderHeight = useCallback((frameId: string, height: number) => {
    setHeaderHeights((prev) =>
      prev.get(frameId) === height ? prev : new Map(prev).set(frameId, height),
    );
  }, []);

  /** A frame's drawn rectangle: its stored rectangle grown to hold its
   *  members (minus `exclude`) below the header. */
  const frameRect = useCallback(
    (f: GraphFrame, exclude?: ReadonlySet<string>): FrameRect => {
      let x0 = f.x, y0 = f.y, x1 = f.x + f.width, y1 = f.y + f.height;
      const header = headerHeights.get(f.id) ?? FRAME_HEADER;
      for (const id of f.nodeIds) {
        if (exclude?.has(id)) continue;
        const n = doc.graph.nodes.find((x) => x.id === id);
        const def = n && nodeRegistry.get(n.type);
        if (!n || !def) continue;
        const l = nodeLayout(n, def, doc.graph);
        x0 = Math.min(x0, n.x - FRAME_PAD);
        y0 = Math.min(y0, n.y - FRAME_PAD - header);
        x1 = Math.max(x1, n.x + l.width + FRAME_PAD);
        y1 = Math.max(y1, n.y + l.height + FRAME_PAD);
      }
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    },
    [doc, headerHeights],
  );

  /** The frame (topmost first) whose area holds `node`'s centre, ignoring
   *  the nodes in `exclude` when sizing frames. */
  const frameAt = (node: GraphNode, exclude: ReadonlySet<string>): string | null => {
    const def = nodeRegistry.get(node.type);
    if (!def) return null;
    const l = nodeLayout(node, def, doc.graph);
    const cx = node.x + l.width / 2;
    const cy = node.y + l.height / 2;
    const frames = doc.graph.frames ?? [];
    for (let i = frames.length - 1; i >= 0; i--) {
      const r = frameRect(frames[i], exclude);
      if (cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height) return frames[i].id;
    }
    return null;
  };

  /** Graph-space bounds of the given nodes (all nodes and frames when
   *  `ids` is empty), or null when there's nothing. */
  const boundsOf = useCallback(
    (ids: ReadonlySet<string>) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of doc.graph.nodes) {
        if (ids.size > 0 && !ids.has(n.id)) continue;
        const def = nodeRegistry.get(n.type);
        if (!def) continue;
        const l = nodeLayout(n, def, doc.graph);
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + l.width);
        maxY = Math.max(maxY, n.y + l.height);
      }
      if (ids.size === 0) {
        for (const f of doc.graph.frames ?? []) {
          const r = frameRect(f);
          minX = Math.min(minX, r.x);
          minY = Math.min(minY, r.y);
          maxX = Math.max(maxX, r.x + r.width);
          maxY = Math.max(maxY, r.y + r.height);
        }
      }
      return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
    },
    [doc, frameRect],
  );

  /** Fit the given nodes (everything when empty) into the viewport. */
  const frameNodes = useCallback(
    (ids: ReadonlySet<string>) => {
      const el = rootRef.current;
      if (!el) return;
      const W = el.clientWidth;
      const H = el.clientHeight;
      const b = boundsOf(ids);
      const minX = b?.minX ?? Infinity;
      const minY = b?.minY ?? Infinity;
      const maxX = b?.maxX ?? -Infinity;
      const maxY = b?.maxY ?? -Infinity;
      if (!Number.isFinite(minX)) {
        setView({ x: W / 2, y: H / 2, zoom: 1 });
        return;
      }
      const pad = 48;
      const zoom = Math.max(
        MIN_ZOOM,
        Math.min(1, (W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxY - minY)),
      );
      setView({
        zoom,
        x: W / 2 - ((minX + maxX) / 2) * zoom,
        y: H / 2 - ((minY + maxY) / 2) * zoom,
      });
    },
    [boundsOf],
  );

  useLayoutEffect(() => {
    if (!doc.view) frameNodes(EMPTY_SET);
  }, [doc, frameNodes]);

  // Jump to a node on request (e.g. a compile issue in the properties panel).
  useLayoutEffect(() => {
    if (!focusNode || !doc.graph.nodes.some((n) => n.id === focusNode.id)) return;
    const ids = new Set([focusNode.id]);
    setSelection(ids);
    frameNodes(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one jump per request
  }, [focusNode?.seq]);

  // Wheel zoom around the cursor. Native listener: React's is passive.
  useEffect(() => {
    const el = rootRef.current!;
    const onWheel = (e: WheelEvent): void => {
      if ((e.target as Element).closest("[data-nodrag]")) return;
      e.preventDefault();
      const v = viewRef.current;
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * Math.exp(-delta * 0.0015)));
      const k = zoom / v.zoom;
      setView({ zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ── Graph edits ─────────────────────────────────────────────────────────────

  const onSocketsChange = useCallback(
    (nodeId: string, sockets: readonly SocketDecl[]) => {
      doc.commit(setSockets(doc.graph, nodeId, sockets));
    },
    [doc],
  );

  const openBodyRef = useRef(onOpenBody);
  openBodyRef.current = onOpenBody;
  const onOpenBodyStable = useCallback((nodeId: string) => openBodyRef.current?.(nodeId), []);

  const onParamChange = useCallback(
    (nodeId: string, key: string, value: ParamValue) => {
      doc.commit(setParam(doc.graph, nodeId, key, value), `param:${nodeId}:${key}`);
    },
    [doc],
  );

  const deleteSelection = (): void => {
    let g = doc.graph;
    if (selectedEdge) g = removeEdges(g, new Set([selectedEdge]));
    if (selectedFrame) g = removeFrames(g, new Set([selectedFrame]));
    g = removeNodes(g, selectionRef.current);
    doc.commit(g);
    setSelection(EMPTY_SET);
    setSelectedEdge(null);
    setSelectedFrame(null);
  };

  /** Put a comment frame around the selected nodes and start editing it. */
  const frameSelection = (): void => {
    const b = boundsOf(selectionRef.current);
    if (!b || selectionRef.current.size === 0) return;
    const id = crypto.randomUUID();
    const members = selectionRef.current;
    doc.commit(
      setFrameMembership(
        addFrame(doc.graph, {
          id,
          nodeIds: [],
          x: Math.round(b.minX - FRAME_PAD),
        y: Math.round(b.minY - FRAME_PAD - FRAME_HEADER),
        width: Math.round(b.maxX - b.minX + FRAME_PAD * 2),
        height: Math.round(b.maxY - b.minY + FRAME_PAD * 2 + FRAME_HEADER),
          text: "",
          color: FRAME_COLORS[(doc.graph.frames?.length ?? 0) % FRAME_COLORS.length],
        }),
        members,
        id,
      ),
    );
    setSelection(EMPTY_SET);
    setSelectedEdge(null);
    setSelectedFrame(id);
    setEditingFrame(id);
  };

  const onFrameText = useCallback(
    (frameId: string, text: string) => {
      setEditingFrame(null);
      const frame = doc.graph.frames?.find((f) => f.id === frameId);
      if (frame && frame.text !== text) doc.commit(updateFrame(doc.graph, frameId, { text }));
      rootRef.current?.focus({ preventScroll: true });
    },
    [doc],
  );
  const onFrameCancel = useCallback(() => {
    setEditingFrame(null);
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  const onFrameColor = useCallback(
    (frameId: string, color: string) => doc.commit(updateFrame(doc.graph, frameId, { color })),
    [doc],
  );

  /** Paste so the fragment's top-left (nodes and frames) lands at (gx, gy). */
  const pasteAt = (frag: GraphFragment, gx: number, gy: number): void => {
    if (frag.nodes.length === 0) return;
    const minX = Math.min(...frag.nodes.map((n) => n.x), ...frag.frames.map((f) => f.x));
    const minY = Math.min(...frag.nodes.map((n) => n.y), ...frag.frames.map((f) => f.y));
    const r = pasteFragment(doc.graph, frag, gx - minX, gy - minY);
    doc.commit(r.graph);
    setSelection(r.newIds);
    setSelectedEdge(null);
    setSelectedFrame(null);
  };

  /** What copy / duplicate take: selected nodes, plus the selected frame
   *  with its members. */
  const copySelection = (): GraphFragment =>
    extractFragment(
      doc.graph,
      selectionRef.current,
      selectedFrame ? new Set([selectedFrame]) : undefined,
    );

  // -- Commands (shared by the keyboard and the context menu) -----------------

  const clearSelection = (): void => {
    setSelection(EMPTY_SET);
    setSelectedEdge(null);
    setSelectedFrame(null);
  };

  const copyCommand = (): void => {
    const frag = copySelection();
    if (frag.nodes.length > 0) clipboard = frag;
  };

  /** Cut removes exactly what was copied: the nodes and the frames that came
   *  along with them. */
  const cutCommand = (): void => {
    const frag = copySelection();
    if (frag.nodes.length === 0) return;
    clipboard = frag;
    const nodeIds = new Set(frag.nodes.map((n) => n.id));
    const frameIds = new Set(frag.frames.map((f) => f.id));
    doc.commit(removeFrames(removeNodes(doc.graph, nodeIds), frameIds));
    clearSelection();
  };

  const pasteCommand = (gx: number, gy: number): void => {
    if (clipboard) pasteAt(clipboard, gx, gy);
  };

  const duplicateCommand = (): void => {
    const frag = copySelection();
    if (frag.nodes.length === 0) return;
    const minX = Math.min(...frag.nodes.map((n) => n.x), ...frag.frames.map((f) => f.x));
    const minY = Math.min(...frag.nodes.map((n) => n.y), ...frag.frames.map((f) => f.y));
    pasteAt(frag, minX + GRID, minY + GRID);
  };

  /** Take the selected nodes out of their frames. */
  const removeFromFrameCommand = (): void => {
    if (selectionRef.current.size > 0) {
      doc.commit(setFrameMembership(doc.graph, selectionRef.current, null));
    }
  };

  /** Remove a frame; its nodes stay. */
  const ungroupCommand = (frameId: string): void => {
    doc.commit(removeFrames(doc.graph, new Set([frameId])));
    setSelectedFrame(null);
  };

  // ── Add-node menu ───────────────────────────────────────────────────────────

  const openMenu = (local: { x: number; y: number }, link?: LinkAnchor): void => {
    const g = toGraph(local.x, local.y);
    setContextMenu(null);
    setMenu({ left: local.x, top: local.y, gx: g.x, gy: g.y, link });
  };

  /** Open the context menu for a right-click on `target`. Like most editors,
   *  right-clicking something unselected selects it first; right-clicking
   *  empty canvas keeps the selection. */
  const openContextMenu = (local: { x: number; y: number }, target: ContextTarget): void => {
    if (target.nodeId && !selectionRef.current.has(target.nodeId)) {
      const sel = new Set([target.nodeId]);
      selectionRef.current = sel;
      setSelection(sel);
      setSelectedEdge(null);
      setSelectedFrame(null);
    } else if (target.frameId) {
      // A frame header under a crossing wire: the header wins.
      setSelection(EMPTY_SET);
      selectionRef.current = EMPTY_SET;
      setSelectedEdge(null);
      setSelectedFrame(target.frameId);
    } else if (target.edgeId) {
      setSelection(EMPTY_SET);
      selectionRef.current = EMPTY_SET;
      setSelectedFrame(null);
      setSelectedEdge(target.edgeId);
    }
    const g = toGraph(local.x, local.y);
    const r = rootRef.current!.getBoundingClientRect();
    setMenu(null);
    setContextMenu({
      left: local.x,
      top: local.y,
      clientX: r.left + local.x,
      clientY: r.top + local.y,
      gx: g.x,
      gy: g.y,
    });
  };

  const menuDefs = useMemo((): INode[] => {
    if (!menu) return [];
    const present = new Set(graph.nodes.map((n) => n.type));
    const link = menu.link;
    return nodeRegistry
      .forDomain(graph.domain)
      .filter((d) => !d.boundary && !(d.unique && present.has(d.type)))
      // A body reports through its boundary node, not a graph output.
      .filter((d) => !(graph.subgraph && d.graphOutput))
      .filter(
        (d) =>
          !link ||
          firstCompatiblePort(d, link.anchorSide === "out" ? "in" : "out", link.type),
      );
  }, [menu, graph.nodes, graph.domain, graph.subgraph]);

  const addFromMenu = (def: INode): void => {
    if (!menu) return;
    const link = menu.link;
    const freeSide = link?.anchorSide === "out" ? "in" : "out";
    const fresh = createNode(def, 0, 0, doc.graph.domain);
    const port = link ? firstCompatiblePort(def, freeSide, link.type, fresh) : undefined;
    const layout = nodeLayout(fresh, def, doc.graph);
    // Place the node so the socket being connected lands under the cursor.
    let x = menu.gx;
    let y = menu.gy;
    if (port) {
      y -= (freeSide === "in" ? layout.inputY : layout.outputY).get(port.id) ?? 0;
      if (freeSide === "out") x -= layout.width;
    }
    const node = { ...fresh, x: Math.round(x), y: Math.round(y) };
    let g = addNodes(doc.graph, [node]);
    // Added inside a frame: it joins the frame.
    const frame = frameAt(node, EMPTY_SET);
    if (frame) g = setFrameMembership(g, new Set([node.id]), frame);
    if (link && port) {
      const ref = { node: node.id, port: port.id };
      const r =
        link.anchorSide === "out" ? connect(g, link.anchor, ref) : connect(g, ref, link.anchor);
      if (r.ok) g = r.graph;
    }
    doc.commit(g);
    setSelection(new Set([node.id]));
    setSelectedEdge(null);
    setMenu(null);
    rootRef.current?.focus({ preventScroll: true });
  };

  // ── Linking ─────────────────────────────────────────────────────────────────

  /** The port under the cursor that the dragged link would attach to.
   *  Dropping on a node body picks its first compatible port, preferring
   *  unconnected inputs. */
  const findLinkTarget = (clientX: number, clientY: number, a: LinkAnchor): LinkTarget | null => {
    const el = document.elementFromPoint(clientX, clientY);
    const want = a.anchorSide === "out" ? "in" : "out";
    let ref: PortRef | null = null;
    const socket = el?.closest<HTMLElement>("[data-port-side]");
    if (socket && socket.dataset.portSide === want) {
      ref = { node: socket.dataset.nodeId!, port: socket.dataset.portId! };
    } else {
      const nodeId = el?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
      const node = nodeId ? doc.graph.nodes.find((n) => n.id === nodeId) : undefined;
      const def = node && node.id !== a.anchor.node ? nodeRegistry.get(node.type) : undefined;
      if (node && def) {
        const taken = new Set(
          doc.graph.edges.filter((e) => e.to.node === node.id).map((e) => e.to.port),
        );
        const all = nodePorts(def, node, doc.graph);
        const ports = want === "in" ? all.inputs : all.outputs;
        const fits = ports.filter((p) =>
          want === "in" ? canConnectTypes(a.type, p.type) : canConnectTypes(p.type, a.type),
        );
        const port = (want === "in" ? fits.find((p) => !taken.has(p.id)) : undefined) ?? fits[0];
        if (port) ref = { node: node.id, port: port.id };
      }
    }
    if (!ref) return null;
    const [from, to] = a.anchorSide === "out" ? [a.anchor, ref] : [ref, a.anchor];
    const reason = checkConnection(doc.graph, from, to);
    return { ref, ok: reason === null, reason };
  };

  const startLink = (socket: HTMLElement, e: React.PointerEvent, local: { x: number; y: number }): boolean => {
    const side = socket.dataset.portSide as "in" | "out";
    const nodeId = socket.dataset.nodeId!;
    const portId = socket.dataset.portId!;
    const node = doc.graph.nodes.find((n) => n.id === nodeId);
    const port = node && findPort(doc.graph, node, side, portId);
    if (!node || !port) return false;

    let a: LinkAnchor = { anchorSide: side, anchor: { node: nodeId, port: portId }, type: port.type };
    let detached = false;
    // Grabbing a connected single-link input picks its wire back up.
    if (side === "in" && isSingleLink(port.type, "in")) {
      const edge = doc.graph.edges.find((x) => x.to.node === nodeId && x.to.port === portId);
      const src = edge && nodeById.get(edge.from.node);
      const srcPort = src && findPort(doc.graph, src, "out", edge.from.port);
      if (edge && srcPort) {
        doc.beginGesture();
        doc.preview(removeEdges(doc.graph, new Set([edge.id])));
        a = { anchorSide: "out", anchor: edge.from, type: srcPort.type };
        detached = true;
      }
    }
    interaction.current = { kind: "link", pointerId: e.pointerId, detached, ...a };
    const g = toGraph(local.x, local.y);
    setDraft({ ...a, x: g.x, y: g.y, target: null });
    return true;
  };

  // ── Pointer ─────────────────────────────────────────────────────────────────

  const cancelInteraction = (): void => {
    const it = interaction.current;
    interaction.current = null;
    if (!it) return;
    if (
      it.kind === "nodes" ||
      it.kind === "frame" ||
      it.kind === "frame-resize" ||
      (it.kind === "link" && it.detached)
    ) {
      doc.cancelGesture();
    }
    setDraft(null);
    setMarquee(null);
  };

  /** The element matching `selector` at the pointer. Wires' hit areas sit
   *  above frames, so a press on a wire that crosses a frame's header or
   *  handle still reaches the frame. */
  const frameElementAt = (
    e: React.PointerEvent,
    selector: string,
  ): HTMLElement | undefined => {
    const direct = (e.target as Element).closest<HTMLElement>(selector);
    if (direct || !(e.target as Element).closest("[data-edge-id]")) return direct ?? undefined;
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      const hit = el.closest<HTMLElement>(selector);
      if (hit) return hit;
    }
    return undefined;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const target = e.target as Element;
    if (target.closest("[data-nodrag]") || interaction.current) return;
    rootRef.current!.focus({ preventScroll: true });
    const local = toLocal(e);
    pointer.current = local;
    setMenu(null);
    setContextMenu(null);

    let started = false;
    if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceHeld.current)) {
      e.preventDefault();
      interaction.current = {
        kind: "pan",
        target:
          e.button === 2
            ? {
                nodeId: target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId,
                frameId: frameElementAt(e, "[data-frame-header]")?.dataset.frameHeader,
                edgeId: target.closest<SVGElement>("[data-edge-id]")?.dataset.edgeId,
              }
            : undefined,
        pointerId: e.pointerId,
        button: e.button,
        startX: e.clientX,
        startY: e.clientY,
        view: viewRef.current,
        moved: false,
      };
      started = true;
    } else if (e.button === 0) {
      const socket = target.closest<HTMLElement>("[data-port-side]");
      const nodeEl = target.closest<HTMLElement>("[data-node-id]");
      const edgeId = target.closest<SVGElement>("[data-edge-id]")?.dataset.edgeId;
      const frameHandle = frameElementAt(e, "[data-frame-handle]")?.dataset.frameHandle;
      const frameHeader = frameElementAt(e, "[data-frame-header]")?.dataset.frameHeader;
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;

      if (socket) {
        started = startLink(socket, e, local);
      } else if (nodeEl) {
        const id = nodeEl.dataset.nodeId!;
        // Double press opens a subgraph node's body. (Detected here rather
        // than with dblclick: pointer capture retargets click events.)
        const last = lastNodePress.current;
        lastNodePress.current = { id, t: e.timeStamp };
        if (last?.id === id && e.timeStamp - last.t < DOUBLE_PRESS_MS) {
          lastNodePress.current = null;
          if (doc.graph.nodes.find((n) => n.id === id)?.body) {
            onOpenBody?.(id);
            return;
          }
        }
        let sel = selectionRef.current;
        if (additive && sel.has(id)) {
          const next = new Set(sel);
          next.delete(id);
          setSelection(next);
          return;
        }
        if (additive) sel = new Set([...sel, id]);
        else if (!sel.has(id)) sel = new Set([id]);
        setSelection(sel);
        setSelectedEdge(null);
        setSelectedFrame(null);
        const base = new Map<string, { x: number; y: number }>();
        for (const n of doc.graph.nodes) if (sel.has(n.id)) base.set(n.id, { x: n.x, y: n.y });
        doc.beginGesture();
        interaction.current = {
          kind: "nodes",
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          base,
          moved: false,
        };
        started = true;
      } else if (frameHandle) {
        const f = doc.graph.frames?.find((x) => x.id === frameHandle);
        if (f) {
          setSelectedFrame(f.id);
          // Resize from the drawn rectangle: it becomes the stored one.
          const r = frameRect(f);
          doc.beginGesture();
          doc.preview(updateFrame(doc.graph, f.id, r));
          interaction.current = {
            kind: "frame-resize",
            pointerId: e.pointerId,
            frameId: f.id,
            startX: e.clientX,
            startY: e.clientY,
            base: { width: r.width, height: r.height },
          };
          started = true;
        }
      } else if (frameHeader) {
        const f = doc.graph.frames?.find((x) => x.id === frameHeader);
        const last = lastNodePress.current;
        lastNodePress.current = { id: `frame:${frameHeader}`, t: e.timeStamp };
        if (f && last?.id === `frame:${f.id}` && e.timeStamp - last.t < DOUBLE_PRESS_MS) {
          lastNodePress.current = null;
          e.preventDefault();
          setEditingFrame(f.id);
          return;
        }
        if (f) {
          setSelectedFrame(f.id);
          setSelection(EMPTY_SET);
          setSelectedEdge(null);
          // Its members move with it.
          const nodeBase = new Map<string, { x: number; y: number }>();
          for (const n of doc.graph.nodes) {
            if (f.nodeIds.includes(n.id)) nodeBase.set(n.id, { x: n.x, y: n.y });
          }
          doc.beginGesture();
          interaction.current = {
            kind: "frame",
            pointerId: e.pointerId,
            frameId: f.id,
            startX: e.clientX,
            startY: e.clientY,
            base: { x: f.x, y: f.y },
            nodeBase,
          };
          started = true;
        }
      } else if (edgeId) {
        setSelectedEdge(edgeId);
        setSelection(EMPTY_SET);
        setSelectedFrame(null);
      } else {
        setSelectedFrame(null);
        const base = additive ? selectionRef.current : EMPTY_SET;
        if (!additive) setSelection(EMPTY_SET);
        setSelectedEdge(null);
        interaction.current = { kind: "marquee", pointerId: e.pointerId, x0: local.x, y0: local.y, base };
        started = true;
      }
    }
    if (started) rootRef.current!.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const local = toLocal(e);
    pointer.current = local;
    const it = interaction.current;
    if (!it || it.pointerId !== e.pointerId) return;

    switch (it.kind) {
      case "pan": {
        const dx = e.clientX - it.startX;
        const dy = e.clientY - it.startY;
        if (!it.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
        it.moved = true;
        setView({ ...it.view, x: it.view.x + dx, y: it.view.y + dy });
        break;
      }
      case "nodes": {
        if (!it.moved && Math.hypot(e.clientX - it.startX, e.clientY - it.startY) < DRAG_SLOP) return;
        it.moved = true;
        const z = viewRef.current.zoom;
        const dx = (e.clientX - it.startX) / z;
        const dy = (e.clientY - it.startY) / z;
        // Ctrl snaps to the grid.
        const snap = (v: number): number => (e.ctrlKey ? Math.round(v / GRID) * GRID : Math.round(v));
        const pos = new Map<string, { x: number; y: number }>();
        for (const [id, p] of it.base) pos.set(id, { x: snap(p.x + dx), y: snap(p.y + dy) });
        doc.preview(setNodePositions(doc.graph, pos));
        break;
      }
      case "frame": {
        const z = viewRef.current.zoom;
        const dx = Math.round((e.clientX - it.startX) / z);
        const dy = Math.round((e.clientY - it.startY) / z);
        const pos = new Map<string, { x: number; y: number }>();
        for (const [id, p] of it.nodeBase) pos.set(id, { x: p.x + dx, y: p.y + dy });
        doc.preview(
          updateFrame(setNodePositions(doc.graph, pos), it.frameId, {
            x: it.base.x + dx,
            y: it.base.y + dy,
          }),
        );
        break;
      }
      case "frame-resize": {
        const z = viewRef.current.zoom;
        doc.preview(
          updateFrame(doc.graph, it.frameId, {
            width: Math.max(FRAME_MIN.width, Math.round(it.base.width + (e.clientX - it.startX) / z)),
            height: Math.max(FRAME_MIN.height, Math.round(it.base.height + (e.clientY - it.startY) / z)),
          }),
        );
        break;
      }
      case "marquee": {
        setMarquee({ x0: it.x0, y0: it.y0, x1: local.x, y1: local.y });
        const a = toGraph(Math.min(it.x0, local.x), Math.min(it.y0, local.y));
        const b = toGraph(Math.max(it.x0, local.x), Math.max(it.y0, local.y));
        const sel = new Set(it.base);
        for (const n of doc.graph.nodes) {
          const def = nodeRegistry.get(n.type);
          if (!def) continue;
          const l = nodeLayout(n, def, doc.graph);
          if (n.x < b.x && n.x + l.width > a.x && n.y < b.y && n.y + l.height > a.y) sel.add(n.id);
        }
        setSelection(sel);
        break;
      }
      case "link": {
        const g = toGraph(local.x, local.y);
        const target = findLinkTarget(e.clientX, e.clientY, it);
        setDraft((d) => (d ? { ...d, x: g.x, y: g.y, target } : d));
        break;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const it = interaction.current;
    if (!it || it.pointerId !== e.pointerId) return;
    interaction.current = null;
    const local = toLocal(e);

    switch (it.kind) {
      case "pan":
        // A right-click without dragging opens the context menu.
        if (it.button === 2 && !it.moved) openContextMenu(local, it.target ?? {});
        break;
      case "nodes": {
        // Dropping a node with its centre in a frame makes it a member;
        // dropping it outside every frame takes it out.
        if (it.moved && doc.graph.frames?.length) {
          const dragged = new Set(it.base.keys());
          const byFrame = new Map<string | null, Set<string>>();
          for (const n of doc.graph.nodes) {
            if (!dragged.has(n.id)) continue;
            const target = frameAt(n, dragged);
            let group = byFrame.get(target);
            if (!group) byFrame.set(target, (group = new Set()));
            group.add(n.id);
          }
          let g = doc.graph;
          for (const [frameId, ids] of byFrame) g = setFrameMembership(g, ids, frameId);
          doc.preview(g);
        }
        doc.endGesture();
        break;
      }
      case "frame":
      case "frame-resize":
        doc.endGesture();
        break;
      case "marquee":
        setMarquee(null);
        break;
      case "link": {
        setDraft(null);
        const target = findLinkTarget(e.clientX, e.clientY, it);
        if (target?.ok) {
          const [from, to] =
            it.anchorSide === "out" ? [it.anchor, target.ref] : [target.ref, it.anchor];
          const r = connect(doc.graph, from, to);
          if (r.ok) {
            if (it.detached) doc.preview(r.graph);
            else doc.commit(r.graph);
          }
        }
        if (it.detached) {
          // Dropping a picked-up wire on empty space just removes it.
          doc.endGesture();
        } else if (!target) {
          openMenu(local, it);
        }
        break;
      }
    }
  };

  // ── Keyboard ────────────────────────────────────────────────────────────────

  /**
   * Shortcuts are scoped to the editor while it has focus: handled keys and
   * every unmodified key stop here so tool shortcuts don't fire while you
   * work on the graph. Unhandled Ctrl/Cmd combos (save, open, …) still reach
   * the app.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if ((e.target as Element).closest("input, textarea, select")) {
      e.stopPropagation();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    let handled = true;

    if (key === "escape") {
      if (interaction.current) cancelInteraction();
      else if (menu) setMenu(null);
      else if (contextMenu) setContextMenu(null);
      else if (selectionRef.current.size > 0 || selectedEdge || selectedFrame) {
        setSelection(EMPTY_SET);
        setSelectedEdge(null);
        setSelectedFrame(null);
      } else onExitBody?.();
    } else if (interaction.current) {
      // Swallow everything mid-drag (Ctrl+Z would otherwise reach the app).
    } else if (!mod && (key === "delete" || key === "backspace" || key === "x")) {
      deleteSelection();
    } else if (mod && key === "z") {
      if (e.shiftKey) doc.redo();
      else doc.undo();
    } else if (mod && key === "y") {
      doc.redo();
    } else if (mod && key === "g") {
      frameSelection();
    } else if (e.altKey && key === "g") {
      removeFromFrameCommand();
    } else if (mod && key === "a") {
      setSelection(new Set(doc.graph.nodes.map((n) => n.id)));
    } else if (mod && key === "c") {
      copyCommand();
    } else if (mod && key === "x") {
      cutCommand();
    } else if (mod && key === "v") {
      const g = toGraph(pointer.current.x, pointer.current.y);
      pasteCommand(g.x, g.y);
    } else if (mod && key === "d") {
      duplicateCommand();
    } else if (!mod && key === "f") {
      frameNodes(selectionRef.current);
    } else if (!mod && key === "home") {
      frameNodes(EMPTY_SET);
    } else if (!mod && (key === "tab" || (key === "a" && e.shiftKey))) {
      openMenu(pointer.current);
    } else if (!mod && key === " ") {
      spaceHeld.current = true;
    } else {
      handled = false;
    }

    if (handled) e.preventDefault();
    if (handled || !mod) e.stopPropagation();
  };

  const onKeyUp = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === " ") spaceHeld.current = false;
  };

  // ── Context menu ────────────────────────────────────────────────────────────

  const contextMenuItems = (at: ContextMenuState): ContextMenuItem[] => {
    const frame = selectedFrame ? graph.frames?.find((f) => f.id === selectedFrame) : undefined;
    const copyable = selection.size > 0 || (frame?.nodeIds.length ?? 0) > 0;
    const single = selection.size === 1 ? graph.nodes.find((n) => selection.has(n.id)) : undefined;
    const singleDef = single && nodeRegistry.get(single.type);
    const inFrame = [...selection].some((id) => graph.frames?.some((f) => f.nodeIds.includes(id)));
    const items: ContextMenuItem[] = [
      {
        label: "Add Node…",
        shortcut: "Shift+A",
        action: () => openMenu({ x: at.left, y: at.top }),
      },
    ];
    if (single?.body && singleDef && onOpenBody) {
      items.push({
        label: `Open ${nodeTitle(singleDef, single, graph)}`,
        shortcut: "Double-click",
        action: () => onOpenBody(single.id),
      });
    }
    items.push(
      "separator",
      { label: "Cut", shortcut: "Ctrl+X", disabled: !copyable, action: cutCommand },
      { label: "Copy", shortcut: "Ctrl+C", disabled: !copyable, action: copyCommand },
      {
        label: "Paste",
        shortcut: "Ctrl+V",
        disabled: !clipboard,
        action: () => pasteCommand(at.gx, at.gy),
      },
      { label: "Duplicate", shortcut: "Ctrl+D", disabled: !copyable, action: duplicateCommand },
      {
        label: "Delete",
        shortcut: "Delete",
        disabled: selection.size === 0 && !selectedEdge && !frame,
        action: deleteSelection,
      },
      "separator",
      {
        label: "Frame Selected Nodes",
        shortcut: "Ctrl+G",
        disabled: selection.size === 0,
        action: frameSelection,
      },
      {
        label: "Remove from Frame",
        shortcut: "Alt+G",
        disabled: !inFrame,
        action: removeFromFrameCommand,
      },
      {
        label: "Select Frame Nodes",
        disabled: !frame || frame.nodeIds.length === 0,
        action: () => {
          if (!frame) return;
          setSelectedFrame(null);
          setSelection(new Set(frame.nodeIds));
        },
      },
      {
        label: "Edit Frame Comment",
        shortcut: "Double-click",
        disabled: !frame,
        action: () => frame && setEditingFrame(frame.id),
      },
      {
        label: "Ungroup (Remove Frame)",
        disabled: !frame,
        action: () => frame && ungroupCommand(frame.id),
      },
    );
    return items;
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  const wires: React.ReactNode[] = [];
  for (const e of graph.edges) {
    const a = nodeById.get(e.from.node);
    const b = nodeById.get(e.to.node);
    const defA = a && nodeRegistry.get(a.type);
    const defB = b && nodeRegistry.get(b.type);
    if (!a || !b || !defA || !defB) continue;
    const p1 = socketPosition(a, nodeLayout(a, defA, graph), "out", e.from.port);
    const p2 = socketPosition(b, nodeLayout(b, defB, graph), "in", e.to.port);
    const type = findPort(graph, a, "out", e.from.port)?.type ?? "any";
    const d = wirePath(p1.x, p1.y, p2.x, p2.y);
    const cls = [
      styles.wire,
      type === "exec" ? styles.wireExec : "",
      selectedEdge === e.id ? styles.wireSelected : "",
      selection.has(a.id) || selection.has(b.id) ? styles.wireActive : "",
    ].join(" ");
    wires.push(
      <g key={e.id}>
        <path className={styles.wireHit} d={d} data-edge-id={e.id} />
        <path className={cls} d={d} stroke={PORT_COLORS[type]} />
      </g>,
    );
  }

  let draftWire: React.ReactNode = null;
  if (draft) {
    const anchorNode = nodeById.get(draft.anchor.node);
    const anchorDef = anchorNode && nodeRegistry.get(anchorNode.type);
    if (anchorNode && anchorDef) {
      const p = socketPosition(anchorNode, nodeLayout(anchorNode, anchorDef, graph), draft.anchorSide, draft.anchor.port);
      let free = { x: draft.x, y: draft.y };
      const t = draft.target;
      const tNode = t?.ok ? nodeById.get(t.ref.node) : undefined;
      const tDef = tNode && nodeRegistry.get(tNode.type);
      if (t && tNode && tDef) {
        free = socketPosition(tNode, nodeLayout(tNode, tDef, graph), draft.anchorSide === "out" ? "in" : "out", t.ref.port);
      }
      const d =
        draft.anchorSide === "out"
          ? wirePath(p.x, p.y, free.x, free.y)
          : wirePath(free.x, free.y, p.x, p.y);
      draftWire = (
        <path
          className={`${styles.wire} ${styles.wireDraft}${t && !t.ok ? ` ${styles.wireInvalid}` : ""}`}
          d={d}
          stroke={PORT_COLORS[draft.type]}
        />
      );
    }
  }

  const minor = GRID * view.zoom;
  const major = minor * 5;
  const minorSize = minor < 8 ? major : minor;

  return (
    <div
      ref={rootRef}
      className={styles.canvas}
      tabIndex={0}
      style={{
        backgroundSize: `${major}px ${major}px, ${major}px ${major}px, ${minorSize}px ${minorSize}px, ${minorSize}px ${minorSize}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancelInteraction}
      onLostPointerCapture={(e) => {
        if (interaction.current?.pointerId === e.pointerId) cancelInteraction();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={() => {
        spaceHeld.current = false;
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className={styles.world}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
      >
        {(graph.frames ?? []).map((f) => (
          <GraphFrameView
            key={f.id}
            frame={f}
            rect={frameRect(f)}
            selected={selectedFrame === f.id}
            editing={editingFrame === f.id}
            onCommitText={onFrameText}
            onCancelEdit={onFrameCancel}
            onColor={onFrameColor}
            onHeaderHeight={onHeaderHeight}
          />
        ))}
        <svg className={styles.wires}>
          {wires}
          {draftWire}
        </svg>
        {graph.nodes.map((n: GraphNode) => {
          const def = nodeRegistry.get(n.type);
          if (!def) return null;
          return (
            <GraphNodeView
              key={n.id}
              node={n}
              def={def}
              layout={nodeLayout(n, def, graph)}
              title={nodeTitle(def, n, graph)}
              selected={selection.has(n.id)}
              error={errorNodeId === n.id}
              connectedInputs={connectedInputs.get(n.id) ?? ""}
              onParamChange={onParamChange}
              onSocketsChange={onSocketsChange}
              onOpenBody={onOpenBodyStable}
            />
          );
        })}
      </div>

      {marquee && (
        <div
          className={styles.marquee}
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}

      {draft?.target && !draft.target.ok && draft.target.reason && (
        <div
          className={styles.linkHint}
          style={{ left: pointer.current.x + 14, top: pointer.current.y + 14 }}
        >
          {draft.target.reason}
        </div>
      )}

      {contextMenu && (
        <NodeContextMenu
          x={contextMenu.clientX}
          y={contextMenu.clientY}
          items={contextMenuItems(contextMenu)}
          onClose={() => {
            setContextMenu(null);
            rootRef.current?.focus({ preventScroll: true });
          }}
        />
      )}

      {menu && (
        <AddNodeMenu
          x={menu.left}
          y={menu.top}
          defs={menuDefs}
          subtitle={menu.link ? `Connect to ${menu.link.type}` : undefined}
          onPick={addFromMenu}
          onClose={() => {
            setMenu(null);
            rootRef.current?.focus({ preventScroll: true });
          }}
        />
      )}

      <div className={styles.zoomBadge}>{Math.round(view.zoom * 100)}%</div>
    </div>
  );
}
