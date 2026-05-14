import type {
  ShapeLayerState,
  PixelFormat,
  RGBAColor,
  Gradient,
} from "@/types";
import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";

// ─── Shared offscreen canvas ──────────────────────────────────────────────────

let _canvas: HTMLCanvasElement | null = null;
let _ctx: CanvasRenderingContext2D | null = null;

function getRasterCtx(w: number, h: number): CanvasRenderingContext2D {
  if (!_canvas) {
    _canvas = document.createElement("canvas");
  }
  if (_canvas.width !== w) _canvas.width = w;
  if (_canvas.height !== h) _canvas.height = h;
  if (!_ctx) _ctx = _canvas.getContext("2d", { willReadFrequently: true })!;
  return _ctx;
}

// ─── RGBA → CSS colour string ─────────────────────────────────────────────────

export function rgbaToStr(c: {
  r: number;
  g: number;
  b: number;
  a: number;
}): string {
  return `rgba(${c.r},${c.g},${c.b},${c.a / 255})`;
}

/**
 * Build a Canvas2D gradient from a parametric `Gradient`. Coordinates are in
 * canvas pixels — callers must NOT have an active transform when calling this
 * (call `ctx2d.save()` / reset before; restore after) because Canvas2D bakes
 * the gradient into its own coordinate space at creation time.
 */
export function buildCanvasGradient(
  ctx2d: CanvasRenderingContext2D,
  g: Gradient,
): CanvasGradient {
  let grad: CanvasGradient;
  if (g.type === "radial") {
    const r = Math.max(
      0.5,
      Math.hypot(g.endX - g.startX, g.endY - g.startY),
    );
    grad = ctx2d.createRadialGradient(
      g.startX,
      g.startY,
      0,
      g.startX,
      g.startY,
      r,
    );
  } else {
    grad = ctx2d.createLinearGradient(g.startX, g.startY, g.endX, g.endY);
  }
  const stops =
    g.stops.length >= 2
      ? g.stops
      : g.stops.length === 1
        ? [{ offset: 0, color: g.stops[0].color }, { offset: 1, color: g.stops[0].color }]
        : [
            { offset: 0, color: { r: 0, g: 0, b: 0, a: 255 } },
            { offset: 1, color: { r: 255, g: 255, b: 255, a: 255 } },
          ];
  for (const s of stops) {
    const t = Math.max(0, Math.min(1, s.offset));
    grad.addColorStop(t, rgbaToStr(s.color));
  }
  return grad;
}

// ─── Shared path builder ──────────────────────────────────────────────────────
// Draws the shape's path on ctx2d, centred at (0,0) without any transform or stroke/fill.
// Caller must set up translate/rotate before calling and call fill/stroke after.

export function buildShapePath(
  ctx2d: CanvasRenderingContext2D,
  ls: ShapeLayerState,
): void {
  const hw = ls.w / 2;
  const hh = ls.h / 2;

  ctx2d.beginPath();

  switch (ls.shapeType) {
    case "rectangle": {
      const cr = Math.max(0, Math.min(ls.cornerRadius, hw, hh));
      if (cr > 0) {
        ctx2d.roundRect(-hw, -hh, ls.w, ls.h, cr);
      } else {
        ctx2d.rect(-hw, -hh, ls.w, ls.h);
      }
      break;
    }

    case "ellipse":
      ctx2d.ellipse(
        0,
        0,
        Math.max(0.5, hw),
        Math.max(0.5, hh),
        0,
        0,
        Math.PI * 2,
      );
      break;

    case "triangle":
      ctx2d.moveTo(0, -hh);
      ctx2d.lineTo(hw, hh);
      ctx2d.lineTo(-hw, hh);
      ctx2d.closePath();
      break;

    case "diamond":
      ctx2d.moveTo(0, -hh);
      ctx2d.lineTo(hw, 0);
      ctx2d.lineTo(0, hh);
      ctx2d.lineTo(-hw, 0);
      ctx2d.closePath();
      break;

    case "star": {
      const pts = 5;
      const outer = Math.max(0.5, Math.min(hw, hh));
      const inner = outer * 0.45;
      const startAngle = -Math.PI / 2;
      for (let i = 0; i < pts * 2; i++) {
        const angle = startAngle + (i * Math.PI) / pts;
        const r = i % 2 === 0 ? outer : inner;
        if (i === 0) ctx2d.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
        else ctx2d.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
      }
      ctx2d.closePath();
      break;
    }

    case "line":
      // Handled separately — no rotation/centering transform needed
      break;
  }
}

