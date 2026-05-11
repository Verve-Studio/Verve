import type { PixelFormatStrategy } from "./PixelFormatStrategy";
import type { GpuLayer } from "../../types";
import type { LayerDirtyRect } from "../LayerTextureStore";
import { allocUint8 } from "@/core/store/memoryStore";
import { uploadTextureData, uploadTexturePatch } from "../../utils";

export const Rgba8Strategy: PixelFormatStrategy = {
  format: "rgba8",
  bytesPerPixel: 4,
  gpuTextureFormat: "rgba8unorm",

  allocateBuffer(w, h) {
    return allocUint8(w * h * 4);
  },

  samplePixel(layer, x, y) {
    if (x < 0 || x >= layer.layerWidth || y < 0 || y >= layer.layerHeight)
      return [0, 0, 0, 0];
    const i = (y * layer.layerWidth + x) * 4;
    const d = layer.data as Uint8Array;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  },

  drawPixel(layer, x, y, r, g, b, a) {
    if (x < 0 || x >= layer.layerWidth || y < 0 || y >= layer.layerHeight)
      return;
    const i = (y * layer.layerWidth + x) * 4;
    const d = layer.data as Uint8Array;
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = a;
  },

  uploadFull(device, texture, layer) {
    uploadTextureData(
      device,
      texture,
      layer.layerWidth,
      layer.layerHeight,
      layer.data as Uint8Array,
    );
  },

  uploadPatch(device, texture, layer, rect: LayerDirtyRect) {
    uploadTexturePatch(
      device,
      texture,
      layer.layerWidth,
      rect.lx,
      rect.ly,
      rect.rx - rect.lx,
      rect.ry - rect.ly,
      layer.data as Uint8Array,
    );
  },

  reblitForGrow(src: GpuLayer, dstBuffer, dstWidth, copyX, copyY) {
    const dst = dstBuffer as Uint8Array;
    const srcData = src.data as Uint8Array;
    const stride = src.layerWidth * 4;
    for (let row = 0; row < src.layerHeight; row++) {
      const srcOff = row * stride;
      const dstOff = ((copyY + row) * dstWidth + copyX) * 4;
      dst.set(srcData.subarray(srcOff, srcOff + stride), dstOff);
    }
  },

  uploadAfterGrow(device, texture, width, height, data) {
    uploadTextureData(device, texture, width, height, data as Uint8Array);
  },
};
