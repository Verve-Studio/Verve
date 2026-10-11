/**
 * Pure graph mutations. Every function returns a new `NodeGraph` (or the
 * same object when nothing changed) so the document store can keep old
 * versions for undo and React can diff by identity.
 *
 * Port lookups take the graph containing the node: boundary nodes of a
 * subgraph body derive their ports from that graph's interface.
 */
import {
  isKernelValue,
  type GraphDomain,
  type GraphEdge,
  type GraphArgument,
  type GraphFrame,
  type GraphInfo,
  type GraphNode,
  type NodeGraph,
  type ParamValue,
  type PortRef,
  type SocketDecl,
} from "./graphTypes";
import type { INode, NodePorts, ParamSpec, PortDef } from "./INode";
import { nodeRegistry } from "./nodeRegistry";
import { canConnectTypes, isSingleLink } from "./portTypes";
import { SUBGRAPH_INPUT, SUBGRAPH_OUTPUT, newSocketId } from "./subgraphs";

/** The parts of a node that its ports can depend on. */
export type NodeLike = Pick<GraphNode, "params" | "body">;

/**
 * A new node of type `def` with default params. Subgraph nodes get a body
 * holding the default interface sockets and the two boundary nodes.
 */
export function createNode(
  def: INode,
  x: number,
  y: number,
  domain: GraphDomain = def.domains[0],
): GraphNode {
  const params: Record<string, ParamValue> = {};
  for (const p of def.params ?? []) params[p.id] = p.spec.default;
  let body: NodeGraph | undefined;
  if (def.subgraph) {
    const boundary = (type: string, bx: number): GraphNode => ({
      id: crypto.randomUUID(),
      type,
      x: bx,
      y: 0,
      params: {},
    });
    body = {
      id: crypto.randomUUID(),
      name: def.label,
      domain,
      nodes: [boundary(SUBGRAPH_INPUT, 0), boundary(SUBGRAPH_OUTPUT, 420)],
      edges: [],
      subgraph: {
        kind: def.type,
        sockets: def.subgraph.defaultSockets.map((s) => ({ ...s, id: newSocketId() })),
      },
    };
  }
  for (const p of nodePorts(def, { params, body }).inputs) {
    if (p.value) params[p.id] = p.value.default;
  }
  return { id: crypto.randomUUID(), type: def.type, x, y, params, ...(body && { body }) };
}

const withDefaultsCache = new WeakMap<object, Readonly<Record<string, ParamValue>>>();

/** Params with the definition's parameter defaults filled in. */
function withParamDefaults(
  def: INode,
  params: Readonly<Record<string, ParamValue>>,
): Readonly<Record<string, ParamValue>> {
  if (!def.params) return params;
  let full = withDefaultsCache.get(params);
  if (!full) {
    const out: Record<string, ParamValue> = {};
    for (const p of def.params) out[p.id] = p.spec.default;
    full = Object.assign(out, params);
    withDefaultsCache.set(params, full);
  }
  return full;
}

const NO_NODE: NodeLike = { params: {} };

/** The node's ports for its params / body, in `graph` (see `INode.ports`). */
export function nodePorts(
  def: INode,
  node: NodeLike = NO_NODE,
  graph: NodeGraph | null = null,
): NodePorts {
  return def.ports ? def.ports(withParamDefaults(def, node.params), { node, graph }) : def;
}

/** A node's stored value for a parameter or inline input, falling back
 *  to the definition's default. */
export function paramValue(
  def: INode,
  node: NodeLike,
  id: string,
  graph: NodeGraph | null = null,
): ParamValue {
  return (
    node.params[id] ??
    def.params?.find((p) => p.id === id)?.spec.default ??
    nodePorts(def, node, graph).inputs.find((p) => p.id === id)?.value?.default ??
    0
  );
}

export function findPort(
  graph: NodeGraph,
  node: GraphNode,
  side: "in" | "out",
  portId: string,
): PortDef | undefined {
  const def = nodeRegistry.get(node.type);
  if (!def) return undefined;
  const ports = nodePorts(def, node, graph);
  return (side === "in" ? ports.inputs : ports.outputs).find((p) => p.id === portId);
}

/** Header text for a node (boundary nodes are titled by their subgraph). */
export function nodeTitle(def: INode, node: GraphNode, graph: NodeGraph): string {
  return def.title?.({ node, graph }) ?? def.label;
}

/** Does a stored value have the shape `spec` edits? */
function valueFits(v: ParamValue, spec: ParamSpec): boolean {
  switch (spec.kind) {
    case "float":
    case "int":
      return typeof v === "number";
    case "bool":
      return typeof v === "boolean";
    case "enum":
    case "string":
      return typeof v === "string";
    case "color":
      return Array.isArray(v) && v.length === 4;
    case "vec2":
      return Array.isArray(v) && v.length === 2;
    case "kernel":
      return isKernelValue(v);
  }
}

