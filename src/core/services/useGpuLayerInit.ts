/**
 * One-shot hydration of GPU layers when the canvas first mounts (or
 * remounts after a format change). Handles every pixel-data source we
 * support:
 *
 *   - **Open-file path:** `data:raw/{f32,rgba8,indexed8};base64,…` blobs
 *     (synchronous decode via atob) or `…-ref;id=…` pointers into the
 *     in-process transfer stores (`f32TransferStore`, `u8TransferStore`)
 *     that avoid the base64 roundtrip.
 *   - **Legacy / image-import:** a PNG data URL, optionally with a
 *     `geo` blob carrying layer-local dimensions + offset.
 *   - **Adjustment-layer masks:** stored under `{id}:adjustment-mask`
 *     keys; populate `adjustmentMaskMap` not `glLayersRef`.
 *   - **New document, first pixel layer:** allocate full-canvas in the
 *     document format, apply the background-fill option (white / black /
 *     transparent) with palette mapping in indexed8 mode.
 *   - **Shape / mask layers from a saved doc:** rasterise the parametric
 *     definition straight into the new GpuLayer.
 *   - **New blank layer:** 128×128 centred (matches the new-layer button
 *     elsewhere).
 *
 * The whole flow is async because PNG decode is async. The
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
import {
  f32TransferStore,
  u8TransferStore,
} from "@/core/store/layerDataTransfer";
import { rasterizeShapeToLayer } from "@/ux/main/Canvas/shapeRasterizer";
import { decodePng } from "@/ux/main/Canvas/pngHelpers";
import { resolveNearestPaletteIndex } from "@/utils/indexedColorUtils";

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
  /** Per-layer base64 PNG data URLs (or transfer-store pointers). */
  initialLayerData: Map<string, string> | undefined;
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
          const maskData = initialLayerData?.get(`${ls.id}:adjustment-mask`);
          if (maskData) {
            const maskLayer = renderer.createLayer(
              `${ls.id}:adjustment-mask`,
              `${ls.name} Mask`,
              cw,
              ch,
              0,
              0,
            );
            if (maskData.startsWith("data:raw/rgba8-ref;id=")) {
              const u8 = u8TransferStore.take(
                maskData.slice("data:raw/rgba8-ref;id=".length),
              );
              if (u8) maskLayer.data.set(u8);
              renderer.flushLayer(maskLayer);
              adjustmentMaskMapRef.current.set(ls.id, maskLayer);
            } else {
              try {
                const rgba = await decodePng(maskData, cw, ch);
                if (isStale()) return;
                maskLayer.data.set(rgba);
                renderer.flushLayer(maskLayer);
                adjustmentMaskMapRef.current.set(ls.id, maskLayer);
              } catch (e) {
                renderer.destroyLayer(maskLayer);
                console.error("[Canvas] Failed to load adjustment mask PNG:", e);
              }
            }
          }
          continue;
        }

        let layer;
        const imageData = initialLayerData?.get(ls.id);

        // Pixel layer with no fresh data — preserve any pre-existing
        // GpuLayer (e.g. when the canvas remounts post-resize and the
        // layer map survived from before).
        if (!("type" in ls) && !imageData) {
          const prev = glLayersRef.current.get(ls.id);
          if (prev) {
            layer = renderer.createLayer(
              ls.id,
              ls.name,
              prev.layerWidth,
              prev.layerHeight,
              prev.offsetX,
              prev.offsetY,
            );
            layer.data.set(prev.data);
          }
        }

        if (imageData) {
          const geoKey = `${ls.id}:geo`;
          const geoJson = initialLayerData?.get(geoKey);

          if (imageData.startsWith("data:raw/f32-ref;id=")) {
            // rgba32f layer via in-process transfer store (no base64).
            const refId = imageData.slice("data:raw/f32-ref;id=".length);
            const f32 = f32TransferStore.take(refId);
            const geo = geoJson
              ? (JSON.parse(geoJson) as {
                  layerWidth: number;
                  layerHeight: number;
                  offsetX: number;
                  offsetY: number;
                })
              : { layerWidth: cw, layerHeight: ch, offsetX: 0, offsetY: 0 };
            layer = renderer.createLayer(
              ls.id,
              ls.name,
              geo.layerWidth,
              geo.layerHeight,
              geo.offsetX,
              geo.offsetY,
              "rgba32f",
            );
            if (f32) (layer.data as Float32Array).set(f32);
          } else if (imageData.startsWith("data:raw/rgba8-ref;id=")) {
            // rgba8 layer via in-process transfer store (no PNG roundtrip).
            const refId = imageData.slice("data:raw/rgba8-ref;id=".length);
            const u8 = u8TransferStore.take(refId);
            const geo = geoJson
              ? (JSON.parse(geoJson) as {
                  layerWidth: number;
                  layerHeight: number;
                  offsetX: number;
                  offsetY: number;
                })
              : { layerWidth: cw, layerHeight: ch, offsetX: 0, offsetY: 0 };
            layer = renderer.createLayer(
              ls.id,
              ls.name,
              geo.layerWidth,
              geo.layerHeight,
              geo.offsetX,
              geo.offsetY,
              "rgba8",
            );
            if (u8) layer.data.set(u8);
          } else if (imageData.startsWith("data:raw/f32;base64,")) {
            // rgba32f layer: base64-encoded raw Float32Array bytes.
            const b64 = imageData.slice("data:raw/f32;base64,".length);
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const f32 = new Float32Array(bytes.buffer);
            const geo = geoJson
              ? (JSON.parse(geoJson) as {
                  layerWidth: number;
                  layerHeight: number;
                  offsetX: number;
                  offsetY: number;
                })
              : { layerWidth: cw, layerHeight: ch, offsetX: 0, offsetY: 0 };
            layer = renderer.createLayer(
              ls.id,
              ls.name,
              geo.layerWidth,
              geo.layerHeight,
              geo.offsetX,
              geo.offsetY,
              "rgba32f",
            );
            (layer.data as Float32Array).set(f32);
          } else if (imageData.startsWith("data:raw/indexed8;base64,")) {
            // indexed8 layer: base64-encoded raw palette-index bytes.
            const b64 = imageData.slice("data:raw/indexed8;base64,".length);
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const geo = geoJson
              ? (JSON.parse(geoJson) as {
                  layerWidth: number;
                  layerHeight: number;
                  offsetX: number;
                  offsetY: number;
                })
              : { layerWidth: cw, layerHeight: ch, offsetX: 0, offsetY: 0 };
            layer = renderer.createLayer(
              ls.id,
              ls.name,
              geo.layerWidth,
              geo.layerHeight,
              geo.offsetX,
              geo.offsetY,
              "indexed8",
            );
            (layer.data as Uint8Array).set(bytes);
          } else if (geoJson) {
            // Layer-local PNG with geometry.
            const geo = JSON.parse(geoJson) as {
              layerWidth: number;
              layerHeight: number;
              offsetX: number;
              offsetY: number;
            };
            layer = renderer.createLayer(
              ls.id,
              ls.name,
              geo.layerWidth,
              geo.layerHeight,
              geo.offsetX,
              geo.offsetY,
            );
            try {
              const rgba = await decodePng(
                imageData,
                geo.layerWidth,
                geo.layerHeight,
              );
              if (isStale()) return;
              layer.data.set(rgba);
            } catch (e) {
              console.error("[Canvas] Failed to load layer PNG:", e);
            }
          } else {
            // Legacy / image import: PNG is canvas-sized.
            layer = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
            try {
              const rgba = await decodePng(imageData, cw, ch);
              if (isStale()) return;
              layer.data.set(rgba);
            } catch (e) {
              console.error("[Canvas] Failed to load layer PNG:", e);
            }
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
            if (bg === "white") {
              layer.data.fill(255);
            } else if (bg === "black") {
              for (let j = 0; j < layer.data.length; j += 4) {
                layer.data[j] = 0;
                layer.data[j + 1] = 0;
                layer.data[j + 2] = 0;
                layer.data[j + 3] = 255;
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
