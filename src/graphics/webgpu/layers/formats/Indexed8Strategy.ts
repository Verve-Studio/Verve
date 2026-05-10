import type { PixelFormatStrategy } from "./PixelFormatStrategy";
import type { GpuLayer } from "../../types";
import type { LayerDirtyRect } from "../LayerTextureStore";
import { allocUint8 } from "@/core/store/memoryStore";
import { uploadTextureData } from "../../utils";
import { expandIndicesToRgba8 } from "../../rendering/indexedColorExpand";

/**
 * Indexed8 stores 1 byte/pixel: a palette index (0–254) or the transparent
 * sentinel (255). The GPU side is always rgba8unorm — uploads expand indices
 * via the current palette. Patch uploads aren't supported; any flush re-uploads
 * the entire layer.
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
    const expanded = expandIndicesToRgba8(
      layer.data as Uint8Array,
      palette ?? [],
    );
    uploadTextureData(
      device,
      texture,
      layer.layerWidth,
      layer.layerHeight,
      expanded,
    );
  },

  uploadPatch(device, texture, layer, _rect: LayerDirtyRect) {
    // No patch upload for indexed8 — the palette could change for any pixel,
    // so we always re-expand the whole layer. Behaves identically to the
    // pre-strategy code path.
    void _rect;
    this.uploadFull(device, texture, layer, undefined);
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