/**
 * After nodes' ports changed (params or interface edits): drop inline values
 * that no longer fit their port and links whose ports are gone or no longer
 * type-compatible.
 */
function pruneAfterPortChange(graph: NodeGraph, nodeIds: ReadonlySet<string>): NodeGraph {
  const nodes = graph.nodes.map((n) => {
    const def = nodeIds.has(n.id) ? nodeRegistry.get(n.type) : undefined;
    if (!def) return n;
    let params = n.params;
    for (const p of nodePorts(def, n, graph).inputs) {
      if (p.value && params[p.id] !== undefined && !valueFits(params[p.id], p.value)) {
        if (params === n.params) params = { ...params };
        delete (params as Record<string, ParamValue>)[p.id];
      }
    }
    return params === n.params ? n : { ...n, params };
  });
  const next = { ...graph, nodes };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = graph.edges.filter((e) => {
    if (!nodeIds.has(e.from.node) && !nodeIds.has(e.to.node)) return true;
    const a = byId.get(e.from.node);
    const b = byId.get(e.to.node);
    const out = a && findPort(next, a, "out", e.from.port);
    const inp = b && findPort(next, b, "in", e.to.port);
    return !!out && !!inp && canConnectTypes(out.type, inp.type);
  });
  return { ...next, edges };
}

export function addNodes(graph: NodeGraph, nodes: readonly GraphNode[]): NodeGraph {
  if (nodes.length === 0) return graph;
  return { ...graph, nodes: [...graph.nodes, ...nodes] };
}

/** Remove nodes, their links and their frame memberships. Boundary nodes
 *  of a body are kept. */
export function removeNodes(graph: NodeGraph, requested: ReadonlySet<string>): NodeGraph {
  const ids = new Set(
    [...requested].filter((id) => {
      const n = graph.nodes.find((x) => x.id === id);
      return n && !nodeRegistry.get(n.type)?.boundary;
    }),
  );
  if (ids.size === 0) return graph;
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => !ids.has(n.id)),
    edges: graph.edges.filter((e) => !ids.has(e.from.node) && !ids.has(e.to.node)),
    ...(graph.frames && {
      frames: graph.frames.map((f) =>
        f.nodeIds.some((id) => ids.has(id))
          ? { ...f, nodeIds: f.nodeIds.filter((id) => !ids.has(id)) }
          : f,
      ),
    }),
  };
}

export function removeEdges(graph: NodeGraph, ids: ReadonlySet<string>): NodeGraph {
  if (ids.size === 0) return graph;
  return { ...graph, edges: graph.edges.filter((e) => !ids.has(e.id)) };
}

export function setNodePositions(
  graph: NodeGraph,
  positions: ReadonlyMap<string, { x: number; y: number }>,
): NodeGraph {
  if (positions.size === 0) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const p = positions.get(n.id);
      return p && (p.x !== n.x || p.y !== n.y) ? { ...n, x: p.x, y: p.y } : n;
    }),
  };
}

/**
 * Set a parameter / inline value. When the change reshapes the node's
 * ports (dynamic ports), inline values that no longer fit their port and
 * links that no longer fit are dropped.
 */
export function setParam(
  graph: NodeGraph,
  nodeId: string,
  key: string,
  value: ParamValue,
): NodeGraph {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const def = node && nodeRegistry.get(node.type);
  if (!node || !def) return graph;
  const before = nodePorts(def, node, graph);
  const updated: GraphNode = { ...node, params: { ...node.params, [key]: value } };
  const next = { ...graph, nodes: graph.nodes.map((n) => (n.id === nodeId ? updated : n)) };
  if (nodePorts(def, updated, next) === before) return next;
  return pruneAfterPortChange(next, new Set([nodeId]));
}

/**
 * Replace the interface sockets of subgraph node `ownerId` (add, remove,
 * rename, retype). Links and inline values that no longer fit are dropped
 * on both sides of the boundary.
 */
export function setSockets(
  graph: NodeGraph,
  ownerId: string,
  sockets: readonly SocketDecl[],
): NodeGraph {
  const owner = graph.nodes.find((n) => n.id === ownerId);
  const body = owner?.body;
  if (!owner || !body?.subgraph) return graph;
  let newBody: NodeGraph = { ...body, subgraph: { ...body.subgraph, sockets } };
  const boundaryIds = new Set(
    newBody.nodes.filter((n) => nodeRegistry.get(n.type)?.boundary).map((n) => n.id),
  );
  newBody = pruneAfterPortChange(newBody, boundaryIds);
  const next = {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === ownerId ? { ...n, body: newBody } : n)),
  };
  return pruneAfterPortChange(next, new Set([ownerId]));
}

