import type { FrameLayerState } from "@/types";
import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { rgbaToStr } from "./shapeRasterizer";

// ─── Shared offscreen rasterization canvas ────────────────────────────────────

let _canvas: HTMLCanvasElement | null = null;
let _ctx: CanvasRenderingContext2D | null = null;

function getRasterCtx(w: number, h: number): CanvasRenderingContext2D {
  if (!_canvas) _canvas = document.createElement("canvas");
  if (_canvas.width !== w) _canvas.width = w;
  if (_canvas.height !== h) _canvas.height = h;
  if (!_ctx) _ctx = _canvas.getContext("2d", { willReadFrequently: true })!;
  return _ctx;
}

// ─── Decoded-content cache ─────────────────────────────────────────────────────
// rasterizeFrameToLayer is called on every parameter tweak (drag-resize, etc.).
// Decoding the base64-RGBA payload + creating an ImageBitmap on every call would
// thrash. Cache the decoded ImageBitmap keyed by (rgba ref + dimensions).

interface ContentBitmap {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

const _bitmapCache = new WeakMap<FrameLayerState["content"] & object, ContentBitmap>();
// Pending (in-flight) decodes — keyed the same way — so rasterize() can return
// a placeholder for one frame and re-rasterize once the decode completes.
const _pendingDecodes = new WeakMap<
  FrameLayerState["content"] & object,
  Promise<ContentBitmap>
>();

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeContent(
  content: NonNullable<FrameLayerState["content"]>,
): Promise<ContentBitmap> {
  const existing = _pendingDecodes.get(content);
  if (existing) return existing;

  const promise = (async (): Promise<ContentBitmap> => {
    const bytes = base64ToUint8Array(content.rgba);
    // Allocate a fresh, non-shared backing buffer so the resulting
    // Uint8ClampedArray satisfies ImageData's `ArrayBuffer` (not `ArrayBufferLike`)
    // constructor signature.
    const clamped = new Uint8ClampedArray(bytes.length);
    clamped.set(bytes);
    const imageData = new ImageData(clamped, content.width, content.height);
    const bitmap = await createImageBitmap(imageData);
    const entry: ContentBitmap = {
      bitmap,
      width: content.width,
      height: content.height,
    };
    _bitmapCache.set(content, entry);
    return entry;
  })();

  _pendingDecodes.set(content, promise);
  return promise;
}

/** Returns a cached decoded bitmap, or null if it isn't ready yet. */
export function tryGetDecodedContent(
  content: NonNullable<FrameLayerState["content"]>,
): ContentBitmap | null {
  return _bitmapCache.get(content) ?? null;
}

/**
 * Decode the content image if it isn't already cached. The caller (Canvas)
 * passes a callback to re-rasterize the layer once the decode completes.
 */
export function ensureContentDecoded(
  content: NonNullable<FrameLayerState["content"]>,
  onReady: () => void,
): void {
  if (_bitmapCache.has(content)) return;
  decodeContent(content)
    .then(() => onReady())
    .catch((err) => {
      console.error("Failed to decode frame content:", err);
    });
}

// ─── Path builder ─────────────────────────────────────────────────────────────

/**
 * Build the frame's path on `ctx`, centred at (0,0), without translating.
 * Caller is expected to set up translate/rotate before calling.
 */
export function buildFramePath(
  ctx: CanvasRenderingContext2D,
  ls: FrameLayerState,
): void {
  const hw = ls.w / 2;
  const hh = ls.h / 2;
  ctx.beginPath();
  if (ls.frameType === "ellipse") {
    ctx.ellipse(0, 0, Math.max(0.5, hw), Math.max(0.5, hh), 0, 0, Math.PI * 2);
  } else {
    ctx.rect(-hw, -hh, ls.w, ls.h);
  }
}

// ─── Content fitting ──────────────────────────────────────────────────────────

interface FittedDest {
  /** Position relative to the frame centre, before manual offset/scale. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

function computeFitDestination(
  fit: FrameLayerState["fit"],
  frameW: number,
  frameH: number,
  imgW: number,
  imgH: number,
): FittedDest {
  if (fit === "stretch") {
    return { dx: -frameW / 2, dy: -frameH / 2, dw: frameW, dh: frameH };
  }
  if (fit === "center") {
    return { dx: -imgW / 2, dy: -imgH / 2, dw: imgW, dh: imgH };
  }
  const sx = frameW / imgW;
  const sy = frameH / imgH;
  const s = fit === "fill" ? Math.max(sx, sy) : Math.min(sx, sy);
  const dw = imgW * s;
  const dh = imgH * s;
  return { dx: -dw / 2, dy: -dh / 2, dw, dh };
}

// ─── Empty placeholder ────────────────────────────────────────────────────────

function drawEmptyPlaceholder(
  ctx: CanvasRenderingContext2D,
  ls: FrameLayerState,
): void {
  const hw = ls.w / 2;
  const hh = ls.h / 2;
  // Soft fill so the frame is visible against any background but doesn't
  // dominate the view.
  ctx.fillStyle = "rgba(150,150,150,0.25)";
  ctx.fill();
  // Diagonal cross indicating an empty frame slot — Photoshop-style.
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = "rgba(120,120,120,0.7)";
  ctx.lineWidth = Math.max(1, Math.min(ls.w, ls.h) * 0.005);
  ctx.beginPath();
  ctx.moveTo(-hw, -hh);
  ctx.lineTo(hw, hh);
  ctx.moveTo(hw, -hh);
  ctx.lineTo(-hw, hh);
  ctx.stroke();
  ctx.restore();
}

// ─── Main rasterizer ──────────────────────────────────────────────────────────

/**
 * Render the frame layer described by `ls` into `glLayer.data`. `glLayer` must
 * be sized to the canvas (width × height, offsetX/Y = 0). The caller is
 * responsible for `renderer.flushLayer(glLayer)` after this returns.
 *
 * If the content image hasn't been decoded yet, the frame is drawn empty;
 * `ensureContentDecoded` should be called separately to trigger the decode
 * and re-rasterize when it completes.
 */
export function rasterizeFrameToLayer(
  ls: FrameLayerState,
  glLayer: GpuLayer,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const ctx = getRasterCtx(canvasWidth, canvasHeight);
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  ctx.save();
  ctx.translate(ls.cx, ls.cy);
  ctx.rotate((ls.rotation * Math.PI) / 180);

  buildFramePath(ctx, ls);

  // Resolve content (if any + decoded). drawImage/clip use the same path.
  const decoded = ls.content ? _bitmapCache.get(ls.content) : null;

  if (decoded) {
    ctx.save();
    ctx.clip();
    const fitted = computeFitDestination(
      ls.fit,
      ls.w,
      ls.h,
      decoded.width,
      decoded.height,
    );
    const scale = ls.contentScale > 0 ? ls.contentScale : 1;
    const cx = fitted.dx + fitted.dw / 2 + ls.contentOffsetX;
    const cy = fitted.dy + fitted.dh / 2 + ls.contentOffsetY;
    const dw = fitted.dw * scale;
    const dh = fitted.dh * scale;
    ctx.drawImage(decoded.bitmap, cx - dw / 2, cy - dh / 2, dw, dh);
    ctx.restore();
  } else {
    drawEmptyPlaceholder(ctx, ls);
  }

  // Stroke the frame outline last so it sits on top of the content/placeholder.
  if (ls.strokeColor && ls.strokeWidth > 0) {
    ctx.strokeStyle = rgbaToStr(ls.strokeColor);
    ctx.lineWidth = ls.strokeWidth;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  ctx.restore();

  // Copy to the GpuLayer's CPU buffer.
  const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
  (glLayer.data as Uint8Array).set(imageData.data);
}
