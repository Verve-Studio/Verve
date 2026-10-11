/**
 * One-shot hydration of GPU layers when the canvas first mounts (or
 * remounts after a format change). Handles every pixel-data source we
 * support:
 *
 *   - **Pixel payloads** (`LayerDataBundle`): typed arrays in each layer's
 *     native format plus optional layer-local geometry — from file open,
 *     tab restore, history jumps, transforms and colour-mode conversion.
 *     The owner drops the bundle once the canvas is ready
 *     (`releaseMountedLayerData`), releasing the CPU copy.
 *   - **Adjustment-layer masks:** `bundle.adjustmentMasks`; populate
 *     `adjustmentMaskMap` not `glLayersRef`.
 *   - **New document, first pixel layer:** allocate full-canvas in the
 *     document format, apply the background-fill option (white / black /
 *     transparent) with palette mapping in indexed8 mode.
 *   - **Shape / mask layers from a saved doc:** rasterise the parametric
 *     definition straight into the new GpuLayer.
 *   - **New blank layer:** 128×128 centred (matches the new-layer button
 *     elsewhere).
 *
 * The flow is async because linked-layer sources decode asynchronously. The
 * `hasInitializedRef` guard prevents a re-fire on Strict-Mode double-invoke
 * and on rendererVersion bumps that don't represent a fresh renderer; the
 * `isStale()` closure aborts mid-flight if the renderer has been swapped
 * (tab change, format change, dev hot reload).
 *
 * Per CLAUDE.md: must NOT list `rendererRef.current` as a dep — use the
 * `hasInitializedRef` guard instead.
 */