// ─── Main rasterizer ──────────────────────────────────────────────────────────

/**
 * Render the shape described by `ls` into `glLayer`'s pixel buffer using a
 * Canvas2D intermediate pass. `glLayer` must be full-canvas-sized (created at
 * canvasWidth × canvasHeight with offsetX/Y = 0).
 * Caller is responsible for calling renderer.flushLayer(glLayer) afterwards.
 */
export function rasterizeShapeToLayer(
  ls: ShapeLayerState,
  glLayer: GpuLayer,
  canvasWidth: number,
  canvasHeight: number,
  pixelFormat: PixelFormat = "rgba8",
  swatches: readonly RGBAColor[] = [],
): void {
  const ctx2d = getRasterCtx(canvasWidth, canvasHeight);
  ctx2d.clearRect(0, 0, canvasWidth, canvasHeight);

  // Indexed8 documents have no per-pixel alpha — every pixel must map
  // to a single palette entry. Force AA off and binarise the alpha
  // channel after Canvas2D rasterises (Canvas2D itself can't draw with
  // hard edges, the threshold gives crisp 1-bit silhouettes).
  const indexed = pixelFormat === "indexed8";
  const aa = indexed ? false : ls.antiAlias;

  // Resolve palette-index references against the *current* swatches so
  // the shape live-updates when the user edits a palette entry or swaps
  // colours. Falls back to the cached strokeColor/fillColor when no
  // index is present (e.g. shapes drawn in rgba8 mode).
  const resolvedStroke =
    ls.strokeIndex !== undefined && swatches[ls.strokeIndex]
      ? swatches[ls.strokeIndex]
      : ls.strokeColor;
  const resolvedFill =
    ls.fillIndex !== undefined && swatches[ls.fillIndex]
      ? swatches[ls.fillIndex]
      : ls.fillColor;

  if (ls.shapeType === "line") {
    ctx2d.save();
    ctx2d.beginPath();
    const snap = aa ? 0 : 0.5;
    ctx2d.moveTo(Math.round(ls.x1) + snap, Math.round(ls.y1) + snap);
    ctx2d.lineTo(Math.round(ls.x2) + snap, Math.round(ls.y2) + snap);
    if (resolvedStroke) {
      ctx2d.strokeStyle = rgbaToStr(resolvedStroke);
      ctx2d.lineWidth = Math.max(1, ls.strokeWidth);
      ctx2d.lineCap = "round";
      ctx2d.stroke();
    }
    ctx2d.restore();
  } else {
    ctx2d.save();
    const cx = aa ? ls.cx : Math.round(ls.cx);
    const cy = aa ? ls.cy : Math.round(ls.cy);
    ctx2d.translate(cx, cy);
    ctx2d.rotate((ls.rotation * Math.PI) / 180);
    buildShapePath(ctx2d, ls);

    // Reset to identity before fill/stroke. The path is already baked into
    // canvas coordinates (Canvas2D transforms points at moveTo/lineTo time),
    // so this keeps gradients — which are stored in canvas-space coords —
    // sampling in the right place regardless of the shape's rotation.
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);

    const grad = ls.fillGradient;
    if (grad && grad.stops.length >= 1) {
      ctx2d.fillStyle = buildCanvasGradient(ctx2d, grad);
      ctx2d.fill();
    } else if (resolvedFill) {
      ctx2d.fillStyle = rgbaToStr(resolvedFill);
      ctx2d.fill();
    }
    if (resolvedStroke && ls.strokeWidth > 0) {
      ctx2d.strokeStyle = rgbaToStr(resolvedStroke);
      ctx2d.lineWidth = ls.strokeWidth;
      ctx2d.lineJoin = "round";
      ctx2d.stroke();
    }
    ctx2d.restore();
  }

  // Copy rasterized pixels into the GL layer buffer
  const imageData = ctx2d.getImageData(0, 0, canvasWidth, canvasHeight);
  if (indexed) {
    // 1-bit alpha threshold: any partially-covered edge pixel becomes
    // either fully opaque with the source colour or fully transparent.
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i + 3] = data[i + 3] >= 128 ? 255 : 0;
    }
  }
  glLayer.data.set(imageData.data);
}
