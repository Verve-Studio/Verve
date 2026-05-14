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
import { rasterizePathToLayer } from "@/ux/main/Canvas/pathRasterizer";
import {
  rasterizeFrameToLayer,
  ensureContentDecoded,
} from "@/ux/main/Canvas/frameRasterizer";
import {
  ensureLinkedDecoded,
  rasterizeLinkedToLayer,
  tryGetDecodedLinkedSource,
  tryGetLinkedSourceError,
} from "@/ux/main/Canvas/linkedLayerRasterizer";
import { activeScope } from "@/core/store/scope";
import { notificationStore } from "@/core/store/notificationStore";

/**
 * Tracks the parameter signature most recently baked into a linked layer's
 * GpuLayer buffer. The mirror-flags pass re-rasterises a linked layer only
 * when its signature changes — without this guard EVERY state change (a
 * neighbouring layer's opacity, a selection edit, …) would re-rasterise the
 * canvas-sized buffer and re-run the sRGB→linear pass for rgba32f docs.
 * That's the linked-layer perf cliff in f32 mode.
 *
 * Keyed by layer id at module scope so it survives renderer recreations
 * (the signature includes `pixelFormat`, which changes across a format
 * conversion remount — that's enough to force a re-rasterise after a
 * convert-color-mode → rgba32f). Cleared on layer destroy.
 */
const lastLinkedRasterSig = new Map<string, string>();

function linkedSig(
  ls: import("@/types").LinkedLayerState,
  pixelFormat: PixelFormat,
): string {
  return `${pixelFormat}|${ls.centerX}|${ls.centerY}|${ls.scaleX}|${ls.scaleY}|${ls.rotation}|${ls.refreshNonce}|${ls.source.absolutePath}`;
}

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
      } else if ("type" in ls && ls.type === "path") {
        const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
        rasterizePathToLayer(ls, gl, cw, ch, pixelFormat);
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
      } else if ("type" in ls && ls.type === "linked") {
        // Linked layers are canvas-sized — the source bitmap is painted in
        // via Canvas2D with the layer transform applied at rasterise time.
        // The decode runs through the rasteriser's `path:refreshNonce` cache;
        // if the bitmap is already there (e.g. the New Linked Layer handler
        // pre-warmed it), the first rasterise renders immediately. Otherwise
        // we paint a placeholder, kick the decode, and re-rasterise on ready.
        const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0, pixelFormat);
        map.set(ls.id, gl);
        // Seed the sig so the mirror-flags pass that runs further down in
        // this same effect tick doesn't kick a second redundant rasterise.
        lastLinkedRasterSig.set(ls.id, linkedSig(ls, pixelFormat));
        const flushAndRender = (): void => {
          if (!map.get(ls.id)) return;
          renderer.markFullDirty(gl);
          renderer.flushLayer(gl);
          // Belt-and-braces: bust the frame-skip cache so the post-rasterise
          // render isn't elided. Symptom this guards against: post-`Convert
          // Color Mode` to rgba32f, a bare linked layer rendered invisible
          // until hide/unhide forced a fresh sync pass.
          renderer.invalidateRenderCache();
          doRender();
        };
        void rasterizeLinkedToLayer(
          ls,
          gl,
          pixelFormat,
          swatches as RGBAColor[],
          cw,
          ch,
        ).then(flushAndRender);
        ensureLinkedDecoded(ls, window.api.readFileBase64, () => {
          if (!map.get(ls.id)) return;
          const err = tryGetLinkedSourceError(ls);
          if (err) notificationStore.error(err.errorMessage);
          if (!tryGetDecodedLinkedSource(ls)) return;
          void rasterizeLinkedToLayer(
            ls,
            gl,
            pixelFormat,
            swatches as RGBAColor[],
            cw,
            ch,
          ).then(flushAndRender);
        });
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
        lastLinkedRasterSig.delete(id);
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
      // Linked layers paint via Canvas2D + `convertRgba8ToF32`, producing
      // scene-linear floats. Tag as `linear-srgb` in rgba32f docs so the
      // renderer's IDT skips its sRGB decode — otherwise the linear floats
      // are re-decoded a second time at composite time and the layer
      // appears black/invisible (the "invisible linked layer after Convert
      // Color Mode to rgba32f" bug). The user can still override via the
      // layer-state colorSpace field if they really want a different tag.
      if ("type" in ls && ls.type === "linked" && pixelFormat === "rgba32f") {
        gl.colorSpace = ls.colorSpace ?? "linear-srgb";
      } else {
        gl.colorSpace =
          "colorSpace" in ls && ls.colorSpace ? ls.colorSpace : "auto";
      }
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
      } else if ("type" in ls && ls.type === "path") {
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        gl.offsetX = 0;
        gl.offsetY = 0;
        rasterizePathToLayer(ls, gl, cw, ch, pixelFormat);
        renderer.flushLayer(gl);
      } else if ("type" in ls && ls.type === "linked") {
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        // Skip the re-rasterise entirely when nothing relevant to this
        // linked layer has changed. Sync's effect re-fires for ANY state
        // change in any layer; without this gate every keystroke on a
        // neighbouring text layer (or any unrelated state update) would
        // re-run the canvas-sized Canvas2D paint + sRGB→linear conversion
        // — a multi-hundred-MB pass on an f32 doc.
        const sig = linkedSig(ls, pixelFormat);
        if (lastLinkedRasterSig.get(ls.id) === sig) continue;
        lastLinkedRasterSig.set(ls.id, sig);
        // Don't reset `gl.offsetX/Y` up-front. The Move tool shifts the
        // offset during drag for live preview; if we cleared it before the
        // async rasterise paints the new `centerX/Y` into the buffer, the
        // compositor would show the OLD buffer at offset 0 for one frame —
        // a visible snap-back. Reset the offset inside the rasterise
        // continuation so the swap is atomic.
        const flushAndRender = (): void => {
          if (!map.get(ls.id)) return;
          gl.offsetX = 0;
          gl.offsetY = 0;
          renderer.markFullDirty(gl);
          renderer.flushLayer(gl);
          renderer.invalidateRenderCache();
          doRender();
        };
        void rasterizeLinkedToLayer(
          ls,
          gl,
          pixelFormat,
          swatches as RGBAColor[],
          cw,
          ch,
        ).then(flushAndRender);
        ensureLinkedDecoded(ls, window.api.readFileBase64, () => {
          if (!map.get(ls.id)) return;
          const err = tryGetLinkedSourceError(ls);
          if (err) notificationStore.error(err.errorMessage);
          if (!tryGetDecodedLinkedSource(ls)) return;
          void rasterizeLinkedToLayer(
            ls,
            gl,
            pixelFormat,
            swatches as RGBAColor[],
            cw,
            ch,
          ).then(flushAndRender);
        });
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
