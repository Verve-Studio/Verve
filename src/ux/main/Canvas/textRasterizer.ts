import type { TextLayerState } from "@/types";
import type {
  GpuLayer,
  WebGPURenderer,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import { drawTextLayout, layoutText } from "@/core/tools/Text/textLayout";
import { srgbToLinearChannel } from "@/utils/pixelFormatConvert";

/**
 * Draw a TextLayerState onto an arbitrary 2D context at its `ls.x / ls.y`
 * canvas-space position. Layout (wrapping, alignment, PSD character and
 * paragraph attributes) comes from `textLayout.ts`, which the inline editor
 * also uses for its caret — so the editor and the raster always agree.
 */
export function drawTextToCtx2d(
  ctx2d: CanvasRenderingContext2D,
  ls: TextLayerState,
): void {
  drawTextLayout(ctx2d, layoutText(ls));
}

// ─── Region rasterisation ────────────────────────────────────────────────────

interface IRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** What a text GpuLayer's buffer holds: the rect our last raster wrote (all
 *  pixels outside it are transparent). Only trusted while the buffer and its
 *  uploaded version are the ones we left — anything else (history restore,
 *  format conversion) falls back to a one-off full clear. */
interface RasterRecord {
  rect: IRect | null;
  data: GpuLayer["data"];
  version: number; // -1 = flushed under deferFlush, version unknown
}
const records = new WeakMap<GpuLayer, RasterRecord>();

let scratch: OffscreenCanvas | HTMLCanvasElement | null = null;
let scratchCtx:
  | OffscreenCanvasRenderingContext2D
  | CanvasRenderingContext2D
  | null = null;

function getScratch(
  w: number,
  h: number,
): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  if (!scratch || scratch.width < w || scratch.height < h) {
    const nw = Math.max(w, scratch?.width ?? 0);
    const nh = Math.max(h, scratch?.height ?? 0);
    scratch =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(nw, nh)
        : Object.assign(document.createElement("canvas"), {
            width: nw,
            height: nh,
          });
    scratchCtx = scratch.getContext("2d", { willReadFrequently: true }) as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D;
  }
  return scratchCtx!;
}

let srgbToLinearLut: Float32Array | null = null;
function linearLut(): Float32Array {
  if (!srgbToLinearLut) {
    srgbToLinearLut = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      srgbToLinearLut[i] = srgbToLinearChannel(i / 255);
    }
  }
  return srgbToLinearLut;
}

function clearRows(gl: GpuLayer, r: IRect): void {
  const W = gl.layerWidth;
  const d = gl.data;
  for (let y = r.y0; y < r.y1; y++) {
    d.fill(0, (y * W + r.x0) * 4, (y * W + r.x1) * 4);
  }
}

/** Declare a freshly created (all-transparent) text GpuLayer, so its first
 *  raster uploads only the text's region instead of the whole canvas. */
export function markTextLayerBlank(gl: GpuLayer): void {
  records.set(gl, { rect: null, data: gl.data, version: gl.contentVersion });
}

/**
 * Rasterise a text layer into its canvas-sized GpuLayer and upload it.
 *
 * Only the union of the previous and the new ink bounds is cleared, redrawn
 * and uploaded, so a keystroke costs a region the size of the text rather
 * than a canvas-sized draw + readback + upload.
 */
export function rasterizeTextToLayer(
  ls: TextLayerState,
  gl: GpuLayer,
  renderer: WebGPURenderer,
): void {
  if (gl.format === "indexed8") return;
  const W = gl.layerWidth;
  const H = gl.layerHeight;
  const layout = ls.text ? layoutText(ls) : null;
  const ink = layout?.ink;
  let next: IRect | null = null;
  if (ink) {
    const x0 = Math.max(0, ink.x);
    const y0 = Math.max(0, ink.y);
    const x1 = Math.min(W, ink.x + ink.w);
    const y1 = Math.min(H, ink.y + ink.h);
    if (x0 < x1 && y0 < y1) next = { x0, y0, x1, y1 };
  }

  const rec = records.get(gl);
  const known =
    !!rec &&
    rec.data === gl.data &&
    (rec.version === -1 || rec.version === gl.contentVersion);
  if (!known) {
    gl.data.fill(0);
    renderer.markFullDirty(gl);
  } else {
    const prev = rec.rect;
    if (!prev && !next) return; // empty before and after: nothing to do
    if (prev) {
      clearRows(gl, prev);
      renderer.markDirtyRect(gl, prev.x0, prev.y0, prev.x1, prev.y1);
    }
  }

  if (next && layout) {
    const w = next.x1 - next.x0;
    const h = next.y1 - next.y0;
    const ctx = getScratch(w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, -next.x0, -next.y0);
    drawTextLayout(ctx, layout);
    const src = ctx.getImageData(0, 0, w, h).data;
    const binaryAlpha = (ls.antiAlias ?? "smooth") === "none";
    if (binaryAlpha) {
      for (let i = 3; i < src.length; i += 4) src[i] = src[i] >= 128 ? 255 : 0;
    }
    if (gl.format === "rgba32f") {
      const dst = gl.data as Float32Array;
      const lut = linearLut();
      for (let y = 0; y < h; y++) {
        let s = y * w * 4;
        let o = ((next.y0 + y) * W + next.x0) * 4;
        for (let x = 0; x < w; x++, s += 4, o += 4) {
          const a = src[s + 3];
          if (a === 0) continue;
          dst[o] = lut[src[s]];
          dst[o + 1] = lut[src[s + 1]];
          dst[o + 2] = lut[src[s + 2]];
          dst[o + 3] = a / 255;
        }
      }
    } else {
      const dst = gl.data as Uint8Array;
      for (let y = 0; y < h; y++) {
        dst.set(
          src.subarray(y * w * 4, (y + 1) * w * 4),
          ((next.y0 + y) * W + next.x0) * 4,
        );
      }
    }
    renderer.markDirtyRect(gl, next.x0, next.y0, next.x1, next.y1);
  }

  renderer.flushLayer(gl);
  records.set(gl, {
    rect: next,
    data: gl.data,
    version: renderer.deferFlush ? -1 : gl.contentVersion,
  });
}

/**
 * Draw a TextLayerState onto the tool overlay canvas at its current
 * `ls.x / ls.y` position. Used during live drag so the GPU layer can be
 * hidden (skipping rasterization, GPU upload, and per-frame effect
 * re-encoding) while the user sees the text move in real time.
 */
export function drawTextEditOverlay(
  oc: HTMLCanvasElement,
  ls: TextLayerState,
): void {
  const c = oc.getContext("2d");
  if (!c) return;
  c.clearRect(0, 0, oc.width, oc.height);
  drawTextToCtx2d(c, ls);
}