/**
 * Replace the graph's effect arguments. The start node's argument sockets
 * follow them, so links and inline values that no longer fit are dropped.
 */
export function setArguments(graph: NodeGraph, args: readonly GraphArgument[]): NodeGraph {
  const next = { ...graph, arguments: args };
  const dynamic = new Set(
    next.nodes.filter((n) => nodeRegistry.get(n.type)?.ports).map((n) => n.id),
  );
  return pruneAfterPortChange(next, dynamic);
}

export function setGraphInfo(graph: NodeGraph, patch: Partial<GraphInfo>): NodeGraph {
  const info: GraphInfo = { name: "", author: "", description: "", version: "", ...graph.info, ...patch };
  return { ...graph, info };
}

// --- Comment frames ----------------------------------------------------------

export function addFrame(graph: NodeGraph, frame: GraphFrame): NodeGraph {
  return { ...graph, frames: [...(graph.frames ?? []), frame] };
}

export function updateFrame(
  graph: NodeGraph,
  id: string,
  patch: Partial<Omit<GraphFrame, "id">>,
): NodeGraph {
  return {
    ...graph,
    frames: (graph.frames ?? []).map((f) => (f.id === id ? { ...f, ...patch } : f)),
  };
}

/** Make `nodeIds` members of frame `frameId` (or of no frame when null),
 *  taking them out of any other frame. */
export function setFrameMembership(
  graph: NodeGraph,
  nodeIds: ReadonlySet<string>,
  frameId: string | null,
): NodeGraph {
  if (!graph.frames || nodeIds.size === 0) return graph;
  let changed = false;
  const frames = graph.frames.map((f) => {
    const kept = f.nodeIds.filter((id) => !nodeIds.has(id));
    const next = f.id === frameId ? [...kept, ...nodeIds] : kept;
    const same = next.length === f.nodeIds.length && next.every((id, i) => id === f.nodeIds[i]);
    if (same) return f;
    changed = true;
    return { ...f, nodeIds: next };
  });
  return changed ? { ...graph, frames } : graph;
}

/** Remove frames; the nodes inside them stay. */
export function removeFrames(graph: NodeGraph, ids: ReadonlySet<string>): NodeGraph {
  if (ids.size === 0 || !graph.frames) return graph;
  return { ...graph, frames: graph.frames.filter((f) => !ids.has(f.id)) };
}

// --- Paths into nested bodies ------------------------------------------------

/** The graph at `path` (owner node ids from the root), or null when a node
 *  on the path no longer exists. */
export function graphAt(root: NodeGraph, path: readonly string[]): NodeGraph | null {
  let g: NodeGraph | undefined = root;
  for (const id of path) {
    g = g?.nodes.find((n) => n.id === id)?.body;
    if (!g) return null;
  }
  return g ?? null;
}

/** Replace the graph at `path` with `fn(graph)`, rebuilding the owners. */
export function updateAt(
  root: NodeGraph,
  path: readonly string[],
  fn: (g: NodeGraph) => NodeGraph,
): NodeGraph {
  if (path.length === 0) return fn(root);
  const [head, ...rest] = path;
  const owner = root.nodes.find((n) => n.id === head);
  if (!owner?.body) return root;
  const body = updateAt(owner.body, rest, fn);
  if (body === owner.body) return root;
  return { ...root, nodes: root.nodes.map((n) => (n === owner ? { ...n, body } : n)) };
}

/** True when a path already leads from `start` to `target`, i.e. linking
 *  target → start would close a cycle. */
function reaches(graph: NodeGraph, start: string, target: string): boolean {
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = out.get(e.from.node);
    if (list) list.push(e.to.node);
    else out.set(e.from.node, [e.to.node]);
  }
  const stack = [start];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of out.get(id) ?? []) stack.push(next);
  }
  return false;
}

export type ConnectResult =
  | { ok: true; graph: NodeGraph }
  | { ok: false; reason: string };

/** Validate a link from output `from` to input `to`. */
export function checkConnection(
  graph: NodeGraph,
  from: PortRef,
  to: PortRef,
): string | null {
  if (from.node === to.node) return "Can't connect a node to itself";
  const fromNode = graph.nodes.find((n) => n.id === from.node);
  const toNode = graph.nodes.find((n) => n.id === to.node);
  if (!fromNode || !toNode) return "Node not found";
  const out = findPort(graph, fromNode, "out", from.port);
  const inp = findPort(graph, toNode, "in", to.port);
  if (!out || !inp) return "Port not found";
  if (!canConnectTypes(out.type, inp.type)) {
    return `Can't connect ${out.type} to ${inp.type}`;
  }
  if (reaches(graph, to.node, from.node)) return "That would create a cycle";
  return null;
}

/** Link output `from` to input `to`, replacing links that the ports'
 *  single-link rules no longer allow. */