import { useEffect, useRef } from "react";
import type { AppState, PixelFormat, RGBAColor } from "@/types";
import type {
  GpuLayer,
  WebGPURenderer,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import type { LayerDataBundle } from "@/core/store/layerPayload";
import { rasterizeShapeToLayer } from "@/ux/main/Canvas/shapeRasterizer";
import { rasterizePathToLayer } from "@/ux/main/Canvas/pathRasterizer";
import {
  ensureLinkedDecoded,
  rasterizeLinkedToLayer,
  tryGetDecodedLinkedSource,
  tryGetLinkedSourceError,
} from "@/ux/main/Canvas/linkedLayerRasterizer";
import { resolveNearestPaletteIndex } from "@/utils/indexedColorUtils";
import { notificationStore } from "@/core/store/notificationStore";

export interface GpuLayerInitParams {
  rendererRef: React.RefObject<WebGPURenderer | null>;
  /** Bumped by `useWebGPU` whenever a new renderer instance is created.
   *  Used as the effect dep so we re-hydrate after a format change. */
  rendererVersion: number;
  isActiveRef: React.RefObject<boolean>;
  glLayersRef: React.RefObject<Map<string, GpuLayer>>;
  adjustmentMaskMapRef: React.RefObject<Map<string, GpuLayer>>;
  swatchesRef: React.RefObject<readonly RGBAColor[]>;
  /** Snapshot of the layer-state list at mount. Read fresh from a ref so
   *  the async loop doesn't capture a stale closure. */
  initialLayers: AppState["layers"];
  initialPixelFormat: PixelFormat;
  initialBackgroundFill: AppState["canvas"]["backgroundFill"];
  /** Pixel data to hydrate from. Read-only here: StrictMode re-runs this
   *  effect, so the bundle must survive the first run. */
  initialLayerData: LayerDataBundle | undefined;
  /** Render trigger after init completes. */
  doRender: () => void;
  /** Mount-complete callback (called once init finishes for the active
   *  tab). */
  onReadyRef: React.RefObject<(() => void) | undefined>;
}

export function useGpuLayerInit(params: GpuLayerInitParams): void {
  const {
    rendererRef,
    rendererVersion,
    isActiveRef,
    glLayersRef,
    adjustmentMaskMapRef,
    swatchesRef,
    initialLayers,
    initialPixelFormat,
    initialBackgroundFill,
    initialLayerData,
    doRender,
    onReadyRef,
  } = params;

  const hasInitializedRef = useRef(false);

  useEffect(() => {
    if (hasInitializedRef.current) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (!initialLayers.length) return;
    hasInitializedRef.current = true;
    let cancelled = false;
    const isStale = (): boolean =>
      cancelled || rendererRef.current !== renderer;

    const init = async (): Promise<void> => {
      if (isStale()) return;
      const { pixelWidth: cw, pixelHeight: ch } = renderer;

      for (let i = 0; i < initialLayers.length; i++) {
        const ls = initialLayers[i];

        // ── Adjustment-layer masks ──────────────────────────────────────
        if ("type" in ls && ls.type === "adjustment") {
          const mask = initialLayerData?.adjustmentMasks.get(ls.id);
          if (mask) {
            const maskLayer = renderer.createLayer(
              `${ls.id}:adjustment-mask`,
              `${ls.name} Mask`,
              cw,
              ch,
              0,
              0,
            );
            maskLayer.data.set(mask);
            renderer.flushLayer(maskLayer);
            adjustmentMaskMapRef.current.set(ls.id, maskLayer);
          }
          continue;
        }

        let layer;
        const payload = initialLayerData?.layers.get(ls.id);

        // Pixel layer with no fresh data — preserve any pre-existing
        // GpuLayer (e.g. when the canvas remounts post-resize and the
        // layer map survived from before).
        if (!("type" in ls) && !payload) {
          const prev = glLayersRef.current.get(ls.id);
          if (prev) {
            layer = renderer.createLayer(
              ls.id,
              ls.name,
              prev.layerWidth,
              prev.layerHeight,
              prev.offsetX,
              prev.offsetY,
              prev.format,
            );
            layer.data.set(prev.data);
          }
        }

        if (payload) {
          const geo = payload.geo ?? {
            layerWidth: cw,
            layerHeight: ch,
            offsetX: 0,
            offsetY: 0,
          };
          layer = renderer.createLayer(
            ls.id,
            ls.name,
            geo.layerWidth,
            geo.layerHeight,
            geo.offsetX,
            geo.offsetY,
            payload.format,
          );
          if (payload.data.length === layer.data.length) {
            layer.data.set(payload.data);
          } else {
            notificationStore.error(
              `Layer "${ls.name}" could not be restored: its pixel data has the wrong size.`,
            );
          }
        } else if (i === 0 && !initialLayerData) {
          // New document — background layer covers the full canvas.
          const fmt = initialPixelFormat;
          layer = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0, fmt);
          const bg = initialBackgroundFill;
          if (fmt === "indexed8") {
            if (bg === "white" || bg === "black") {
              const tr = bg === "white" ? 255 : 0;
              const tg = bg === "white" ? 255 : 0;
              const tb = bg === "white" ? 255 : 0;
              const fillIdx = resolveNearestPaletteIndex(
                tr,
                tg,
                tb,
                255,
                swatchesRef.current as RGBAColor[],
              );
              (layer.data as Uint8Array).fill(fillIdx);
            } else {
              // transparent — void fill (255 = sentinel in indexed8).
              (layer.data as Uint8Array).fill(255);
            }
          } else {
            // Opaque = 255 in rgba8 but 1.0 in rgba32f (255 there is
            // 255× display white, which every blend then multiplied in).
            const one = fmt === "rgba32f" ? 1 : 255;
            if (bg === "white") {
              layer.data.fill(one);
            } else if (bg === "black") {
              for (let j = 0; j < layer.data.length; j += 4) {
                layer.data[j] = 0;
                layer.data[j + 1] = 0;
                layer.data[j + 2] = 0;
                layer.data[j + 3] = one;
              }
            }
          }
        } else if ("type" in ls && ls.type === "shape") {
          // Shape layers are full-canvas-sized (rasterized vector data).
          layer = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
          rasterizeShapeToLayer(
            ls,
            layer,
            cw,
            ch,
            initialPixelFormat,
            swatchesRef.current as RGBAColor[],
          );
        } else if ("type" in ls && ls.type === "path") {
          // Path layers are full-canvas-sized parametric vector data.
          layer = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
          rasterizePathToLayer(ls, layer, cw, ch, initialPixelFormat);
        } else if ("type" in ls && ls.type === "linked") {
          // Linked layers are canvas-sized — the source is painted into the
          // buffer via Canvas2D with the layer's transform applied at
          // rasterise time. Decode + rasterise the source file here so the
          // layer is ready on the very first frame.
          layer = renderer.createLayer(
            ls.id,
            ls.name,
            cw,
            ch,
            0,
            0,
            initialPixelFormat,
          );
          // Publish the freshly-created GpuLayer to the map BEFORE the
          // async awaits. Other render passes that may fire during the
          // decode (post-remount on a format conversion, parallel React
          // effects, …) would otherwise see a state-layer with no matching
          // GpuLayer and either skip it or cache a stale composite that
          // omits the linked child — the user-visible symptom was an
          // invisible composite after `Convert Color Mode` to rgba32f that
          // a hide/unhide cycle fixed. The buffer is zero-initialised so
          // any render in the gap shows transparent (correct), and the
          // `flushLayer` after the rasterise bumps contentVersion which
          // invalidates any composite cache entry computed against this
          // empty interim.
          glLayersRef.current.set(ls.id, layer);
          const linkedLayer = layer;
          const linkedLs = ls;
          // First-pass rasterise. If the source bitmap is cached (most
          // common path on a format-conversion remount — the module-level
          // `_bitmapCache` survives across renderers), this paints the
          // correct pixels immediately. Otherwise it paints a placeholder
          // and `ensureLinkedDecoded` re-rasterises once the decode
          // finishes.
          //
          // CRITICAL: do NOT await an `ensureLinkedDecoded`-wrapped
          // promise here. `ensureLinkedDecoded` is fire-and-forget —
          // when the bitmap is already cached it returns WITHOUT
          // invoking the ready callback, so any await would hang the
          // init loop forever and the layer would never reach the outer
          // flush/doRender, leaving it invisible until hide/unhide
          // forced a fresh sync pass.
          await rasterizeLinkedToLayer(
            linkedLs,
            linkedLayer,
            initialPixelFormat,
            swatchesRef.current as RGBAColor[],
            cw,
            ch,
          );
          const err = tryGetLinkedSourceError(linkedLs);
          if (err) notificationStore.error(err.errorMessage);
          renderer.markFullDirty(linkedLayer);
          renderer.flushLayer(linkedLayer);
          renderer.invalidateRenderCache();
          // Re-rasterise once if the decode completes after init exits.
          ensureLinkedDecoded(linkedLs, window.api.readFile, () => {
            if (isStale()) return;
            if (glLayersRef.current.get(linkedLs.id) !== linkedLayer) return;
            if (!tryGetDecodedLinkedSource(linkedLs)) return;
            void rasterizeLinkedToLayer(
              linkedLs,
              linkedLayer,
              initialPixelFormat,
              swatchesRef.current as RGBAColor[],
              cw,
              ch,
            ).then(() => {
              if (isStale()) return;
              if (glLayersRef.current.get(linkedLs.id) !== linkedLayer) return;
              renderer.markFullDirty(linkedLayer);
              renderer.flushLayer(linkedLayer);
              renderer.invalidateRenderCache();
              doRender();
            });
          });
        } else if ("type" in ls && ls.type === "mask") {
          // Mask layers full-canvas; init all-white (fully reveal parent).
          layer = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
          layer.data.fill(255);
        } else {
          // New blank layer — start 128×128 centred.
          const initW = Math.min(128, cw);
          const initH = Math.min(128, ch);
          const ox = Math.round((cw - initW) / 2);
          const oy = Math.round((ch - initH) / 2);
          const fmt = initialPixelFormat;
          layer = renderer.createLayer(
            ls.id,
            ls.name,
            initW,
            initH,
            ox,
            oy,
            fmt,
          );
          if (fmt === "indexed8") (layer.data as Uint8Array).fill(255);
        }

        layer.opacity = "opacity" in ls ? ls.opacity : 1;
        layer.visible = ls.visible;
        layer.blendMode = "blendMode" in ls ? ls.blendMode : "normal";
        layer.colorSpace =
          "colorSpace" in ls && ls.colorSpace ? ls.colorSpace : "auto";
        if (isStale()) return;
        renderer.flushLayer(
          layer,
          layer.format === "indexed8"
            ? (swatchesRef.current as RGBAColor[])
            : undefined,
        );
        glLayersRef.current.set(ls.id, layer);
      }

      if (isStale()) return;
      doRender();
      if (!isStale() && isActiveRef.current) {
        onReadyRef.current?.();
      }
    };

    init();
    return () => {
      cancelled = true;
      hasInitializedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendererVersion]);
}
