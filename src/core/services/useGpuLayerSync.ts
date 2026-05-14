/**
 * Keeps the renderer's GpuLayer map in lockstep with `state.layers`.
 *
 * Two responsibilities, each its own effect:
 *
 *   1. **Add / remove / re-rasterise.** When the layer-state list changes:
 *      - missing layers (text/shape/frame/mask/pixel) are created on the GPU
 *      - removed layers are destroyed
 *      - parametric layers (text/shape/frame) have their pixel buffers
 *        re-rasterised from their state-side definition
 *      - per-layer flags (opacity, visibility, blend mode, colour-space)
 *        are mirrored onto the GpuLayer
 *      - clone-stamp source is cleared if its host layer was removed
 *
 *   2. **Swatch re-rasterise.** Shape layers that reference palette
 *      indices via `strokeIndex`/`fillIndex` resolve their colour from
 *      `state.swatches` at rasterise time. When swatches change (palette
 *      edit, palette-cycle preview, swap), re-rasterise those shapes.
 *
 * Both effects no-op when the canvas tab isn't active.
 */
import { useEffect } from "react";
import type { AppState, PixelFormat, RGBAColor, Tool } from "@/types";
import type {
  GpuLayer,
  WebGPURenderer,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import { rasterizeTextToLayer } from "@/ux/main/Canvas/textRasterizer";
import { rasterizeShapeToLayer } from "@/ux/main/Canvas/shapeRasterizer";
import {
  rasterizeFrameToLayer,
  ensureContentDecoded,
} from "@/ux/main/Canvas/frameRasterizer";
import { activeScope } from "@/core/store/scope";

export interface GpuLayerSyncParams {
  isActive: boolean;
  rendererRef: React.RefObject<WebGPURenderer | null>;
  glLayersRef: React.RefObject<Map<string, GpuLayer>>;
  adjustmentMaskMapRef: React.RefObject<Map<string, GpuLayer>>;
  layers: AppState["layers"];
  swatches: readonly RGBAColor[];
  pixelFormat: PixelFormat;
  activeTool: Tool;
  doRender: () => void;
  /** When a text layer is being live-edited in the inline editor, skip its
   *  per-keystroke GPU rasterisation — the editor overlays the textarea on
   *  top of the canvas and the GpuLayer is hidden during edit, so rebuilding
   *  the bitmap and uploading it on every keypress is wasted work. The
   *  rasterisation happens once on edit-end. */
  editingTextLayerId?: string | null;
}

export function useGpuLayerSync(params: GpuLayerSyncParams): void {
  const {
    isActive,
    rendererRef,
    glLayersRef,
    adjustmentMaskMapRef,
    layers,
    swatches,
    pixelFormat,
    activeTool,
    doRender,
    editingTextLayerId,
  } = params;

  // ── Layer list sync ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!isActive) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const map = glLayersRef.current;

    // 1. Add missing GpuLayers for any state layer that doesn't have one yet.
    for (const ls of layers) {
      if ("type" in ls && ls.type === "adjustment") continue;
      if (map.has(ls.id)) continue;

      const cw = renderer.pixelWidth;
      const ch = renderer.pixelHeight;

      if ("type" in ls && ls.type === "text") {
        // Text layers are normally created imperatively in addTextLayer
        // before the dispatch; this branch is a defensive fallback.
        const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
        rasterizeTextToLayer(ls, gl);
        renderer.flushLayer(gl);
        map.set(ls.id, gl);
      } else if ("type" in ls && ls.type === "shape") {
        const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
        rasterizeShapeToLayer(ls, gl, cw, ch, pixelFormat, swatches as RGBAColor[]);
        renderer.flushLayer(gl);
        map.set(ls.id, gl);
      } else if ("type" in ls && ls.type === "frame") {
        const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
        rasterizeFrameToLayer(ls, gl, cw, ch);
        renderer.flushLayer(gl);
        map.set(ls.id, gl);
        if (ls.content) {
          const content = ls.content;
          ensureContentDecoded(content, () => {
            const cur = map.get(ls.id);
            if (!cur) return;
            rasterizeFrameToLayer(ls, cur, cw, ch);
            renderer.flushLayer(cur);
            doRender();
          });
        }
      } else if ("type" in ls && ls.type === "mask") {
        // Newly added mask layer — full-canvas white (fully reveal parent).
        const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
        gl.data.fill(255);
        renderer.flushLayer(gl);
        map.set(ls.id, gl);
      } else {
        // Pixel layers start at 128×128 centred on the canvas.
        const initW = Math.min(128, cw);
        const initH = Math.min(128, ch);
        const ox = Math.round((cw - initW) / 2);
        const oy = Math.round((ch - initH) / 2);
        const fmt = pixelFormat;
        const gl = renderer.createLayer(
          ls.id,
          ls.name,
          initW,
          initH,
          ox,
          oy,
          fmt,
        );
        if (fmt === "indexed8") (gl.data as Uint8Array).fill(255);
        map.set(ls.id, gl);
      }
    }

    // 2. Destroy GpuLayers whose state-side definitions have been removed.
    const stateIds = new Set(layers.map((l) => l.id));
    for (const [id, gl] of map) {
      if (!stateIds.has(id)) {
        renderer.destroyLayer(gl);
        map.delete(id);
      }
    }
    for (const [id, gl] of adjustmentMaskMapRef.current) {
      if (!stateIds.has(id)) {
        renderer.destroyLayer(gl);
        adjustmentMaskMapRef.current.delete(id);
      }
    }

    // 3. Clone-stamp source layer might have just been deleted — clear it
    //    so the tool doesn't crash on the next stamp.
    if (activeTool === "clone-stamp") {
      const cs = activeScope().cloneStamp;
      if (cs.source && !stateIds.has(cs.source.layerId)) {
        cs.clearSource();
      }
    }

    // 4. Mirror per-layer flags from state, and re-rasterise parametric
    //    layers whenever their state changes (text edit, shape resize, …).
    for (const ls of layers) {
      if ("type" in ls && ls.type === "adjustment") continue;
      const gl = map.get(ls.id);
      if (!gl) continue;
      gl.opacity = "opacity" in ls ? ls.opacity : 1;
      gl.visible = ls.visible;
      gl.blendMode = "blendMode" in ls ? ls.blendMode : "normal";
      gl.colorSpace =
        "colorSpace" in ls && ls.colorSpace ? ls.colorSpace : "auto";
      if ("type" in ls && ls.type === "text") {
        // Always reset offset — the move tool may have shifted it
        // temporarily for preview.
        gl.offsetX = 0;
        gl.offsetY = 0;
        // Skip the heavy rasterise + upload while this layer is being
        // live-edited. The editor textarea shows the text directly, the
        // GpuLayer is hidden during edit, and we re-rasterise once when
        // the editor closes (the dep on `editingTextLayerId` makes this
        // effect re-run on that transition).
        if (ls.id !== editingTextLayerId) {
          rasterizeTextToLayer(ls, gl);
          renderer.flushLayer(gl);
        }
      } else if ("type" in ls && ls.type === "shape") {
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        rasterizeShapeToLayer(ls, gl, cw, ch, pixelFormat, swatches as RGBAColor[]);
        renderer.flushLayer(gl);
      } else if ("type" in ls && ls.type === "frame") {
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        gl.offsetX = 0;
        gl.offsetY = 0;
        rasterizeFrameToLayer(ls, gl, cw, ch);
        renderer.flushLayer(gl);
        if (ls.content) {
          const content = ls.content;
          ensureContentDecoded(content, () => {
            const cur = map.get(ls.id);
            if (!cur) return;
            rasterizeFrameToLayer(ls, cur, cw, ch);
            renderer.flushLayer(cur);
            doRender();
          });
        }
      }
    }

    doRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, isActive, editingTextLayerId]);

  // ── Swatch re-rasterise for palette-indexed shapes ────────────────────────
  useEffect(() => {
    if (!isActive) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const cw = renderer.pixelWidth;
    const ch = renderer.pixelHeight;
    const map = glLayersRef.current;
    for (const ls of layers) {
      if (!("type" in ls) || ls.type !== "shape") continue;
      if (ls.strokeIndex === undefined && ls.fillIndex === undefined) continue;
      const gl = map.get(ls.id);
      if (!gl) continue;
      rasterizeShapeToLayer(ls, gl, cw, ch, pixelFormat, swatches as RGBAColor[]);
      renderer.flushLayer(gl);
    }
    doRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swatches, isActive]);
}
