/**
 * Pushes per-pixel sampler info into `cursorStore` on every pointer-move so
 * the StatusBar can show:
 *   - indexed8 docs: "idx N · #RRGGBB" (palette index + resolved colour)
 *   - rgba32f docs: native float channel values (incl. HDR > 1.0)
 *   - rgba8 docs: nothing (cleared)
 *
 * Reads the active layer's pixel data directly from CPU memory
 * (`layer.data`) so it never touches the GPU. Pure callback — no effects,
 * no state, no refs of its own.
 */
import { useCallback } from "react";
import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import type { PixelFormat, RGBAColor } from "@/types";
import type { WebGPURenderer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { cursorStore } from "@/ux/main/Canvas/cursorStore";

export interface CursorPixelInfoParams {
  pixelFormat: PixelFormat;
  activeLayerId: string | null;
  rendererRef: React.RefObject<WebGPURenderer | null>;
  glLayersRef: React.RefObject<Map<string, GpuLayer>>;
  swatchesRef: React.RefObject<readonly RGBAColor[]>;
}

export type CursorPixelInfoUpdate = (pos: { x: number; y: number }) => void;

export function useCursorPixelInfo(
  params: CursorPixelInfoParams,
): CursorPixelInfoUpdate {
  const {
    pixelFormat,
    activeLayerId,
    rendererRef,
    glLayersRef,
    swatchesRef,
  } = params;

  return useCallback(
    (pos: { x: number; y: number }): void => {
      const renderer = rendererRef.current;
      const layer = activeLayerId
        ? glLayersRef.current.get(activeLayerId)
        : undefined;

      if (pixelFormat === "indexed8") {
        if (renderer && layer && layer.format === "indexed8") {
          const lx = Math.floor(pos.x) - layer.offsetX;
          const ly = Math.floor(pos.y) - layer.offsetY;
          if (
            lx >= 0 &&
            lx < layer.layerWidth &&
            ly >= 0 &&
            ly < layer.layerHeight
          ) {
            const idx = (layer.data as Uint8Array)[ly * layer.layerWidth + lx];
            const palette = swatchesRef.current;
            const color = idx < palette.length ? palette[idx] : null;
            cursorStore.setPixelInfo({
              index: idx,
              color: color
                ? { r: color.r, g: color.g, b: color.b, a: color.a }
                : null,
            });
          } else {
            cursorStore.setPixelInfo(null);
          }
        } else {
          cursorStore.setPixelInfo(null);
        }
        cursorStore.setPixelValues(null, false);
        return;
      }

      if (pixelFormat === "rgba32f") {
        if (cursorStore.pixelInfo !== null) cursorStore.setPixelInfo(null);
        if (renderer && layer && layer.format === "rgba32f") {
          const lx = Math.floor(pos.x) - layer.offsetX;
          const ly = Math.floor(pos.y) - layer.offsetY;
          if (
            lx >= 0 &&
            lx < layer.layerWidth &&
            ly >= 0 &&
            ly < layer.layerHeight
          ) {
            const base = (ly * layer.layerWidth + lx) * 4;
            const data = layer.data as Float32Array;
            cursorStore.setPixelValues(
              [data[base], data[base + 1], data[base + 2], data[base + 3]],
              true,
            );
          } else {
            cursorStore.setPixelValues(null, false);
          }
        } else {
          cursorStore.setPixelValues(null, false);
        }
        return;
      }

      // rgba8: clear both readouts.
      if (cursorStore.pixelInfo !== null) cursorStore.setPixelInfo(null);
      cursorStore.setPixelValues(null, false);
    },
    [pixelFormat, activeLayerId, rendererRef, glLayersRef, swatchesRef],
  );
}
