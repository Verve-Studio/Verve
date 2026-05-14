/**
 * Pen — a vector-path drawing tool. Click to add corner nodes, click-drag to
 * add smooth nodes (drag length = handle length). While a path layer is the
 * active layer, the tool flips to edit mode: drag a node to move it, drag a
 * handle to reshape, alt-click a node to toggle corner/smooth, alt-drag a
 * handle to break the symmetric lock, cmd-click on a segment to insert a node,
 * Delete/Backspace to remove the selected node. Enter commits the in-progress
 * path; Escape commits open / deselects.
 *
 * The data model lives in `PathLayerState`; rasterisation happens in
 * `src/ux/main/Canvas/pathRasterizer.ts`. This file owns only the tool runtime
 * + options panel.
 */
import React, { useCallback } from "react";
import type {
  PathLayerState,
  PathNode,
  PathNodeKind,
  RGBAColor,
} from "@/types";
import { useAppContext } from "@/core/store/AppContext";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import { ColorSwatch } from "@/ux/widgets/ColorSwatch/ColorSwatch";
import swatchStyles from "@/ux/widgets/ColorSwatch/ColorSwatch.module.scss";
import {
  buildPathPath2D,
  closestPointOnCubic,
  splitCubic,
} from "@/ux/main/Canvas/pathRasterizer";
import { rgbaToStr, buildCanvasGradient } from "@/ux/main/Canvas/shapeRasterizer";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import penIconSvg from "./pen.svg?raw";

// ─── Module-level defaults for new paths and new vertices ─────────────────────

export const penOptions = {
  /** Node type assigned when click (no drag) places a vertex. Smooth is
   *  the default so newly-drawn paths get a continuous curve through every
   *  vertex with handles already in place — pick "corner" in the options
   *  bar for polygon-style sharp anchors. Click-drag while placing a
   *  vertex overrides the auto handles with a manual drag vector. */
  defaultNodeKind: "smooth" as PathNodeKind,
  useStroke: true,
  useFill: false,
  strokeWidth: 2,
  strokeJoin: "round" as "miter" | "round" | "bevel",
  strokeCap: "round" as "butt" | "round" | "square",
  /** Empty array = solid. Stored as a CSV string in the UI for ease. */
  strokeDash: [] as number[],
  miterLimit: 10,
  fillRule: "nonzero" as "nonzero" | "evenodd",
  antiAlias: true,
  /** null = defer to primary colour at draw time. */
  strokeColor: null as RGBAColor | null,
  /** null = defer to secondary colour at draw time. */
  fillColor: null as RGBAColor | null,
};

// ─── Color helpers ────────────────────────────────────────────────────────────

function floatToBytes(c: RGBAColor): RGBAColor {
  return {
    r: Math.round(Math.min(c.r, 1) * 255),
    g: Math.round(Math.min(c.g, 1) * 255),
    b: Math.round(Math.min(c.b, 1) * 255),
    a: Math.round(c.a * 255),
  };
}

function rgbaToHex(c: RGBAColor): string {
  return (
    "#" +
    [c.r, c.g, c.b]
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("")
  );
}

function hexToRgba(hex: string, a = 255): RGBAColor {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
    a,
  };
}

// ─── Default-handle synthesis on click-create ─────────────────────────────────

/** Reasonable default handle length when promoting a click-only node to
 *  smooth. Kept short enough that the user can immediately see and drag
 *  the handles without them dominating the canvas. */
const DEFAULT_HANDLE_LEN = 40;

/** Build a new draft node at (x, y). Corner nodes get zero-length handles
 *  (an actual sharp corner); smooth nodes get mirrored handles tangent to
 *  the segment from the previous draft node so they're visible and the
 *  path approaches the new anchor with a curve. */
function makeNewDraftNode(
  x: number,
  y: number,
  existing: readonly PathNode[],
  kind: PathNodeKind,
): PathNode {
  if (kind === "corner" || existing.length === 0) {
    return { x, y, inX: 0, inY: 0, outX: 0, outY: 0, kind };
  }
  const prev = existing[existing.length - 1];
  const dx = x - prev.x;
  const dy = y - prev.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) {
    return { x, y, inX: 0, inY: 0, outX: 0, outY: 0, kind };
  }
  const handleLen = Math.min(DEFAULT_HANDLE_LEN, len / 3);
  const ux = dx / len;
  const uy = dy / len;
  return {
    x,
    y,
    inX: -ux * handleLen,
    inY: -uy * handleLen,
    outX: ux * handleLen,
    outY: uy * handleLen,
    kind,
  };
}

/**
 * Recompute every smooth-kind node's handles from its neighbours using the
 * Catmull-Rom-to-Bezier formula. The result is a C1-continuous curve that
 * passes through every anchor with sensible default tangents — exactly what
 * you want as you click vertices into place without bothering with handles.
 *
 * - `closed`: when true neighbours wrap; the closing segment is smooth.
 * - `pinned`: indices whose handles were manually set (e.g. by click-drag
 *   during placement). Those nodes are left untouched.
 * - Corner-kind and asymmetric-kind nodes are also left untouched — the
 *   user has explicitly chosen those configurations.
 */
function autoSmoothHandles(
  nodes: PathNode[],
  closed: boolean,
  pinned: ReadonlySet<number>,
): void {
  const n = nodes.length;
  if (n < 2) return;
  const k = 1 / 6;
  for (let i = 0; i < n; i++) {
    if (pinned.has(i)) continue;
    const node = nodes[i];
    if (node.kind !== "smooth") continue;
    if (closed) {
      const prev = nodes[(i - 1 + n) % n];
      const next = nodes[(i + 1) % n];
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      nodes[i] = {
        ...node,
        outX: dx * k,
        outY: dy * k,
        inX: -dx * k,
        inY: -dy * k,
      };
    } else {
      const hasPrev = i > 0;
      const hasNext = i < n - 1;
      if (hasPrev && hasNext) {
        const prev = nodes[i - 1];
        const next = nodes[i + 1];
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        nodes[i] = {
          ...node,
          outX: dx * k,
          outY: dy * k,
          inX: -dx * k,
          inY: -dy * k,
        };
      } else if (hasNext) {
        // First-node endpoint: one-sided tangent toward next anchor.
        const next = nodes[i + 1];
        nodes[i] = {
          ...node,
          outX: (next.x - node.x) / 3,
          outY: (next.y - node.y) / 3,
          inX: 0,
          inY: 0,
        };
      } else if (hasPrev) {
        // Last-node endpoint: one-sided incoming tangent from prev anchor.
        const prev = nodes[i - 1];
        nodes[i] = {
          ...node,
          outX: 0,
          outY: 0,
          inX: (prev.x - node.x) / 3,
          inY: (prev.y - node.y) / 3,
        };
      }
    }
  }
}

