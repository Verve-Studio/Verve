import type { ShapeLayerState } from "@/types";
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
): void {
  const ctx2d = getRasterCtx(canvasWidth, canvasHeight);
  ctx2d.clearRect(0, 0, canvasWidth, canvasHeight);

  if (ls.shapeType === "line") {
    ctx2d.save();
    ctx2d.beginPath();
    const snap = ls.antiAlias ? 0 : 0.5;
    ctx2d.moveTo(Math.round(ls.x1) + snap, Math.round(ls.y1) + snap);
    ctx2d.lineTo(Math.round(ls.x2) + snap, Math.round(ls.y2) + snap);
    if (ls.strokeColor) {
      ctx2d.strokeStyle = rgbaToStr(ls.strokeColor);
      ctx2d.lineWidth = Math.max(1, ls.strokeWidth);
      ctx2d.lineCap = "round";
      ctx2d.stroke();
    }
    ctx2d.restore();
  } else {
    ctx2d.save();
    const cx = ls.antiAlias ? ls.cx : Math.round(ls.cx);
    const cy = ls.antiAlias ? ls.cy : Math.round(ls.cy);
    ctx2d.translate(cx, cy);
    ctx2d.rotate((ls.rotation * Math.PI) / 180);
    buildShapePath(ctx2d, ls);

    if (ls.fillColor) {
      ctx2d.fillStyle = rgbaToStr(ls.fillColor);
      ctx2d.fill();
    }
    if (ls.strokeColor && ls.strokeWidth > 0) {
      ctx2d.strokeStyle = rgbaToStr(ls.strokeColor);
      ctx2d.lineWidth = ls.strokeWidth;
      ctx2d.lineJoin = "round";
      ctx2d.stroke();
    }
    ctx2d.restore();
  }

  // Copy rasterized pixels into the GL layer buffer
  const imageData = ctx2d.getImageData(0, 0, canvasWidth, canvasHeight);
  glLayer.data.set(imageData.data);
}
