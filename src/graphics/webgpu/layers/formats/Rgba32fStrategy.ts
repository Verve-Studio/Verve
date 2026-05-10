import type { PixelFormatStrategy } from "./PixelFormatStrategy";
import type { GpuLayer } from "../../types";
import type { LayerDirtyRect } from "../LayerTextureStore";
import { allocFloat32 } from "@/core/store/memoryStore";
import { uploadF32TextureData, uploadF32TexturePatch } from "../../utils";

export const Rgba32fStrategy: PixelFormatStrategy = {
  format: "rgba32f",
  bytesPerPixel: 16,
  gpuTextureFormat: "rgba32float",

  allocateBuffer(w, h) {
    return allocFloat32(w * h * 4);
  },

  samplePixel(layer, x, y) {
    if (x < 0 || x >= layer.layerWidth || y < 0 || y >= layer.layerHeight)
      return [0, 0, 0, 0];
    const i = (y * layer.layerWidth + x) * 4;
    const d = layer.data as Float32Array;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  },

  // Caller passes values in the layer's native range. For rgba32f that's
  // 0.0–1.0 (scene-linear, can exceed 1 for HDR). Tools that have an sRGB
  // colour to write should pre-convert via srgbColorToLinearF32 (see
  // primitives.ts) before calling — this strategy stores values verbatim.
  drawPixel(layer, x, y, r, g, b, a) {
    if (x < 0 || x >= layer.layerWidth || y < 0 || y >= layer.layerHeight)
      return;
    const i = (y * layer.layerWidth + x) * 4;
    const d = layer.data as Float32Array;
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = a;
  },

  uploadFull(device, texture, layer) {
    uploadF32TextureData(
      device,
      texture,
      layer.layerWidth,
      layer.layerHeight,
      layer.data as Float32Array,
    );
  },

  uploadPatch(device, texture, layer, rect: LayerDirtyRect) {
    uploadF32TexturePatch(
      device,
      texture,
      layer.layerWidth,
      rect.lx,
      rect.ly,
      rect.rx - rect.lx,
      rect.ry - rect.ly,
      layer.data as Float32Array,
    );
  },

  reblitForGrow(src: GpuLayer, dstBuffer, dstWidth, copyX, copyY) {
    const dst = dstBuffer as Float32Array;
    const srcData = src.data as Float32Array;
    const stride = src.layerWidth * 4;
    for (let row = 0; row < src.layerHeight; row++) {
      const srcOff = row * stride;
      const dstOff = ((copyY + row) * dstWidth + copyX) * 4;
      dst.set(srcData.subarray(srcOff, srcOff + stride), dstOff);
    }
  },

  uploadAfterGrow(device, texture, width, height, data) {
    uploadF32TextureData(device, texture, width, height, data as Float32Array);
  },
};
