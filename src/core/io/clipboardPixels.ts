// Format-native clipboard pixels: cropping a source into a `ClipboardData`,
// converting it to a document's format on paste, and the 8-bit sRGB view
// written to the system clipboard for other apps.

import type { ClipboardData } from "@/core/store/clipboardStore";
import type { PixelFormat, RGBAColor } from "@/types";
import {
  convertF32ToRgba8,
  convertIndexedToRgba8,
} from "@/utils/pixelFormatConvert";
import { convertPixelBuffer } from "@/utils/convertPixelBuffer";
import { resolveNearestPaletteIndex } from "@/utils/indexedColorUtils";
import { matchPaletteIndices } from "@/wasm";

/** A pixel buffer positioned on the canvas. */
export interface ClipboardSource {
  format: PixelFormat;
  data: Uint8Array | Float32Array;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  /** The document palette (indexed8 sources). */
  palette?: readonly RGBAColor[];
}

/** Indexed pixels need at least this much selection to be copied (they have
 *  no partial alpha). */
const INDEXED_MASK_THRESHOLD = 128;

/**
 * Crop `src` to the canvas and to its visible, selected pixels. `mask` is a
 * canvas-sized selection (0–255) that scales alpha (soft edges); null copies
 * everything. Returns null when nothing is left.
 */
export function cropToClipboard(
  src: ClipboardSource,
  mask: Uint8Array | null,
  canvasWidth: number,
  canvasHeight: number,
): ClipboardData | null {
  const { format, data, width: lw, height: lh, offsetX: ox, offsetY: oy } = src;
  const x0 = Math.max(0, ox);
  const y0 = Math.max(0, oy);
  const x1 = Math.min(canvasWidth, ox + lw);
  const y1 = Math.min(canvasHeight, oy + lh);

  // Coverage of a canvas pixel: its alpha (or index) times the selection.
  const covered = (cx: number, cy: number): boolean => {
    const m = mask ? mask[cy * canvasWidth + cx] : 255;
    if (m === 0) return false;
    const i = (cy - oy) * lw + (cx - ox);
    if (format === "indexed8") {
      return data[i] !== 255 && m >= INDEXED_MASK_THRESHOLD;
    }
    return data[i * 4 + 3] > 0;
  };

  let minX = x1;
  let minY = y1;
  let maxX = -1;
  let maxY = -1;
  for (let cy = y0; cy < y1; cy++) {
    for (let cx = x0; cx < x1; cx++) {
      if (!covered(cx, cy)) continue;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
    }
  }
  if (maxX < 0) return null;

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const box = { width: bw, height: bh, offsetX: minX, offsetY: minY };

  if (format === "indexed8") {
    const out = new Uint8Array(bw * bh).fill(255);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const cx = minX + x;
        const cy = minY + y;
        if (covered(cx, cy)) out[y * bw + x] = data[(cy - oy) * lw + (cx - ox)];
      }
    }
    return { format, data: out, palette: [...(src.palette ?? [])], ...box };
  }

  const out =
    format === "rgba32f" ? new Float32Array(bw * bh * 4) : new Uint8Array(bw * bh * 4);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const cx = minX + x;
      const cy = minY + y;
      const m = mask ? mask[cy * canvasWidth + cx] : 255;
      if (m === 0) continue;
      const si = ((cy - oy) * lw + (cx - ox)) * 4;
      const di = (y * bw + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      const a = (data[si + 3] * m) / 255;
      out[di + 3] = format === "rgba32f" ? a : Math.round(a);
    }
  }
  return format === "rgba32f"
    ? { format, data: out as Float32Array, ...box }
    : { format: "rgba8", data: out as Uint8Array, ...box };
}

/** The clipboard pixels as straight-alpha sRGB bytes (system clipboard). */
export function clipboardToRgba8(clip: ClipboardData): Uint8Array {
  if (clip.format === "rgba32f") return convertF32ToRgba8(clip.data);
  if (clip.format === "indexed8") {
    return convertIndexedToRgba8(clip.data, [...clip.palette]);
  }
  return clip.data;
}

/**
 * The clipboard pixels in `format`, ready for a new layer of the clip's
 * size. Into indexed8, every colour maps to the nearest palette entry; an
 * indexed clip keeps an index whose colour is unchanged in the target
 * palette, so a copy/paste within one palette is exact.
 */
export async function clipboardToFormat(
  clip: ClipboardData,
  format: PixelFormat,
  palette: readonly RGBAColor[],
): Promise<Uint8Array | Float32Array> {
  if (format === "indexed8") {
    if (clip.format === "indexed8") {
      return remapIndices(clip.data, clip.palette, palette);
    }
    return matchToPalette(clipboardToRgba8(clip), palette);
  }
  if (clip.format === "indexed8") {
    return convertPixelBuffer(clip.data, "indexed8", format, [...clip.palette]);
  }
  return convertPixelBuffer(clip.data, clip.format, format, [...palette]);
}

/** Map indices from `from` to `to`: same colour at the same index stays,
 *  anything else goes to the nearest colour in `to`. */
function remapIndices(
  indices: Uint8Array,
  from: readonly RGBAColor[],
  to: readonly RGBAColor[],
): Uint8Array {
  const map = new Uint8Array(256).fill(255);
  for (let i = 0; i < 255; i++) {
    const c = from[i];
    if (!c) continue;
    const t = to[i];
    map[i] =
      t && t.r === c.r && t.g === c.g && t.b === c.b && t.a === c.a
        ? i
        : resolveNearestPaletteIndex(c.r, c.g, c.b, c.a, to);
  }
  const out = new Uint8Array(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = map[indices[i]];
  return out;
}

/** Nearest-palette-colour indices for straight RGBA bytes. Pixels under half
 *  opacity become transparent (indexed pixels have no partial alpha). */
function matchToPalette(
  rgba: Uint8Array,
  palette: readonly RGBAColor[],
): Promise<Uint8Array> {
  const src = rgba.slice();
  for (let i = 3; i < src.length; i += 4) {
    if (src[i] < 128) src[i] = 0;
  }
  return matchPaletteIndices(src, [...palette], 255);
}
