/**
 * Two effects gating indexed8 mode:
 *
 *   1. **Removed-swatch index remap.** When the user deletes a palette
 *      entry, every indexed8 layer's pixel buffer needs rewriting: pixels
 *      pointing at the removed index become 255 (void), pixels at higher
 *      indices decrement by one. The store sets
 *      `state.lastRemovedSwatchIndex` to trigger this; the hook clears the
 *      flag once the rewrite is done.
 *
 *   2. **Palette change → indexed8 re-flush.** Changing any swatch colour
 *      changes how every indexed8 texture resolves on the GPU. Re-flush
 *      every indexed8 layer with the new palette, then trigger one render.
 *
 * Both no-op outside indexed8 mode.
 */
import { useEffect } from "react";
import type { AppAction } from "@/core/store/AppContext";
import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import type { WebGPURenderer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import type { PixelFormat, RGBAColor } from "@/types";

export interface IndexedSwatchSyncParams {
  isActive: boolean;
  pixelFormat: PixelFormat;
  swatches: readonly RGBAColor[];
  lastRemovedSwatchIndex: number | null | undefined;
  rendererRef: React.RefObject<WebGPURenderer | null>;
  glLayersRef: React.RefObject<Map<string, GpuLayer>>;
  dispatch: React.Dispatch<AppAction>;
  doRender: () => void;
}

export function useIndexedSwatchSync(params: IndexedSwatchSyncParams): void {
  const {
    isActive,
    pixelFormat,
    swatches,
    lastRemovedSwatchIndex,
    rendererRef,
    glLayersRef,
    dispatch,
    doRender,
  } = params;

  // ── Removed-swatch index remap ────────────────────────────────────────────
  useEffect(() => {
    if (!isActive || pixelFormat !== "indexed8") return;
    if (lastRemovedSwatchIndex == null) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const removedIndex = lastRemovedSwatchIndex;
    for (const gl of glLayersRef.current.values()) {
      if (gl.format !== "indexed8") continue;
      const data = gl.data as Uint8Array;
      for (let i = 0; i < data.length; i++) {
        if (data[i] === removedIndex) {
          data[i] = 255;
        } else if (data[i] > removedIndex && data[i] < 255) {
          data[i]--;
        }
      }
    }
    dispatch({ type: "CLEAR_REMOVED_SWATCH_INDEX" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastRemovedSwatchIndex, isActive]);

  // ── Palette change → indexed8 re-flush ────────────────────────────────────
  useEffect(() => {
    if (!isActive || pixelFormat !== "indexed8") return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    for (const [, layer] of glLayersRef.current) {
      if (layer.format === "indexed8") {
        renderer.flushLayer(layer, swatches as RGBAColor[]);
      }
    }
    doRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swatches, isActive]);
}