export function connect(graph: NodeGraph, from: PortRef, to: PortRef): ConnectResult {
  const reason = checkConnection(graph, from, to);
  if (reason) return { ok: false, reason };
  const fromNode = graph.nodes.find((n) => n.id === from.node)!;
  const toNode = graph.nodes.find((n) => n.id === to.node)!;
  const outType = findPort(graph, fromNode, "out", from.port)!.type;
  const inType = findPort(graph, toNode, "in", to.port)!.type;
  const samePort = (a: PortRef, b: PortRef): boolean =>
    a.node === b.node && a.port === b.port;

  const edges = graph.edges.filter(
    (e) =>
      !(samePort(e.from, from) && samePort(e.to, to)) &&
      !(isSingleLink(inType, "in") && samePort(e.to, to)) &&
      !(isSingleLink(outType, "out") && samePort(e.from, from)),
  );
  edges.push({ id: crypto.randomUUID(), from, to });
  return { ok: true, graph: { ...graph, edges } };
}

/** First port on `def` that can link with a port of `type` on the other
 *  end. `side` is the side of `def` being searched; `node` is the node
 *  instance when it exists (subgraph nodes' ports come from their body). */
export function firstCompatiblePort(
  def: INode,
  side: "in" | "out",
  type: PortDef["type"],
  node?: NodeLike,
): PortDef | undefined {
  const all = nodePorts(def, node);
  const ports = side === "in" ? all.inputs : all.outputs;
  return ports.find((p) =>
    side === "in" ? canConnectTypes(type, p.type) : canConnectTypes(p.type, type),
  );
}

// ─── Copy / paste ─────────────────────────────────────────────────────────────

export interface GraphFragment {
  readonly nodes: readonly GraphNode[];
  /** Only edges between nodes inside the fragment. */
  readonly edges: readonly GraphEdge[];
  /** Frames whose members are all inside the fragment. */
  readonly frames: readonly GraphFrame[];
}

/**
 * The selected nodes (minus boundary nodes), the links between them, and
 * the frames they fill completely. Selecting a frame selects its members.
 */
export function extractFragment(
  graph: NodeGraph,
  selected: ReadonlySet<string>,
  selectedFrames: ReadonlySet<string> = new Set(),
): GraphFragment {
  const wanted = new Set(selected);
  for (const f of graph.frames ?? []) {
    if (selectedFrames.has(f.id)) for (const id of f.nodeIds) wanted.add(id);
  }
  const nodes = graph.nodes.filter(
    (n) => wanted.has(n.id) && !nodeRegistry.get(n.type)?.boundary,
  );
  const ids = new Set(nodes.map((n) => n.id));
  return {
    nodes,
    edges: graph.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node)),
    frames: (graph.frames ?? []).filter(
      (f) => selectedFrames.has(f.id) || (f.nodeIds.length > 0 && f.nodeIds.every((id) => ids.has(id))),
    ),
  };
}

/** Insert a copy of `frag` with fresh ids, shifted by (dx, dy). Nodes whose
 *  definition is `unique` and already present are skipped. */
export function pasteFragment(
  graph: NodeGraph,
  frag: GraphFragment,
  dx: number,
  dy: number,
): { graph: NodeGraph; newIds: Set<string>; newFrameIds: Set<string> } {
  const present = new Set(graph.nodes.map((n) => n.type));
  const idMap = new Map<string, string>();
  const nodes: GraphNode[] = [];
  for (const n of frag.nodes) {
    const def = nodeRegistry.get(n.type);
    if (!def || def.boundary || !def.domains.includes(graph.domain)) continue;
    if (def.unique && present.has(n.type)) continue;
    const id = crypto.randomUUID();
    idMap.set(n.id, id);
    nodes.push({ ...n, id, x: n.x + dx, y: n.y + dy });
  }
  const edges: GraphEdge[] = [];
  for (const e of frag.edges) {
    const from = idMap.get(e.from.node);
    const to = idMap.get(e.to.node);
    if (from && to) {
      edges.push({
        id: crypto.randomUUID(),
        from: { node: from, port: e.from.port },
        to: { node: to, port: e.to.port },
      });
    }
  }
  // Copied frames come along, holding the copies of their members.
  const newFrameIds = new Set<string>();
  const frames = [...(graph.frames ?? [])];
  for (const f of frag.frames) {
    const id = crypto.randomUUID();
    newFrameIds.add(id);
    frames.push({
      ...f,
      id,
      x: f.x + dx,
      y: f.y + dy,
      nodeIds: f.nodeIds.flatMap((n) => idMap.get(n) ?? []),
    });
  }
  return {
    graph: {
      ...graph,
      nodes: [...graph.nodes, ...nodes],
      edges: [...graph.edges, ...edges],
      ...(frames.length > 0 && { frames }),
    },
    newIds: new Set(idMap.values()),
    newFrameIds,
  };
}
