// ─── Cell animation previews ──────────────────────────────────────────────────
//
// Onion skin and playback show flattened 8-bit sRGB previews of the frames
// that aren't on the canvas. The frame on the canvas is flattened by the GPU
// pipeline when it is saved and its preview is written next to the folder's
// frames (`.verve-previews/<file>.png`). A frame without an up-to-date preview
// (new folder, or edited outside Verve) is decoded and flattened on the CPU
// here: visible pixel layers with opacity, masks and normal blending.
// Adjustment layers and blend modes are left out until the frame is next
// saved from the canvas.

import type { DecodedDocument } from "@/core/io/documentDecode";
import { decodeExrDocument, decodeVerveDocument } from "@/core/io/documentDecode";
import { exportPng } from "@/core/io/exportPng";
import { cellPreviewPath, cellTypeOf, joinPath, CELL_PREVIEW_DIR } from "@/core/io/cellAnimationFiles";
import type { LayerPayload } from "@/core/store/layerPayload";
import type { LayerState, RGBAColor } from "@/types";
import { isCompositeLayer } from "@/types";
import {
  convertF32ToRgba8,
  linearToSrgbChannel,
  srgbToLinearChannel,
} from "@/utils/pixelFormatConvert";

/** Decode a cell file (by extension) into a document. */
export async function decodeCellFile(path: string): Promise<DecodedDocument> {
  const type = cellTypeOf(path);
  if (type === "verve") {
    return decodeVerveDocument(await window.api.openverveFile(path), path);
  }
  if (type === "exr") {
    return decodeExrDocument(await window.api.readFile(path));
  }
  throw new Error(`"${path}" isn't a .verve or .exr file.`);
}

// ─── CPU flatten ──────────────────────────────────────────────────────────────

const SRGB_TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = srgbToLinearChannel(i / 255);
  return t;
})();

/** Read one pixel of a payload as linear RGBA (alpha 0–1) into `out`. */
function makeSampler(
  p: LayerPayload,
  palette: readonly RGBAColor[],
): (lx: number, ly: number, out: Float32Array) => void {
  const w = p.geo?.layerWidth ?? 0;
  const d = p.data;
  if (p.format === "rgba32f") {
    return (lx, ly, out) => {
      const i = (ly * w + lx) * 4;
      out[0] = d[i]; out[1] = d[i + 1]; out[2] = d[i + 2]; out[3] = d[i + 3];
    };
  }
  if (p.format === "indexed8") {
    return (lx, ly, out) => {
      const idx = d[ly * w + lx];
      const c = idx === 255 ? undefined : palette[idx];
      if (!c) { out[3] = 0; return; }
      out[0] = SRGB_TO_LINEAR[c.r]; out[1] = SRGB_TO_LINEAR[c.g];
      out[2] = SRGB_TO_LINEAR[c.b]; out[3] = c.a / 255;
    };
  }
  return (lx, ly, out) => {
    const i = (ly * w + lx) * 4;
    out[0] = SRGB_TO_LINEAR[d[i]]; out[1] = SRGB_TO_LINEAR[d[i + 1]];
    out[2] = SRGB_TO_LINEAR[d[i + 2]]; out[3] = d[i + 3] / 255;
  };
}

function withGeo(p: LayerPayload, width: number, height: number): LayerPayload {
  return p.geo ? p : { ...p, geo: { layerWidth: width, layerHeight: height, offsetX: 0, offsetY: 0 } };
}

/** Flatten a decoded document to canvas-size 8-bit sRGB RGBA (approximate:
 *  see the file comment). */