// ─── Bounds + hit-test helpers ────────────────────────────────────────────────

const HANDLE_HIT_PX = 6; // screen-space hit radius for handle endpoints
const NODE_HIT_PX = 7; // screen-space hit radius for anchor points
const SEGMENT_HIT_PX = 12; // screen-space hit radius for segment insertion

interface NodeHit {
  kind: "node" | "handle-in" | "handle-out";
  nodeIdx: number;
}

interface SegmentHit {
  kind: "segment";
  segIdx: number;
  t: number;
  x: number;
  y: number;
}

/** Hit-test a pointer position against (a) all node anchor points,
 *  (b) the in/out handles of the currently-selected node, and
 *  (c) the path segments themselves. Returns the first matching target by
 *  z-order (handles > nodes > segments). */
function hitTest(
  nodes: readonly PathNode[],
  closed: boolean,
  selectedIdx: number | null,
  px: number,
  py: number,
  zoom: number,
): NodeHit | SegmentHit | null {
  const handleR = HANDLE_HIT_PX / zoom;
  const nodeR = NODE_HIT_PX / zoom;
  const segR = SEGMENT_HIT_PX / zoom;

  // A zero-length handle isn't drawn and must not be hit-testable — its
  // hit-circle would otherwise sit exactly on top of the anchor and steal
  // every click meant for the vertex itself. Compare offsets in screen
  // space so the threshold doesn't change with zoom.
  const minHandleOffsetCanvas = HANDLE_HIT_PX / zoom;
  const handleExists = (ox: number, oy: number): boolean =>
    ox * ox + oy * oy > minHandleOffsetCanvas * minHandleOffsetCanvas;

  // Anchors first — the vertex always wins over a coincident invisible
  // handle. (Visible handles still win because their centre is offset
  // beyond the anchor's hit radius, so they're checked after.)
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const dx = px - n.x;
    const dy = py - n.y;
    if (dx * dx + dy * dy <= nodeR * nodeR)
      return { kind: "node", nodeIdx: i };
  }

  // Handles of the selected node (drawn only for the selection — match that).
  if (selectedIdx !== null && selectedIdx >= 0 && selectedIdx < nodes.length) {
    const n = nodes[selectedIdx];
    const hasIn = (selectedIdx > 0 || closed) && handleExists(n.inX, n.inY);
    const hasOut =
      (selectedIdx < nodes.length - 1 || closed) && handleExists(n.outX, n.outY);
    if (hasOut) {
      const dx = px - (n.x + n.outX);
      const dy = py - (n.y + n.outY);
      if (dx * dx + dy * dy <= handleR * handleR)
        return { kind: "handle-out", nodeIdx: selectedIdx };
    }
    if (hasIn) {
      const dx = px - (n.x + n.inX);
      const dy = py - (n.y + n.inY);
      if (dx * dx + dy * dy <= handleR * handleR)
        return { kind: "handle-in", nodeIdx: selectedIdx };
    }
  }

  // Segments.
  const segCount = closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % nodes.length];
    const c = closestPointOnCubic(
      px, py,
      a.x, a.y,
      a.x + a.outX, a.y + a.outY,
      b.x + b.inX, b.y + b.inY,
      b.x, b.y,
    );
    if (c.dist <= segR) {
      return { kind: "segment", segIdx: i, t: c.t, x: c.x, y: c.y };
    }
  }

  return null;
}

// ─── Symmetry enforcement when dragging a handle of a smooth/asymmetric node ─

function applyHandleDrag(
  n: PathNode,
  which: "in" | "out",
  newOffX: number,
  newOffY: number,
  breakSymmetry: boolean,
): PathNode {
  if (breakSymmetry || n.kind === "corner") {
    // Independent — the opposite handle is left alone.
    if (which === "in") return { ...n, inX: newOffX, inY: newOffY };
    return { ...n, outX: newOffX, outY: newOffY };
  }
  if (n.kind === "smooth") {
    // Mirror — opposite handle is the negated offset.
    if (which === "in") {
      return { ...n, inX: newOffX, inY: newOffY, outX: -newOffX, outY: -newOffY };
    }
    return { ...n, outX: newOffX, outY: newOffY, inX: -newOffX, inY: -newOffY };
  }
  // asymmetric — tangent-locked but lengths independent. Maintain the
  // opposite handle's length along the new direction.
  const len = Math.hypot(newOffX, newOffY);
  if (len === 0) {
    // Degenerate drag — leave the other handle alone.
    if (which === "in") return { ...n, inX: newOffX, inY: newOffY };
    return { ...n, outX: newOffX, outY: newOffY };
  }
  const dirX = newOffX / len;
  const dirY = newOffY / len;
  if (which === "in") {
    const otherLen = Math.hypot(n.outX, n.outY);
    return {
      ...n,
      inX: newOffX,
      inY: newOffY,
      outX: -dirX * otherLen,
      outY: -dirY * otherLen,
    };
  }
  const otherLen = Math.hypot(n.inX, n.inY);
  return {
    ...n,
    outX: newOffX,
    outY: newOffY,
    inX: -dirX * otherLen,
    inY: -dirY * otherLen,
  };
}

// ─── Overlay drawing ──────────────────────────────────────────────────────────

function clearOverlay(ctx2d: CanvasRenderingContext2D): void {
  ctx2d.clearRect(0, 0, ctx2d.canvas.width, ctx2d.canvas.height);
}

