import type { PixelFormatStrategy } from "./PixelFormatStrategy";
import type { GpuLayer } from "../../types";
import type { RGBAColor } from "@/types";
import type { LayerDirtyRect } from "../LayerTextureStore";
import { allocUint8 } from "@/core/store/memoryStore";
import { uploadTextureData } from "../../utils";
import { expandIndicesToRgba8 } from "../../rendering/indexedColorExpand";

/** Palette each layer was last fully expanded with. */
const uploadedPalette = new WeakMap<GpuLayer, readonly RGBAColor[]>();

function samePalette(
  a: readonly RGBAColor[] | undefined,
  b: readonly RGBAColor[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.r !== y.r || x.g !== y.g || x.b !== y.b || x.a !== y.a) return false;
  }
  return true;
}

/**
 * Indexed8 stores 1 byte/pixel: a palette index (0–254) or the transparent
 * sentinel (255). The GPU side is always rgba8unorm — uploads expand indices
 * via the palette.
 *
 * A flush with an unchanged palette expands and uploads only the dirty
 * rect (it used to re-expand and upload the whole layer on every pencil
 * dab). A flush without a palette reuses the layer's last one instead of
 * expanding against an empty palette, which rendered the layer blank.
 */
export const Indexed8Strategy: PixelFormatStrategy = {
  format: "indexed8",
  bytesPerPixel: 1,
  gpuTextureFormat: "rgba8unorm",

  allocateBuffer(w, h) {
    const buf = allocUint8(w * h);
    buf.fill(255); // transparent sentinel
    return buf;
  },

  samplePixel(layer, x, y) {
    if (x < 0 || x >= layer.layerWidth || y < 0 || y >= layer.layerHeight)
      return [0, 0, 0, 0];
    const idx = (layer.data as Uint8Array)[y * layer.layerWidth + x];
    // Existing convention: indexed layers report [index, 0, 0, 255].
    return [idx, 0, 0, 255];
  },

  drawPixel(layer, x, y, r) {
    if (x < 0 || x >= layer.layerWidth || y < 0 || y >= layer.layerHeight)
      return;
    // Caller writes a palette index in the `r` slot (the 0–254 sentinel
    // protocol). g/b/a are ignored.
    (layer.data as Uint8Array)[y * layer.layerWidth + x] = r & 0xff;
  },

  uploadFull(device, texture, layer, palette) {
    const resolved = palette ?? uploadedPalette.get(layer) ?? [];
    uploadedPalette.set(layer, resolved);
    const expanded = expandIndicesToRgba8(layer.data as Uint8Array, resolved);
    uploadTextureData(
      device,
      texture,
      layer.layerWidth,
      layer.layerHeight,
      expanded,
    );
  },

  canPatch(layer, palette) {
    const last = uploadedPalette.get(layer);
    return last !== undefined && (palette === undefined || samePalette(palette, last));
  },

  uploadPatch(device, texture, layer, rect: LayerDirtyRect) {
    const palette = uploadedPalette.get(layer) ?? [];
    const w = rect.rx - rect.lx;
    const h = rect.ry - rect.ly;
    if (w <= 0 || h <= 0) return;
    const indices = layer.data as Uint8Array;
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      let src = (rect.ly + y) * layer.layerWidth + rect.lx;
      let dst = y * w * 4;
      for (let x = 0; x < w; x++, src++, dst += 4) {
        const idx = indices[src];
        if (idx < palette.length) {
          const col = palette[idx];
          out[dst] = col.r;
          out[dst + 1] = col.g;
          out[dst + 2] = col.b;
          out[dst + 3] = col.a;
        }
      }
    }
    device.queue.writeTexture(
      { texture, origin: { x: rect.lx, y: rect.ly } },
      out,
      { bytesPerRow: w * 4, rowsPerImage: h },
      { width: w, height: h },
    );
  },

  reblitForGrow(src: GpuLayer, dstBuffer, dstWidth, copyX, copyY) {
    const dst = dstBuffer as Uint8Array;
    const srcData = src.data as Uint8Array;
    const stride = src.layerWidth;
    for (let row = 0; row < src.layerHeight; row++) {
      const srcOff = row * stride;
      const dstOff = (copyY + row) * dstWidth + copyX;
      dst.set(srcData.subarray(srcOff, srcOff + stride), dstOff);
    }
  },

  // Indexed8 grow is followed by a flushLayer-with-palette call. There's
  // nothing useful we can upload here without the palette, so we skip — the
  // caller is responsible for flushing afterwards.
  uploadAfterGrow() {
    /* intentional no-op */
  },
};
