import type { PathLayerState, PathNode, PixelFormat, Gradient } from "@/types";
import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { rgbaToStr, buildCanvasGradient } from "./shapeRasterizer";

// ─── Shared offscreen canvas (one per rasterizer; never touches the GPU ctx) ──

let _canvas: HTMLCanvasElement | null = null;
let _ctx: CanvasRenderingContext2D | null = null;

function getRasterCtx(w: number, h: number): CanvasRenderingContext2D {
  if (!_canvas) _canvas = document.createElement("canvas");
  if (_canvas.width !== w) _canvas.width = w;
  if (_canvas.height !== h) _canvas.height = h;
  if (!_ctx) _ctx = _canvas.getContext("2d", { willReadFrequently: true })!;
  return _ctx;
}

// ─── Path traversal helpers ───────────────────────────────────────────────────

/**
 * Trace the Bezier path described by `nodes` onto `ctx2d`. Each segment is a
 * cubic between consecutive nodes; the control points are computed from each
 * node's `outX/outY` (departure handle) and the next node's `inX/inY`
 * (arrival handle). When `closed`, also emits the wrap-around segment.
 */
export function buildPathPath2D(
  ctx2d: CanvasRenderingContext2D | Path2D,
  nodes: readonly PathNode[],
  closed: boolean,
): void {
  if (nodes.length === 0) return;
  if ("beginPath" in ctx2d) ctx2d.beginPath();
  const first = nodes[0];
  ctx2d.moveTo(first.x, first.y);
  const last = closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < last; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % nodes.length];
    ctx2d.bezierCurveTo(
      a.x + a.outX,
      a.y + a.outY,
      b.x + b.inX,
      b.y + b.inY,
      b.x,
      b.y,
    );
  }
  if (closed) ctx2d.closePath();
}

// ─── Main rasterizer ──────────────────────────────────────────────────────────

/**
 * Rasterise `ls`'s vector path into `glLayer`'s pixel buffer via Canvas2D.
 * `glLayer` must be full-canvas-sized (offsetX/Y = 0).
 *
 * The caller is responsible for calling `renderer.flushLayer(glLayer)`
 * afterwards.
 */
export function rasterizePathToLayer(
  ls: PathLayerState,
  glLayer: GpuLayer,
  canvasWidth: number,
  canvasHeight: number,
  pixelFormat: PixelFormat = "rgba8",
): void {
  const ctx2d = getRasterCtx(canvasWidth, canvasHeight);
  ctx2d.clearRect(0, 0, canvasWidth, canvasHeight);

  // indexed8 docs have 1-bit alpha — disable AA and threshold below.
  const indexed = pixelFormat === "indexed8";

  if (ls.nodes.length >= 2) {
    ctx2d.save();
    // Canvas2D doesn't expose a per-shape "disable AA" toggle; for indexed
    // mode we paint AA-on and threshold the alpha channel after the copy.
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

  const imageData = ctx2d.getImageData(0, 0, canvasWidth, canvasHeight);
  if (indexed) {
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i + 3] = data[i + 3] >= 128 ? 255 : 0;
    }
  }
  glLayer.data.set(imageData.data);
}

/**
 * Translate every node's anchor by (dx, dy). Handles are stored as offsets
 * relative to the anchor, so they ride along automatically. Used by the
 * Move tool when committing a whole-layer drag of a path.
 */
export function translatePathNodes(
  nodes: readonly PathNode[],
  dx: number,
  dy: number,
): PathNode[] {
  if (dx === 0 && dy === 0) return nodes.slice();
  return nodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy }));
}

/**
 * Translate a vector gradient's anchor points by (dx, dy). Used when the
 * owning shape/path is moved so the gradient rides along with the geometry
 * instead of staying pinned at its original canvas position.
 */
export function translateGradient(
  g: Gradient,
  dx: number,
  dy: number,
): Gradient {
  if (dx === 0 && dy === 0) return g;
  return {
    ...g,
    startX: g.startX + dx,
    startY: g.startY + dy,
    endX: g.endX + dx,
    endY: g.endY + dy,
  };
}

// ─── Geometry helpers (used by the Pen tool's hit-testing / segment-insert) ──

/** Cubic Bezier at parameter t ∈ [0,1]. */
export function cubicAt(
  p0x: number, p0y: number,
  p1x: number, p1y: number,
  p2x: number, p2y: number,
  p3x: number, p3y: number,
  t: number,
): [number, number] {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return [
    w0 * p0x + w1 * p1x + w2 * p2x + w3 * p3x,
    w0 * p0y + w1 * p1y + w2 * p2y + w3 * p3y,
  ];
}

/**
 * Approximate the closest point on a cubic Bezier segment to (px, py) by
 * sampling. Returns `{ t, dist }`. Cheap enough for hit-testing during a
 * pointer move (~32 samples) and produces enough resolution for picking.
 */
export function closestPointOnCubic(
  px: number, py: number,
  p0x: number, p0y: number,
  p1x: number, p1y: number,
  p2x: number, p2y: number,
  p3x: number, p3y: number,
  samples = 32,
): { t: number; dist: number; x: number; y: number } {
  let bestT = 0;
  let bestDist2 = Infinity;
  let bestX = p0x;
  let bestY = p0y;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const [x, y] = cubicAt(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y, t);
    const dx = x - px;
    const dy = y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestT = t;
      bestX = x;
      bestY = y;
    }
  }
  return { t: bestT, dist: Math.sqrt(bestDist2), x: bestX, y: bestY };
}

/**
 * Split a cubic Bezier at parameter `t` using De Casteljau's algorithm.
 * Returns the four control points of each half: `[left, right]` where each
 * is `[p0, p1, p2, p3]`. Used by the Pen tool to insert a node on an
 * existing segment without changing the curve's shape.
 */
export function splitCubic(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  t: number,
): {
  left: [[number, number], [number, number], [number, number], [number, number]];
  right: [[number, number], [number, number], [number, number], [number, number]];
} {
  const lerp = (
    a: [number, number],
    b: [number, number],
  ): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const q0 = lerp(p0, p1);
  const q1 = lerp(p1, p2);
  const q2 = lerp(p2, p3);
  const r0 = lerp(q0, q1);
  const r1 = lerp(q1, q2);
  const s = lerp(r0, r1);
  return {
    left: [p0, q0, r0, s],
    right: [s, r1, q2, p3],
  };
}