/** Stroke + fill the path on the overlay using its current appearance — used
 *  while dragging so the user sees the live shape without forcing a GPU
 *  re-rasterise per move event. */
function drawPathAppearance(
  ctx2d: CanvasRenderingContext2D,
  ls: PathLayerState,
): void {
  if (ls.nodes.length < 2) return;
  ctx2d.save();
  buildPathPath2D(ctx2d, ls.nodes, ls.closed);
  if (ls.closed) {
    if (ls.fillGradient && ls.fillGradient.stops.length >= 1) {
      ctx2d.fillStyle = buildCanvasGradient(ctx2d, ls.fillGradient);
      ctx2d.fill(ls.fillRule);
    } else if (ls.fillColor) {
      ctx2d.fillStyle = rgbaToStr(ls.fillColor);
      ctx2d.fill(ls.fillRule);
    }
  }
  if (ls.strokeColor && ls.strokeWidth > 0) {
    ctx2d.strokeStyle = rgbaToStr(ls.strokeColor);
    ctx2d.lineWidth = ls.strokeWidth;
    ctx2d.lineJoin = ls.strokeJoin;
    ctx2d.lineCap = ls.strokeCap;
    ctx2d.miterLimit = Math.max(1, ls.miterLimit);
    if (ls.strokeDash.length > 0) ctx2d.setLineDash(ls.strokeDash);
    else ctx2d.setLineDash([]);
    ctx2d.stroke();
  }
  ctx2d.restore();
}

/** Anchor squares + handle lines. `zoom` is used so the handles are a
 *  constant screen size regardless of canvas zoom. */