export function flattenDecodedDocument(doc: DecodedDocument): Uint8Array {
  const { width: w, height: h, layers } = doc;
  const palette = doc.swatches ?? [];
  const byId = new Map(layers.map((l) => [l.id, l]));
  const parentOf = new Map<string, string>();
  for (const l of layers) {
    if ("childIds" in l && Array.isArray(l.childIds)) {
      for (const c of l.childIds) parentOf.set(c, l.id);
    }
  }
  const maskOf = new Map<string, string>();
  for (const l of layers) {
    if ("type" in l && l.type === "mask" && l.visible) maskOf.set(l.parentId, l.id);
  }

  // Premultiplied linear accumulator.
  const acc = new Float32Array(w * h * 4);
  const px = new Float32Array(4);
  const mk = new Float32Array(4);

  const drawLayer = (l: LayerState, opacity: number): void => {
    const raw = doc.layerData.layers.get(l.id);
    if (!raw || opacity <= 0) return;
    const p = withGeo(raw, w, h);
    const g = p.geo!;
    const sample = makeSampler(p, palette);
    const maskId = maskOf.get(l.id);
    const maskRaw = maskId ? doc.layerData.layers.get(maskId) : undefined;
    const maskP = maskRaw ? withGeo(maskRaw, w, h) : undefined;
    const maskSample = maskP ? makeSampler(maskP, palette) : null;
    const x0 = Math.max(0, g.offsetX);
    const y0 = Math.max(0, g.offsetY);
    const x1 = Math.min(w, g.offsetX + g.layerWidth);
    const y1 = Math.min(h, g.offsetY + g.layerHeight);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        sample(x - g.offsetX, y - g.offsetY, px);
        let a = px[3] * opacity;
        if (maskSample && maskP) {
          const mg = maskP.geo!;
          const mx = x - mg.offsetX;
          const my = y - mg.offsetY;
          if (mx < 0 || my < 0 || mx >= mg.layerWidth || my >= mg.layerHeight) {
            a = 0;
          } else {
            maskSample(mx, my, mk);
            // Masks are grey: luminance (linear R) × mask alpha.
            a *= linearToSrgbChannel(mk[0]) * mk[3];
          }
        }
        if (a <= 0) continue;
        const i = (y * w + x) * 4;
        const k = 1 - a;
        acc[i] = px[0] * a + acc[i] * k;
        acc[i + 1] = px[1] * a + acc[i + 1] * k;
        acc[i + 2] = px[2] * a + acc[i + 2] * k;
        acc[i + 3] = a + acc[i + 3] * k;
      }
    }
  };

  const visit = (id: string, opacity: number): void => {
    const l = byId.get(id);
    if (!l || !l.visible) return;
    if ("childIds" in l && Array.isArray(l.childIds)) {
      // Groups pass through; composite layers apply their opacity.
      const o = isCompositeLayer(l) ? opacity * (l.opacity ?? 1) : opacity;
      for (const c of l.childIds) visit(c, o);
      return;
    }
    if ("type" in l && (l.type === "mask" || l.type === "adjustment")) return;
    drawLayer(l, opacity * ("opacity" in l ? (l.opacity ?? 1) : 1));
  };
  for (const l of layers) {
    if (!parentOf.has(l.id)) visit(l.id, 1);
  }

  // Un-premultiply, then encode as sRGB bytes.
  for (let i = 0; i < acc.length; i += 4) {
    const a = acc[i + 3];
    if (a > 0) {
      acc[i] /= a;
      acc[i + 1] /= a;
      acc[i + 2] /= a;
    }
  }
  return convertF32ToRgba8(acc);
}

// ─── Bitmaps & sidecar previews ───────────────────────────────────────────────

/** Canvas-composite pixels (rgba8 sRGB bytes, or linear rgba32f floats) as
 *  8-bit sRGB RGBA. */
export function compositeToRgba8(data: Uint8Array | Float32Array): Uint8Array {
  return data instanceof Float32Array ? convertF32ToRgba8(data) : data;
}

export function rgbaToBitmap(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  const clamped = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength);
  return createImageBitmap(new ImageData(clamped, width, height));
}

/** Write the preview PNG for `file`. */
export async function writeCellPreview(
  folder: string,
  file: string,
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<void> {
  await window.api.makeDirectory(joinPath(folder, CELL_PREVIEW_DIR));
  await window.api.exportImage(
    cellPreviewPath(folder, file),
    await exportPng(rgba, width, height),
  );
}

/** The preview bitmap for `file`, when its PNG exists and is at least as
 *  new as the frame file. */
export async function readCellPreview(
  folder: string,
  file: string,
): Promise<ImageBitmap | null> {
  const previewPath = cellPreviewPath(folder, file);
  const [frame, preview] = await Promise.all([
    window.api.statPath(joinPath(folder, file)),
    window.api.statPath(previewPath),
  ]);
  if (!frame.exists || !preview.exists || preview.modified < frame.modified) {
    return null;
  }
  const bytes = await window.api.readFile(previewPath);
  return createImageBitmap(new Blob([bytes as BlobPart], { type: "image/png" }));
}

/** Decode and CPU-flatten a frame file, write its preview and return the
 *  bitmap. */
export async function buildCellPreview(
  folder: string,
  file: string,
): Promise<ImageBitmap> {
  const doc = await decodeCellFile(joinPath(folder, file));
  const rgba = flattenDecodedDocument(doc);
  await writeCellPreview(folder, file, rgba, doc.width, doc.height);
  return rgbaToBitmap(rgba, doc.width, doc.height);
}