function drawHandles(
  ctx2d: CanvasRenderingContext2D,
  nodes: readonly PathNode[],
  closed: boolean,
  zoom: number,
  selectedIdx: number | null,
): void {
  if (nodes.length === 0) return;
  const dpr = window.devicePixelRatio;
  const px = dpr / zoom;
  const nodeSize = 5 * px;
  const handleSize = 4 * px;

  ctx2d.save();
  // Thin dashed line for the path skeleton (faint guide).
  ctx2d.strokeStyle = "rgba(40, 120, 230, 0.85)";
  ctx2d.lineWidth = 1 * px;
  ctx2d.setLineDash([]);

  // Handle tangent lines + handle dots for the selected node only — keeps
  // the overlay legible on dense paths.
  if (selectedIdx !== null && selectedIdx >= 0 && selectedIdx < nodes.length) {
    const n = nodes[selectedIdx];
    // Only draw handles that have non-zero length — a zero-offset handle
    // would render its circle on top of the anchor and look like the
    // vertex is unselectable.
    const handleSqr = n.inX * n.inX + n.inY * n.inY;
    const handleSqrO = n.outX * n.outX + n.outY * n.outY;
    const showIn = (selectedIdx > 0 || closed) && handleSqr > 1;
    const showOut =
      (selectedIdx < nodes.length - 1 || closed) && handleSqrO > 1;
    ctx2d.strokeStyle = "rgba(40, 120, 230, 0.85)";
    ctx2d.beginPath();
    if (showIn) {
      ctx2d.moveTo(n.x, n.y);
      ctx2d.lineTo(n.x + n.inX, n.y + n.inY);
    }
    if (showOut) {
      ctx2d.moveTo(n.x, n.y);
      ctx2d.lineTo(n.x + n.outX, n.y + n.outY);
    }
    ctx2d.stroke();

    ctx2d.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx2d.strokeStyle = "rgba(40, 120, 230, 0.95)";
    ctx2d.lineWidth = 1.25 * px;
    if (showIn) {
      ctx2d.beginPath();
      ctx2d.arc(n.x + n.inX, n.y + n.inY, handleSize, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.stroke();
    }
    if (showOut) {
      ctx2d.beginPath();
      ctx2d.arc(n.x + n.outX, n.y + n.outY, handleSize, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.stroke();
    }
  }

  // Anchor squares.
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const isSelected = i === selectedIdx;
    ctx2d.fillStyle = isSelected
      ? "rgba(40, 120, 230, 0.95)"
      : "rgba(255, 255, 255, 0.95)";
    ctx2d.strokeStyle = "rgba(40, 120, 230, 0.95)";
    ctx2d.lineWidth = 1.25 * px;
    ctx2d.beginPath();
    ctx2d.rect(n.x - nodeSize, n.y - nodeSize, nodeSize * 2, nodeSize * 2);
    ctx2d.fill();
    ctx2d.stroke();
  }
  ctx2d.restore();
}

/** Rubber-band preview from the last placed node to the cursor while drawing
 *  a new path. Shown only when no pointer button is down (otherwise the user
 *  is actively dragging out a handle). */
function drawRubberBand(
  ctx2d: CanvasRenderingContext2D,
  nodes: readonly PathNode[],
  cursorX: number,
  cursorY: number,
  zoom: number,
): void {
  if (nodes.length === 0) return;
  const dpr = window.devicePixelRatio;
  const px = dpr / zoom;
  const last = nodes[nodes.length - 1];
  ctx2d.save();
  ctx2d.strokeStyle = "rgba(40, 120, 230, 0.65)";
  ctx2d.lineWidth = 1 * px;
  ctx2d.setLineDash([4 * px, 3 * px]);
  ctx2d.beginPath();
  // Mirror the last node's out handle into the rubber-band so smooth
  // continuations are visible at a glance.
  const cp1x = last.x + last.outX;
  const cp1y = last.y + last.outY;
  ctx2d.moveTo(last.x, last.y);
  ctx2d.bezierCurveTo(cp1x, cp1y, cursorX, cursorY, cursorX, cursorY);
  ctx2d.stroke();
  ctx2d.restore();
}

// ─── Default appearance helpers ───────────────────────────────────────────────

function defaultStroke(state: { primaryColor: RGBAColor }): RGBAColor | null {
  if (!penOptions.useStroke) return null;
  return penOptions.strokeColor ?? floatToBytes(state.primaryColor);
}

function defaultFill(state: { secondaryColor: RGBAColor }): RGBAColor | null {
  if (!penOptions.useFill) return null;
  return penOptions.fillColor ?? floatToBytes(state.secondaryColor);
}

function newPathLayerSeed(
  id: string,
  name: string,
  primary: RGBAColor,
  secondary: RGBAColor,
): Omit<PathLayerState, "nodes"> & { nodes: PathNode[] } {
  return {
    id,
    name,
    visible: true,
    opacity: 1,
    locked: false,
    blendMode: "normal",
    type: "path",
    nodes: [],
    closed: false,
    fillColor: defaultFill({ secondaryColor: secondary }),
    strokeColor: defaultStroke({ primaryColor: primary }),
    strokeWidth: penOptions.strokeWidth,
    strokeJoin: penOptions.strokeJoin,
    strokeCap: penOptions.strokeCap,
    strokeDash: penOptions.strokeDash.slice(),
    miterLimit: penOptions.miterLimit,
    fillRule: penOptions.fillRule,
    antiAlias: penOptions.antiAlias,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

type DragMode =
  | null
  | { kind: "place-node"; nodeIdx: number; startX: number; startY: number }
  | { kind: "move-draft-node"; nodeIdx: number }
  | { kind: "move-node"; nodeIdx: number }
  | { kind: "move-handle"; nodeIdx: number; which: "in" | "out" };

function createPenHandler(): ToolHandler {
  // ── Drawing-new local draft ───────────────────────────────────────────────
  // While no path is yet committed, the in-progress path lives entirely in
  // handler-local state — no app dispatch, no history churn. The draft is
  // converted to an actual PathLayer via `ctx.addPathLayer` once the user
  // closes / commits.
  let draft: PathLayerState | null = null;
  let dragMode: DragMode = null;
  let selectedIdx: number | null = null;
  let lastCursorX = 0;
  let lastCursorY = 0;
  let keyHandlerInstalled = false;
  // Indices in the current draft whose handles were manually set by a
  // click-drag during placement. autoSmoothHandles leaves these alone so the
  // user's explicit tangent isn't reflowed away on the next click.
  const pinnedDraftIdx = new Set<number>();

  // ── Keyboard ──────────────────────────────────────────────────────────────
  // Installed lazily on first activation and removed when the tool deactivates
  // (no explicit hook — Verve handlers don't have onDeactivate; we leave the
  // listener and gate it on `keyHandlerInstalled` so reactivation is cheap).
  let ctxForKeys: ToolContext | null = null;
  const onKey = (e: KeyboardEvent): void => {
    const ctx = ctxForKeys;
    if (!ctx) return;
    // Don't steal keystrokes from input fields.
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        (t as HTMLElement).isContentEditable)
    )
      return;

    if (e.key === "Escape") {
      if (draft) {
        if (draft.nodes.length >= 2) {
          commitDraft(ctx, /*close*/ false);
        } else {
          discardDraft(ctx);
        }
      } else if (ctx.activePathLayer) {
        ctx.setActiveLayer("");
        const o = ctx.overlayCanvas?.getContext("2d");
        if (o) clearOverlay(o);
      }
      e.preventDefault();
    } else if (e.key === "Enter") {
      if (draft && draft.nodes.length >= 2) {
        commitDraft(ctx, /*close*/ false);
        e.preventDefault();
      }
    } else if (e.key === "Delete" || e.key === "Backspace") {
      const path = ctx.activePathLayer;
      if (path && selectedIdx !== null && path.nodes.length > 1) {
        const nodes = path.nodes.slice();
        nodes.splice(selectedIdx, 1);
        const next: PathLayerState = { ...path, nodes };
        ctx.previewPathLayer(next);
        ctx.updatePathLayer(next);
        ctx.commitStroke("Delete path node");
        selectedIdx = Math.min(selectedIdx, nodes.length - 1);
        redrawEditingOverlay(ctx, next);
        e.preventDefault();
      }
    }
  };

  // ── Commit / discard the draft ────────────────────────────────────────────
  function commitDraft(ctx: ToolContext, close: boolean): void {
    if (!draft || draft.nodes.length < 2) return;
    // Re-flow handles with the final closed/open state so the closing
    // segment is smooth too (for the closed case the auto-handle pass
    // hadn't seen the wrap-around neighbour until now).
    const finalNodes = draft.nodes.slice();
    autoSmoothHandles(finalNodes, close, pinnedDraftIdx);
    const finalLayer: PathLayerState = {
      ...draft,
      nodes: finalNodes,
      closed: close,
    };
    draft = null;
    selectedIdx = null;
    pinnedDraftIdx.clear();
    ctx.addPathLayer(finalLayer);
    ctx.commitStroke(close ? "Create closed path" : "Create open path");
    const o = ctx.overlayCanvas?.getContext("2d");
    if (o) clearOverlay(o);
  }

  function discardDraft(ctx: ToolContext): void {
    draft = null;
    selectedIdx = null;
    pinnedDraftIdx.clear();
    const o = ctx.overlayCanvas?.getContext("2d");
    if (o) clearOverlay(o);
  }

  // ── Editing helpers ───────────────────────────────────────────────────────
  function redrawEditingOverlay(
    ctx: ToolContext,
    path: PathLayerState,
  ): void {
    const o = ctx.overlayCanvas?.getContext("2d");
    if (!o) return;
    clearOverlay(o);
    drawHandles(o, path.nodes, path.closed, ctx.zoom, selectedIdx);
  }

  function redrawDrawingOverlay(ctx: ToolContext, cursorIsValid: boolean): void {
    const o = ctx.overlayCanvas?.getContext("2d");
    if (!o || !draft) return;
    clearOverlay(o);
    drawPathAppearance(o, draft);
    if (cursorIsValid) {
      drawRubberBand(o, draft.nodes, lastCursorX, lastCursorY, ctx.zoom);
    }
    drawHandles(o, draft.nodes, false, ctx.zoom, draft.nodes.length - 1);
  }

  // ── Public handler ────────────────────────────────────────────────────────
  return {
    onActivate(ctx: ToolContext) {
      ctxForKeys = ctx;
      if (!keyHandlerInstalled) {
        window.addEventListener("keydown", onKey, true);
        keyHandlerInstalled = true;
      }
      // Synchronise selection with the active path (if any).
      const path = ctx.activePathLayer;
      if (path) {
        if (selectedIdx === null || selectedIdx >= path.nodes.length) {
          selectedIdx = path.nodes.length > 0 ? path.nodes.length - 1 : null;
        }
        redrawEditingOverlay(ctx, path);
      } else if (draft) {
        redrawDrawingOverlay(ctx, false);
      } else {
        const o = ctx.overlayCanvas?.getContext("2d");
        if (o) clearOverlay(o);
      }
    },

    onPointerDown(pos: ToolPointerPos, ctx: ToolContext) {
      ctxForKeys = ctx;
      lastCursorX = pos.x;
      lastCursorY = pos.y;

      const path = ctx.activePathLayer;

      // ── Drawing-new branch (no active path) ─────────────────────────────
      if (!path) {
        if (!draft) {
          draft = newPathLayerSeed(
            `path-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
            "Path",
            ctx.primaryColor,
            ctx.secondaryColor,
          ) as PathLayerState;
        }

        // Click on first anchor closes the path (>= 3 nodes).
        if (draft.nodes.length >= 3) {
          const first = draft.nodes[0];
          const r = NODE_HIT_PX / ctx.zoom;
          const dx = pos.x - first.x;
          const dy = pos.y - first.y;
          if (dx * dx + dy * dy <= r * r) {
            commitDraft(ctx, true);
            return;
          }
        }

        // Click on an existing draft node — start moving it rather than
        // stacking a new node on top. Without this guard a stray click on
        // the last-placed anchor would push another node + pull a handle.
        const nodeR = NODE_HIT_PX / ctx.zoom;
        for (let i = 0; i < draft.nodes.length; i++) {
          const n = draft.nodes[i];
          const ddx = pos.x - n.x;
          const ddy = pos.y - n.y;
          if (ddx * ddx + ddy * ddy <= nodeR * nodeR) {
            dragMode = { kind: "move-draft-node", nodeIdx: i };
            redrawDrawingOverlay(ctx, false);
            return;
          }
        }

        // Append a new node at the cursor and re-flow handles so every
        // smooth anchor in the draft gets a tangent that fits the current
        // shape (Catmull-Rom). Click-drag during this gesture can still
        // override the new node's handles below; that override is recorded
        // in `pinnedDraftIdx` so subsequent clicks don't auto-overwrite it.
        const newNode: PathNode = makeNewDraftNode(
          pos.x,
          pos.y,
          draft.nodes,
          penOptions.defaultNodeKind,
        );
        draft.nodes.push(newNode);
        autoSmoothHandles(draft.nodes, draft.closed, pinnedDraftIdx);
        dragMode = {
          kind: "place-node",
          nodeIdx: draft.nodes.length - 1,
          startX: pos.x,
          startY: pos.y,
        };
        redrawDrawingOverlay(ctx, false);
        return;
      }

      // ── Editing branch (a path layer is active) ─────────────────────────
      const hit = hitTest(
        path.nodes,
        path.closed,
        selectedIdx,
        pos.x,
        pos.y,
        ctx.zoom,
      );

      if (hit) {
        if (hit.kind === "node") {
          if (pos.altKey) {
            // Cycle node kind: corner → smooth → asymmetric → corner.
            const n = path.nodes[hit.nodeIdx];
            const nextKind: PathNodeKind =
              n.kind === "corner"
                ? "smooth"
                : n.kind === "smooth"
                  ? "asymmetric"
                  : "corner";
            let updated: PathNode = { ...n, kind: nextKind };
            // Switching to "corner" is an explicit "make sharp" gesture —
            // strip the handles so the corner actually becomes pointy.
            if (nextKind === "corner") {
              updated = { ...updated, inX: 0, inY: 0, outX: 0, outY: 0 };
            }
            // When switching corner → smooth and the node has no handles,
            // give it sensible defaults so the user can see them.
            if (
              nextKind !== "corner" &&
              n.inX === 0 &&
              n.inY === 0 &&
              n.outX === 0 &&
              n.outY === 0 &&
              path.nodes.length >= 2
            ) {
              const prev =
                path.nodes[
                  (hit.nodeIdx - 1 + path.nodes.length) % path.nodes.length
                ];
              const next = path.nodes[(hit.nodeIdx + 1) % path.nodes.length];
              const dx = next.x - prev.x;
              const dy = next.y - prev.y;
              const len = Math.hypot(dx, dy);
              if (len > 0) {
                const k = Math.min(60, len / 3);
                const tx = (dx / len) * k;
                const ty = (dy / len) * k;
                updated = { ...updated, inX: -tx, inY: -ty, outX: tx, outY: ty };
              }
            }
            const nodes = path.nodes.slice();
            nodes[hit.nodeIdx] = updated;
            const next: PathLayerState = { ...path, nodes };
            selectedIdx = hit.nodeIdx;
            ctx.previewPathLayer(next);
            ctx.updatePathLayer(next);
            ctx.commitStroke("Toggle path node kind");
            redrawEditingOverlay(ctx, next);
            dragMode = null;
            return;
          }
          selectedIdx = hit.nodeIdx;
          dragMode = { kind: "move-node", nodeIdx: hit.nodeIdx };
          // Hide the GPU layer during drag — the live preview goes on the
          // overlay so we don't pay GPU re-rasterisation cost per move.
          ctx.layer.visible = false;
          redrawEditingOverlay(ctx, path);
          return;
        }
        if (hit.kind === "handle-in" || hit.kind === "handle-out") {
          dragMode = {
            kind: "move-handle",
            nodeIdx: hit.nodeIdx,
            which: hit.kind === "handle-in" ? "in" : "out",
          };
          ctx.layer.visible = false;
          return;
        }
        if (hit.kind === "segment") {
          if (pos.altKey) {
            // Alt-click on segment inserts a node at that parameter value
            // without changing the curve's shape (De Casteljau split).
            const a = path.nodes[hit.segIdx];
            const b = path.nodes[(hit.segIdx + 1) % path.nodes.length];
            const split = splitCubic(
              [a.x, a.y],
              [a.x + a.outX, a.y + a.outY],
              [b.x + b.inX, b.y + b.inY],
              [b.x, b.y],
              hit.t,
            );
            const aNew: PathNode = {
              ...a,
              outX: split.left[1][0] - a.x,
              outY: split.left[1][1] - a.y,
            };
            const inserted: PathNode = {
              x: split.left[3][0],
              y: split.left[3][1],
              inX: split.left[2][0] - split.left[3][0],
              inY: split.left[2][1] - split.left[3][1],
              outX: split.right[1][0] - split.left[3][0],
              outY: split.right[1][1] - split.left[3][1],
              kind: "smooth",
            };
            const bNew: PathNode = {
              ...b,
              inX: split.right[2][0] - b.x,
              inY: split.right[2][1] - b.y,
            };
            const nodes = path.nodes.slice();
            nodes[hit.segIdx] = aNew;
            const insertIdx = hit.segIdx + 1;
            nodes.splice(insertIdx, 0, inserted);
            nodes[(insertIdx + 1) % nodes.length] = bNew;
            const next: PathLayerState = { ...path, nodes };
            selectedIdx = insertIdx;
            ctx.previewPathLayer(next);
            ctx.updatePathLayer(next);
            ctx.commitStroke("Insert path node");
            redrawEditingOverlay(ctx, next);
            dragMode = null;
            return;
          }
          // Plain click on a segment just selects the nearer endpoint.
          const a = path.nodes[hit.segIdx];
          const b = path.nodes[(hit.segIdx + 1) % path.nodes.length];
          const da = Math.hypot(pos.x - a.x, pos.y - a.y);
          const db = Math.hypot(pos.x - b.x, pos.y - b.y);
          selectedIdx = da <= db ? hit.segIdx : (hit.segIdx + 1) % path.nodes.length;
          redrawEditingOverlay(ctx, path);
          dragMode = null;
          return;
        }
      }

      // Click on empty space — deselect; redraw without highlights. Don't
      // start a new path automatically (the user must explicitly clear the
      // selection / press Escape to leave edit mode).
      selectedIdx = null;
      redrawEditingOverlay(ctx, path);
    },

    onPointerMove(pos: ToolPointerPos, ctx: ToolContext) {
      lastCursorX = pos.x;
      lastCursorY = pos.y;
      if (!dragMode) return;

      if (dragMode.kind === "place-node") {
        if (!draft) return;
        const idx = dragMode.nodeIdx;
        const dx = pos.x - dragMode.startX;
        const dy = pos.y - dragMode.startY;
        // Screen-space deadzone — sub-pixel pointer jitter shouldn't change
        // a node the user intended as a plain click.
        const slop = 4 / ctx.zoom;
        if (dx * dx + dy * dy <= slop * slop) return;

        const placed = draft.nodes[idx];
        // For default-"corner" clicks the drag MOVES the corner node — a
        // corner is meant to be sharp, so we never pull handles out of it.
        // For default-"smooth" / "asymmetric" the drag pulls out mirrored
        // handles from the anchor (the classic Pen-tool gesture).
        if (placed.kind === "corner") {
          draft.nodes[idx] = {
            ...placed,
            x: dragMode.startX + dx,
            y: dragMode.startY + dy,
          };
        } else {
          draft.nodes[idx] = {
            ...placed,
            kind: "smooth",
            outX: dx,
            outY: dy,
            inX: -dx,
            inY: -dy,
          };
          // Record this node as manually pinned so the next click's
          // autoSmoothHandles pass doesn't reflow it back to the
          // Catmull-Rom default.
          pinnedDraftIdx.add(idx);
        }
        redrawDrawingOverlay(ctx, false);
        return;
      }

      if (dragMode.kind === "move-draft-node") {
        if (!draft) return;
        const idx = dragMode.nodeIdx;
        draft.nodes[idx] = { ...draft.nodes[idx], x: pos.x, y: pos.y };
        // Moving a node reshapes the curve around it — reflow the unpinned
        // smooth neighbours.
        autoSmoothHandles(draft.nodes, draft.closed, pinnedDraftIdx);
        redrawDrawingOverlay(ctx, false);
        return;
      }

      const path = ctx.activePathLayer;
      if (!path) return;

      if (dragMode.kind === "move-node") {
        const nodes = path.nodes.slice();
        const idx = dragMode.nodeIdx;
        nodes[idx] = { ...nodes[idx], x: pos.x, y: pos.y };
        const next: PathLayerState = { ...path, nodes };
        const o = ctx.overlayCanvas?.getContext("2d");
        if (o) {
          clearOverlay(o);
          drawPathAppearance(o, next);
          drawHandles(o, next.nodes, next.closed, ctx.zoom, selectedIdx);
        }
        // Stash for pointerUp to commit (avoid dispatching per move).
        (dragMode as DragMode & { staged?: PathLayerState }).staged = next;
        return;
      }

      if (dragMode.kind === "move-handle") {
        const idx = dragMode.nodeIdx;
        const n = path.nodes[idx];
        const offX = pos.x - n.x;
        const offY = pos.y - n.y;
        const updated = applyHandleDrag(
          n,
          dragMode.which,
          offX,
          offY,
          pos.altKey, // Alt while dragging = break symmetric / collinear lock
        );
        // If Alt-broken, the node becomes corner (truly independent).
        const finalNode =
          pos.altKey && n.kind !== "corner"
            ? { ...updated, kind: "asymmetric" as PathNodeKind }
            : updated;
        const nodes = path.nodes.slice();
        nodes[idx] = finalNode;
        const next: PathLayerState = { ...path, nodes };
        const o = ctx.overlayCanvas?.getContext("2d");
        if (o) {
          clearOverlay(o);
          drawPathAppearance(o, next);
          drawHandles(o, next.nodes, next.closed, ctx.zoom, selectedIdx);
        }
        (dragMode as DragMode & { staged?: PathLayerState }).staged = next;
      }
    },

    onPointerUp(_pos: ToolPointerPos, ctx: ToolContext) {
      if (!dragMode) return;
      const path = ctx.activePathLayer;

      if (dragMode.kind === "place-node") {
        // Draft already has the latest in/out handles from onPointerMove.
        // Just redraw the overlay (no commit until the user closes / Enters).
        redrawDrawingOverlay(ctx, true);
        dragMode = null;
        return;
      }

      if (dragMode.kind === "move-draft-node") {
        // Draft already updated in onPointerMove; no commit until the path
        // is closed or finalised with Enter.
        redrawDrawingOverlay(ctx, true);
        dragMode = null;
        return;
      }

      const staged = (dragMode as DragMode & { staged?: PathLayerState })
        .staged;
      const kind = dragMode.kind;
      dragMode = null;

      if (!path) return;

      // Restore GPU layer visibility and re-rasterise into its texture.
      ctx.layer.visible = true;
      if (staged) {
        ctx.previewPathLayer(staged);
        ctx.updatePathLayer(staged);
        ctx.commitStroke(
          kind === "move-node" ? "Move path node" : "Adjust path handle",
        );
        redrawEditingOverlay(ctx, staged);
      } else {
        // No movement — just re-render with the original.
        redrawEditingOverlay(ctx, path);
      }
    },

    onHover(pos: ToolPointerPos, ctx: ToolContext) {
      lastCursorX = pos.x;
      lastCursorY = pos.y;
      // Drawing-new: animate the rubber-band from the last placed node.
      if (!ctx.activePathLayer && draft && draft.nodes.length > 0) {
        redrawDrawingOverlay(ctx, true);
        ctx.setCursor("crosshair");
        return;
      }
      // Editing: hover feedback — change cursor over hit-testable targets.
      const path = ctx.activePathLayer;
      if (path) {
        const hit = hitTest(
          path.nodes,
          path.closed,
          selectedIdx,
          pos.x,
          pos.y,
          ctx.zoom,
        );
        if (
          hit &&
          (hit.kind === "node" ||
            hit.kind === "handle-in" ||
            hit.kind === "handle-out")
        ) {
          ctx.setCursor("move");
        } else if (hit && hit.kind === "segment") {
          ctx.setCursor(pos.altKey ? "copy" : "default");
        } else {
          ctx.setCursor("crosshair");
        }
        return;
      }
      // Nothing to do.
      ctx.setCursor("crosshair");
    },

    onLeave(ctx: ToolContext) {
      // Don't clear the overlay — leaving the canvas while drawing should
      // keep the in-progress geometry visible. Just restore the cursor.
      ctx.setCursor("");
    },
  };
}

// ─── Options panel ────────────────────────────────────────────────────────────

function PenOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const { state, dispatch } = useAppContext();

  const activePath =
    state.layers.find(
      (l): l is PathLayerState =>
        "type" in l && l.type === "path" && l.id === state.activeLayerId,
    ) ?? null;

  // Derived current values: prefer the active path's settings, fall back to
  // module defaults so the bar reflects what new strokes will look like.
  const curUseStroke = activePath
    ? activePath.strokeColor !== null
    : penOptions.useStroke;
  const curUseFill = activePath
    ? activePath.fillColor !== null
    : penOptions.useFill;
  const curStrokeWidth = activePath?.strokeWidth ?? penOptions.strokeWidth;
  const curJoin = activePath?.strokeJoin ?? penOptions.strokeJoin;
  const curCap = activePath?.strokeCap ?? penOptions.strokeCap;
  const curDash = activePath?.strokeDash ?? penOptions.strokeDash;
  const curMiter = activePath?.miterLimit ?? penOptions.miterLimit;
  const curFillRule = activePath?.fillRule ?? penOptions.fillRule;
  const curAA = activePath?.antiAlias ?? penOptions.antiAlias;
  const curStrokeColor: RGBAColor =
    activePath?.strokeColor ??
    penOptions.strokeColor ??
    floatToBytes(state.primaryColor);
  const curFillColor: RGBAColor =
    activePath?.fillColor ??
    penOptions.fillColor ??
    floatToBytes(state.secondaryColor);

  // Mirror to module defaults so new paths inherit the bar's settings.
  penOptions.useStroke = curUseStroke;
  penOptions.useFill = curUseFill;
  penOptions.strokeWidth = curStrokeWidth;
  penOptions.strokeJoin = curJoin;
  penOptions.strokeCap = curCap;
  penOptions.strokeDash = curDash.slice();
  penOptions.miterLimit = curMiter;
  penOptions.fillRule = curFillRule;
  penOptions.antiAlias = curAA;

  const update = useCallback(
    (patch: Partial<PathLayerState>) => {
      if (!activePath) return;
      dispatch({
        type: "UPDATE_PATH_LAYER",
        payload: { ...activePath, ...patch },
      });
    },
    [activePath, dispatch],
  );

  const toggleStroke = useCallback(() => {
    const next = !curUseStroke;
    penOptions.useStroke = next;
    if (activePath) {
      update({
        strokeColor: next ? penOptions.strokeColor ?? curStrokeColor : null,
      });
    }
  }, [curUseStroke, curStrokeColor, activePath, update]);

  const toggleFill = useCallback(() => {
    const next = !curUseFill;
    penOptions.useFill = next;
    if (activePath) {
      update({
        fillColor: next ? penOptions.fillColor ?? curFillColor : null,
      });
    }
  }, [curUseFill, curFillColor, activePath, update]);

  const setStrokeWidth = useCallback(
    (v: number) => {
      penOptions.strokeWidth = v;
      update({ strokeWidth: v });
    },
    [update],
  );

  const setStrokeColor = useCallback(
    (c: RGBAColor) => {
      penOptions.strokeColor = c;
      if (activePath && curUseStroke) update({ strokeColor: c });
    },
    [activePath, curUseStroke, update],
  );

  const setFillColor = useCallback(
    (c: RGBAColor) => {
      penOptions.fillColor = c;
      if (activePath && curUseFill) update({ fillColor: c });
    },
    [activePath, curUseFill, update],
  );

  const setJoin = useCallback(
    (v: "miter" | "round" | "bevel") => {
      penOptions.strokeJoin = v;
      update({ strokeJoin: v });
    },
    [update],
  );

  const setCap = useCallback(
    (v: "butt" | "round" | "square") => {
      penOptions.strokeCap = v;
      update({ strokeCap: v });
    },
    [update],
  );

  const setDash = useCallback(
    (csv: string) => {
      const parsed = csv
        .split(/[,\s]+/)
        .map((s) => parseFloat(s.trim()))
        .filter((n) => Number.isFinite(n) && n >= 0);
      penOptions.strokeDash = parsed;
      update({ strokeDash: parsed });
    },
    [update],
  );

  const setMiter = useCallback(
    (v: number) => {
      penOptions.miterLimit = v;
      update({ miterLimit: v });
    },
    [update],
  );

  const setFillRule = useCallback(
    (v: "nonzero" | "evenodd") => {
      penOptions.fillRule = v;
      update({ fillRule: v });
    },
    [update],
  );

  const setAA = useCallback(
    (v: boolean) => {
      penOptions.antiAlias = v;
      update({ antiAlias: v });
    },
    [update],
  );

  const setDefaultNodeKind = useCallback((v: PathNodeKind) => {
    penOptions.defaultNodeKind = v;
  }, []);

  const setClosed = useCallback(
    (v: boolean) => {
      update({ closed: v });
    },
    [update],
  );

  return (
    <>
      {/* Stroke on/off + colour */}
      <label className={styles.optCheckLabel} title="Stroke the path outline">
        <input
          type="checkbox"
          checked={curUseStroke}
          onChange={toggleStroke}
          className={styles.optCheckbox}
        />
        Stroke
      </label>
      {curUseStroke && (
        <ColorSwatch
          value={rgbaToHex(curStrokeColor)}
          onChange={(hex) => setStrokeColor(hexToRgba(hex, curStrokeColor.a))}
          className={swatchStyles.swatch}
          title="Stroke colour"
        />
      )}

      <span className={styles.optLabel}>W</span>
      <SliderInput
        min={0}
        max={100}
        step={1}
        value={curStrokeWidth}
        onChange={setStrokeWidth}
      />

      <div className={styles.optSep} />

      {/* Fill on/off + colour + rule */}
      <label className={styles.optCheckLabel} title="Fill the path interior">
        <input
          type="checkbox"
          checked={curUseFill}
          onChange={toggleFill}
          className={styles.optCheckbox}
        />
        Fill
      </label>
      {curUseFill && (
        <ColorSwatch
          value={rgbaToHex(curFillColor)}
          onChange={(hex) => setFillColor(hexToRgba(hex, curFillColor.a))}
          className={swatchStyles.swatch}
          title="Fill colour"
        />
      )}
      {curUseFill && (
        <select
          className={styles.optSelect}
          value={curFillRule}
          onChange={(e) =>
            setFillRule(e.target.value as "nonzero" | "evenodd")
          }
          title="Fill rule for self-intersecting paths"
        >
          <option value="nonzero">Nonzero</option>
          <option value="evenodd">Even-odd</option>
        </select>
      )}

      <div className={styles.optSep} />

      {/* Stroke style: join + cap + dash */}
      <span className={styles.optLabel}>Join</span>
      <select
        className={styles.optSelect}
        value={curJoin}
        onChange={(e) => setJoin(e.target.value as "miter" | "round" | "bevel")}
      >
        <option value="round">Round</option>
        <option value="miter">Miter</option>
        <option value="bevel">Bevel</option>
      </select>
      {curJoin === "miter" && (
        <>
          <span className={styles.optLabel}>Limit</span>
          <SliderInput
            min={1}
            max={20}
            step={0.5}
            value={curMiter}
            onChange={setMiter}
          />
        </>
      )}

      <span className={styles.optLabel}>Cap</span>
      <select
        className={styles.optSelect}
        value={curCap}
        onChange={(e) => setCap(e.target.value as "butt" | "round" | "square")}
      >
        <option value="round">Round</option>
        <option value="butt">Butt</option>
        <option value="square">Square</option>
      </select>

      <span className={styles.optLabel} title="Dash pattern (CSV)">
        Dash
      </span>
      <input
        type="text"
        className={styles.optText}
        style={{ width: 80 }}
        defaultValue={curDash.join(", ")}
        onBlur={(e) => setDash(e.target.value)}
        placeholder="solid"
        title="Comma-separated lengths, e.g. 6,3"
      />

      <div className={styles.optSep} />

      {/* Path-level toggles */}
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={curAA}
          onChange={(e) => setAA(e.target.checked)}
          className={styles.optCheckbox}
        />
        Anti-alias
      </label>

      {activePath && (
        <label
          className={styles.optCheckLabel}
          title="Close the path (last segment connects back to the first node)"
        >
          <input
            type="checkbox"
            checked={activePath.closed}
            onChange={(e) => setClosed(e.target.checked)}
            className={styles.optCheckbox}
          />
          Closed
        </label>
      )}

      <div className={styles.optSep} />

      <span className={styles.optLabel} title="Vertex type when click (no drag)">
        New node
      </span>
      <select
        className={styles.optSelect}
        defaultValue={penOptions.defaultNodeKind}
        onChange={(e) => setDefaultNodeKind(e.target.value as PathNodeKind)}
      >
        <option value="corner">Corner</option>
        <option value="smooth">Smooth</option>
      </select>
    </>
  );
}

// ─── Registered tool ──────────────────────────────────────────────────────────

class PenTool implements ITool {
  readonly id = "pen";
  readonly label = "Pen";
  readonly shortcut = "P";
  readonly icon = <SvgIcon src={penIconSvg} />;
  readonly placement = { group: ToolGroup.Type, row: 1, column: 0 } as const;
  readonly modifiesPixels = false;
  readonly skipAutoHistory = true;
  createHandler(): ToolHandler {
    return createPenHandler();
  }
  readonly Options = PenOptions;
}

export const penTool: ITool = new PenTool();
