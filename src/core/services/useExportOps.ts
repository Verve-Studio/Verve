import { exportJpeg } from "@/core/io/exportJpeg";
import { exportPng } from "@/core/io/exportPng";
import { exportTga } from "@/core/io/exportTga";
import { exportTiff } from "@/core/io/exportTiff";
import { exportWebp } from "@/core/io/exportWebp";
import { exportHdr } from "@/core/io/exportHdr";
import { exportTiff32 } from "@/core/io/exportTiff32";
import { exportDds } from "@/core/io/exportDds";
import { encodeExr, encodeExrLayers } from "@/wasm";
import { DdsFormat, DdsHeaderMode } from "@/wasm";
import { displayStore } from "@/ux/main/Canvas/displayStore";
import type { AppState, ToneMappingOperator } from "@/types";
import { showOperationError } from "@/utils/userFeedback";
import { statusMessageStore } from "@/core/store/statusMessageStore";
import { clampF32ToUint8 } from "@/utils/pixelFormatConvert";
import { buildRootLayerIds, getDescendantIds } from "@/utils/layerTree";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { ExportSettings } from "@/ux/modals/ExportDialog/ExportDialog";
import { useCallback, useState, type MutableRefObject } from "react";

function exportFileName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

// ─── Tone-mapping helper ──────────────────────────────────────────────────────

function toneMapToUint8(
  f32: Float32Array,
  operator: ToneMappingOperator,
  exposureEV: number,
): Uint8Array {
  const out = new Uint8Array(f32.length);
  const gain = Math.pow(2, exposureEV);
  for (let i = 0; i < f32.length; i += 4) {
    let r = f32[i] * gain;
    let g = f32[i + 1] * gain;
    let b = f32[i + 2] * gain;
    const a = f32[i + 3];
    if (operator === "reinhard") {
      r = r / (1 + r);
      g = g / (1 + g);
      b = b / (1 + b);
    }
    out[i] = Math.round(Math.min(1, Math.max(0, r)) * 255);
    out[i + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
    out[i + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255);
    out[i + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
  }
  return out;
}

interface UseExportOpsOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
}

interface UseExportOpsReturn {
  handleExportConfirm: (settings: ExportSettings) => Promise<void>;
  pendingLdrExport: ExportSettings | null;
  clearPendingLdrExport: () => void;
  confirmLdrExport: () => Promise<void>;
}

export function useExportOps({
  canvasHandleRef,
  stateRef,
}: UseExportOpsOptions): UseExportOpsReturn {
  const [pendingLdrExport, setPendingLdrExport] =
    useState<ExportSettings | null>(null);

  // Chunked Uint8Array → base64. Avoids "Maximum call stack size exceeded" from
  // String.fromCharCode(...largeArray) for multi-MB HDR/EXR/TIFF32 buffers.
  const bytesToBase64 = (bytes: Uint8Array): string => {
    const CHUNK = 8192;
    let s = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(
        null,
        Array.from(bytes.subarray(i, i + CHUNK)),
      );
    }
    return btoa(s);
  };

  const doExport = useCallback(
    async (settings: ExportSettings): Promise<void> => {
      const handle = canvasHandleRef.current;
      if (!handle)
        throw new Error(
          "Canvas renderer is not ready yet. Please try export again.",
        );

      // Per-layer "separate file" export: rasterise each picked layer (with
      // its attached adjustment/effect/filter children + mask) on its own,
      // then encode + write to "<stem>_<sanitised-name>.<ext>".  Supported
      // for the flat LDR formats and for the layer-capable formats (PSD,
      // EXR — each emitted file contains a single rasterized layer).
      const separateSupported =
        settings.format === "png" ||
        settings.format === "jpeg" ||
        settings.format === "webp" ||
        settings.format === "tga" ||
        settings.format === "tiff" ||
        settings.format === "psd" ||
        settings.format === "exr";
      if (settings.layerMode === "separate" && separateSupported) {
        const allLayers = stateRef.current.layers;
        const ids = settings.perLayerIds ?? [];
        if (ids.length === 0) {
          throw new Error("No layers selected for per-layer export.");
        }
        const sep = settings.filePath.includes("\\") ? "\\" : "/";
        const lastSep = Math.max(
          settings.filePath.lastIndexOf("/"),
          settings.filePath.lastIndexOf("\\"),
        );
        const dir =
          lastSep >= 0 ? settings.filePath.slice(0, lastSep) : "";
        const file = lastSep >= 0
          ? settings.filePath.slice(lastSep + 1)
          : settings.filePath;
        const dot = file.lastIndexOf(".");
        const stem = dot >= 0 ? file.slice(0, dot) : file;
        const ext = dot >= 0 ? file.slice(dot) : "";
        const sanitiseName = (n: string): string =>
          n.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_") || "layer";

        const cw = stateRef.current.canvas.width;
        const ch = stateRef.current.canvas.height;
        const isHdrDoc = stateRef.current.pixelFormat === "rgba32f";
        // PSD writer is dynamically imported; pull it once outside the loop.
        const psdMod =
          settings.format === "psd"
            ? await import("@/core/io/exportPsd")
            : null;

        for (const id of ids) {
          const ls = allLayers.find((l) => l.id === id);
          if (!ls) continue;
          // Build the per-layer rasterisation subset, mirroring the PSD
          // per-layer logic: this layer + adjustment children + mask
          // child. Composite layers also bring their descendants.
          const isComposite =
            "type" in ls && (ls as { type: string }).type === "composite";
          const adjChildren = allLayers.filter(
            (l) =>
              "type" in l &&
              (l as { type: string }).type === "adjustment" &&
              (l as { parentId?: string }).parentId === ls.id,
          );
          const maskChild = allLayers.find(
            (l) =>
              "type" in l &&
              (l as { type: string }).type === "mask" &&
              (l as { parentId?: string }).parentId === ls.id,
          );
          let subset: AppState["layers"][number][];
          if (isComposite) {
            const descIds = new Set(getDescendantIds(allLayers, ls.id));
            const descendants = allLayers.filter((l) => descIds.has(l.id));
            const descAttachments = allLayers.filter((l) => {
              if (!("type" in l)) return false;
              const t = (l as { type: string }).type;
              if (t !== "mask" && t !== "adjustment") return false;
              const pid = (l as { parentId?: string }).parentId;
              return pid !== undefined && descIds.has(pid);
            });
            subset = [ls, ...descendants, ...adjChildren, ...descAttachments];
          } else {
            subset = [ls, ...adjChildren];
            if (maskChild) subset.push(maskChild);
          }
          const flatLayer = await handle.rasterizeLayers(subset, "export");
          const w = flatLayer.width;
          const h = flatLayer.height;

          // EXR per-layer: write a single-image float EXR per layer.
          if (settings.format === "exr") {
            if (!(flatLayer.data instanceof Float32Array)) {
              throw new Error(
                "EXR per-layer export requires a rgba32f document.",
              );
            }
            const bytes = await encodeExr(
              flatLayer.data,
              w,
              h,
              settings.exrCompression,
              settings.exrHalfFloat ? 1 : 0,
            );
            const filename = `${stem}_${sanitiseName(ls.name)}${ext}`;
            const filePath = dir ? `${dir}${sep}${filename}` : filename;
            await window.api.exportImage(filePath, bytesToBase64(bytes));
            continue;
          }

          // PSD per-layer: write a single-layer PSD.
          if (settings.format === "psd" && psdMod) {
            const ldr: Uint8Array =
              flatLayer.data instanceof Float32Array
                ? isHdrDoc
                  ? toneMapToUint8(
                      flatLayer.data,
                      displayStore.toneMappingOperator,
                      displayStore.exposureEV,
                    )
                  : clampF32ToUint8(flatLayer.data)
                : flatLayer.data;
            const psdBytes = psdMod.exportPsd({
              width: cw,
              height: ch,
              layers: [
                {
                  kind: "layer",
                  name: ls.name,
                  visible: true,
                  opacity: 1,
                  blendMode: "normal",
                  pixels: ldr,
                  layerWidth: w,
                  layerHeight: h,
                  offsetX: 0,
                  offsetY: 0,
                },
              ],
            });
            const filename = `${stem}_${sanitiseName(ls.name)}${ext}`;
            const filePath = dir ? `${dir}${sep}${filename}` : filename;
            await window.api.exportImage(filePath, bytesToBase64(psdBytes));
            continue;
          }

          // Flat LDR formats.
          const fullPixels: Uint8Array =
            flatLayer.data instanceof Float32Array
              ? isHdrDoc
                ? toneMapToUint8(
                    flatLayer.data,
                    displayStore.toneMappingOperator,
                    displayStore.exposureEV,
                  )
                : clampF32ToUint8(flatLayer.data)
              : flatLayer.data;

          const iccProfile = stateRef.current.iccProfile;
          let dataUrl: string;
          if (settings.format === "png") {
            dataUrl = await exportPng(fullPixels, w, h, { iccProfile });
          } else if (settings.format === "webp") {
            dataUrl = exportWebp(fullPixels, w, h, {
              quality: settings.webpQuality,
            });
          } else if (settings.format === "tga") {
            dataUrl = exportTga(fullPixels, w, h);
          } else if (settings.format === "tiff") {
            dataUrl = exportTiff(fullPixels, w, h, { iccProfile });
          } else {
            dataUrl = exportJpeg(fullPixels, w, h, {
              quality: settings.jpegQuality,
              background: settings.jpegBackground,
              iccProfile,
            });
          }
          const filename = `${stem}_${sanitiseName(ls.name)}${ext}`;
          const filePath = dir ? `${dir}${sep}${filename}` : filename;
          await window.api.exportImage(
            filePath,
            dataUrl.replace(/^data:[^;]+;base64,/, ""),
          );
        }
        return;
      }

      // PDF — emits a single-page PDF. Text and shape layers export as live
      // PDF text and vector paths; everything else (raster / frame / group /
      // composite, plus text/shape layers whose look depends on attached
      // adjustments or masks) is rasterized and embedded as an RGB image.
      if (settings.format === "pdf") {
        const { exportPdf } = await import("@/core/io/exportPdf");
        type PdfExportNodeT = import("@/core/io/exportPdf").PdfExportNode;
        const layers = stateRef.current.layers;
        const cw = stateRef.current.canvas.width;
        const ch = stateRef.current.canvas.height;
        const isHdrDocPdf = stateRef.current.pixelFormat === "rgba32f";

        const hasAttachedChildren = (id: string): boolean =>
          layers.some(
            (l) =>
              "type" in l &&
              ((l as { type: string }).type === "adjustment" ||
                (l as { type: string }).type === "mask") &&
              (l as { parentId?: string }).parentId === id,
          );

        // Reuse the PSD per-layer rasterization recipe to bake a layer's
        // pixels (with its attached children) at canvas size, then crop to
        // the non-transparent bounding box.
        const rasterizeLayerCropped = async (
          ls: AppState["layers"][number],
        ): Promise<
          | {
              pixels: Uint8Array;
              width: number;
              height: number;
              x: number;
              y: number;
            }
          | null
        > => {
          const isComposite =
            "type" in ls && (ls as { type: string }).type === "composite";
          const adjChildren = layers.filter(
            (l) =>
              "type" in l &&
              (l as { type: string }).type === "adjustment" &&
              (l as { parentId?: string }).parentId === ls.id,
          );
          const maskChild = layers.find(
            (l) =>
              "type" in l &&
              (l as { type: string }).type === "mask" &&
              (l as { parentId?: string }).parentId === ls.id,
          );
          const lsForRaster = {
            ...ls,
            opacity: 1,
            visible: true,
            blendMode: "normal",
          } as typeof ls;
          const adjForRaster = adjChildren.map(
            (a) => ({ ...a, visible: true }) as typeof a,
          );
          let subset: AppState["layers"][number][];
          if (isComposite) {
            const descIds = new Set(getDescendantIds(layers, ls.id));
            const descendants = layers.filter((l) => descIds.has(l.id));
            const descAttachments = layers.filter((l) => {
              if (!("type" in l)) return false;
              const t = (l as { type: string }).type;
              if (t !== "mask" && t !== "adjustment") return false;
              const pid = (l as { parentId?: string }).parentId;
              return pid !== undefined && descIds.has(pid);
            });
            subset = [
              lsForRaster,
              ...descendants,
              ...adjForRaster,
              ...descAttachments,
            ];
          } else {
            subset = [lsForRaster, ...adjForRaster];
            if (maskChild) subset.push(maskChild);
          }
          const flatLayer = await handle.rasterizeLayers(subset, "export");
          const fullPixels: Uint8Array =
            flatLayer.data instanceof Float32Array
              ? clampF32ToUint8(flatLayer.data)
              : flatLayer.data;
          const fw = flatLayer.width;
          const fh = flatLayer.height;
          let minX = fw,
            minY = fh,
            maxX = -1,
            maxY = -1;
          for (let y = 0; y < fh; y++) {
            for (let x = 0; x < fw; x++) {
              if (fullPixels[(y * fw + x) * 4 + 3] !== 0) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
          if (maxX < 0) return null;
          const bw = maxX - minX + 1;
          const bh = maxY - minY + 1;
          const cropped = new Uint8Array(bw * bh * 4);
          for (let y = 0; y < bh; y++) {
            const srcRow = ((minY + y) * fw + minX) * 4;
            cropped.set(
              fullPixels.subarray(srcRow, srcRow + bw * 4),
              y * bw * 4,
            );
          }
          return {
            pixels: cropped,
            width: bw,
            height: bh,
            x: minX,
            y: minY,
          };
        };

        const textIsAsciiSafe = (s: string): boolean => {
          for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c > 126 && c !== 10 && c !== 13 && c !== 9) return false;
            if (c < 32 && c !== 10 && c !== 13 && c !== 9) return false;
          }
          return true;
        };

        const pdfNodes: PdfExportNodeT[] = [];

        // Walk all visible non-attachment layers in z-order (state.layers is
        // bottom-first). Group/composite "container" layers themselves don't
        // emit anything — their leaves do.
        for (const ls of layers) {
          if (!ls.visible) continue;
          if ("type" in ls) {
            const t = (ls as { type: string }).type;
            if (t === "mask" || t === "adjustment") continue;
            // Groups don't draw on their own.
            if (t === "group") continue;
            if (
              t === "text" &&
              !hasAttachedChildren(ls.id) &&
              textIsAsciiSafe((ls as import("@/types").TextLayerState).text)
            ) {
              pdfNodes.push({
                kind: "text",
                layer: ls as import("@/types").TextLayerState,
                layerOpacity: (ls as { opacity: number }).opacity,
                blendMode: (ls as { blendMode: import("@/types").BlendMode })
                  .blendMode,
              });
              continue;
            }
            if (t === "shape" && !hasAttachedChildren(ls.id)) {
              const sl = ls as import("@/types").ShapeLayerState;
              // A gradient fill can't yet round-trip as a PDF vector shading
              // dict — rasterise instead so the export still shows it.
              if (!sl.fillGradient) {
                pdfNodes.push({
                  kind: "shape",
                  layer: sl,
                  layerOpacity: (ls as { opacity: number }).opacity,
                  blendMode: (ls as { blendMode: import("@/types").BlendMode })
                    .blendMode,
                });
                continue;
              }
            }
            if (t === "path" && !hasAttachedChildren(ls.id)) {
              const pl = ls as import("@/types").PathLayerState;
              if (!pl.fillGradient) {
                pdfNodes.push({
                  kind: "path",
                  layer: pl,
                  layerOpacity: (ls as { opacity: number }).opacity,
                  blendMode: (ls as { blendMode: import("@/types").BlendMode })
                    .blendMode,
                });
                continue;
              }
            }
          }
          // Anything else — rasterize and embed.
          const raster = await rasterizeLayerCropped(ls);
          if (!raster) continue;
          pdfNodes.push({
            kind: "image",
            pixels: raster.pixels,
            width: raster.width,
            height: raster.height,
            x: raster.x,
            y: raster.y,
            layerOpacity: "opacity" in ls ? ls.opacity : 1,
            blendMode:
              "blendMode" in ls
                ? (ls as { blendMode: import("@/types").BlendMode }).blendMode
                : "normal",
          });
        }

        // If the document has nothing emittable, fall back to a flattened
        // single-image PDF so the user still gets a valid file.
        if (pdfNodes.length === 0) {
          const flatAll = await handle.rasterizeLayers(layers, "export");
          const ldr: Uint8Array =
            flatAll.data instanceof Float32Array
              ? isHdrDocPdf
                ? toneMapToUint8(
                    flatAll.data,
                    displayStore.toneMappingOperator,
                    displayStore.exposureEV,
                  )
                : clampF32ToUint8(flatAll.data)
              : flatAll.data;
          pdfNodes.push({
            kind: "image",
            pixels: ldr,
            width: flatAll.width,
            height: flatAll.height,
            x: 0,
            y: 0,
            layerOpacity: 1,
            blendMode: "normal",
          });
        }

        const bytes = await exportPdf({
          width: cw,
          height: ch,
          nodes: pdfNodes,
          iccProfile: stateRef.current.iccProfile,
        });
        await window.api.exportImage(settings.filePath, bytesToBase64(bytes));
        return;
      }

      // PSD — preserves per-layer pixel data + masks. Each emitted layer is
      // rasterized through the unified flatten-then-encode pipeline on its
      // own (with attached adjustment/effect/filter children) so non-
      // destructive effects are baked into the exported pixels, while layer
      // opacity / blend mode / visibility stay at the PSD layer level.
      if (settings.format === "psd") {
        const { exportPsd } = await import("@/core/io/exportPsd");
        type PsdExportNodeT =
          import("@/core/io/exportPsd").PsdExportNode;
        type PsdExportLayerT =
          import("@/core/io/exportPsd").PsdExportLayer;
        const layers = stateRef.current.layers;
        const cw = stateRef.current.canvas.width;
        const ch = stateRef.current.canvas.height;
        const isHdrDoc = stateRef.current.pixelFormat === "rgba32f";

        // "Flatten" mode → single rasterized "Background" layer.
        if (settings.layerMode === "single") {
          const flatAll = await handle.rasterizeLayers(layers, "export");
          const ldr: Uint8Array =
            flatAll.data instanceof Float32Array
              ? isHdrDoc
                ? toneMapToUint8(
                    flatAll.data,
                    displayStore.toneMappingOperator,
                    displayStore.exposureEV,
                  )
                : clampF32ToUint8(flatAll.data)
              : flatAll.data;
          const psdBytes = exportPsd({
            width: cw,
            height: ch,
            layers: [
              {
                kind: "layer",
                name: "Background",
                visible: true,
                opacity: 1,
                blendMode: "normal",
                pixels: ldr,
                layerWidth: flatAll.width,
                layerHeight: flatAll.height,
                offsetX: 0,
                offsetY: 0,
              },
            ],
          });
          await window.api.exportImage(
            settings.filePath,
            bytesToBase64(psdBytes),
          );
          return;
        }

        // Rasterize a single pixel-bearing layer (pixel/text/shape/frame or
        // a composite — composites bring their descendants along) through
        // the unified flatten-then-encode pipeline so attached
        // adjustment/effect/filter children bake into the exported pixels.
        // Layer-level opacity/blend/visibility are kept on the PSD entry
        // and neutralized during rasterization. Returns null if the layer
        // produced no opaque pixels.
        const buildPixelNode = async (
          ls: AppState["layers"][number],
        ): Promise<PsdExportLayerT | null> => {
          const isComposite =
            "type" in ls && (ls as { type: string }).type === "composite";
          const adjChildren = layers.filter(
            (l) =>
              "type" in l &&
              (l as { type: string }).type === "adjustment" &&
              (l as { parentId?: string }).parentId === ls.id,
          );
          const lsForRaster = {
            ...ls,
            opacity: 1,
            visible: true,
            blendMode: "normal",
          } as typeof ls;
          const adjForRaster = adjChildren.map(
            (a) => ({ ...a, visible: true }) as typeof a,
          );
          let subset: AppState["layers"][number][];
          if (isComposite) {
            const descIds = new Set(getDescendantIds(layers, ls.id));
            const descendants = layers.filter((l) => descIds.has(l.id));
            const descAttachments = layers.filter((l) => {
              if (!("type" in l)) return false;
              const t = (l as { type: string }).type;
              if (t !== "mask" && t !== "adjustment") return false;
              const pid = (l as { parentId?: string }).parentId;
              return pid !== undefined && descIds.has(pid);
            });
            subset = [
              lsForRaster,
              ...descendants,
              ...adjForRaster,
              ...descAttachments,
            ];
          } else {
            subset = [lsForRaster, ...adjForRaster];
          }
          const flatLayer = await handle.rasterizeLayers(subset, "export");
          const fullPixels: Uint8Array =
            flatLayer.data instanceof Float32Array
              ? clampF32ToUint8(flatLayer.data)
              : flatLayer.data;
          const fw = flatLayer.width;
          const fh = flatLayer.height;
          let minX = fw,
            minY = fh,
            maxX = -1,
            maxY = -1;
          for (let y = 0; y < fh; y++) {
            for (let x = 0; x < fw; x++) {
              if (fullPixels[(y * fw + x) * 4 + 3] !== 0) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
          if (maxX < 0) return null;
          const bw = maxX - minX + 1;
          const bh = maxY - minY + 1;
          const cropped = new Uint8Array(bw * bh * 4);
          for (let y = 0; y < bh; y++) {
            const srcRow = ((minY + y) * fw + minX) * 4;
            cropped.set(
              fullPixels.subarray(srcRow, srcRow + bw * 4),
              y * bw * 4,
            );
          }
          const maskLs = layers.find(
            (l) =>
              "type" in l &&
              l.type === "mask" &&
              (l as { parentId: string }).parentId === ls.id,
          );
          let mask: PsdExportLayerT["mask"];
          if (maskLs) {
            const m = handle.getLayerExportData(maskLs.id);
            if (m) {
              const single = new Uint8Array(m.width * m.height);
              for (let p = 0; p < m.width * m.height; p++)
                single[p] = m.pixels[p * 4];
              mask = {
                pixels: single,
                width: m.width,
                height: m.height,
                offsetX: m.offsetX,
                offsetY: m.offsetY,
              };
            }
          }
          return {
            kind: "layer",
            name: ls.name,
            visible: ls.visible,
            opacity: "opacity" in ls ? ls.opacity : 1,
            blendMode: "blendMode" in ls ? ls.blendMode : "normal",
            pixels: cropped,
            layerWidth: bw,
            layerHeight: bh,
            offsetX: minX,
            offsetY: minY,
            mask,
          };
        };

        // Recursively walk the layer tree, mirroring Verve's group structure
        // as PSD folders. Mask/adjustment layers are skipped (they're
        // bundled into their parent at rasterization time). Composites are
        // emitted as a single rasterized layer — we never recurse into a
        // composite's children because the composite already represents
        // their merged result.
        const buildNodes = async (
          ids: readonly string[],
        ): Promise<PsdExportNodeT[]> => {
          const out: PsdExportNodeT[] = [];
          for (const id of ids) {
            const ls = layers.find((l) => l.id === id);
            if (!ls) continue;
            if ("type" in ls) {
              const t = (ls as { type: string }).type;
              if (t === "mask" || t === "adjustment") continue;
              if (t === "group") {
                const g = ls as { name: string; visible: boolean; opacity: number; blendMode: import("@/types").BlendMode; collapsed: boolean; childIds: string[] };
                const children = await buildNodes(g.childIds);
                out.push({
                  kind: "group",
                  name: g.name,
                  visible: g.visible,
                  opacity: g.opacity,
                  blendMode: g.blendMode,
                  opened: !g.collapsed,
                  children,
                });
                continue;
              }
              if (t === "text") {
                // Round-trip the text layer as a live PSD text record —
                // Photoshop opens it as an editable type layer with the same
                // font / size / colour / paragraph attributes the artist set.
                const tls = ls as import("@/types").TextLayerState;
                const {
                  id: _id,
                  name,
                  visible,
                  opacity,
                  blendMode,
                  locked: _locked,
                  type: _type,
                  ...textFields
                } = tls;
                void _id;
                void _locked;
                void _type;
                out.push({
                  kind: "text",
                  name,
                  visible,
                  opacity,
                  blendMode,
                  text: textFields,
                });
                continue;
              }
            }
            const node = await buildPixelNode(ls);
            if (node) out.push(node);
          }
          return out;
        };

        const psdNodes = await buildNodes(buildRootLayerIds(layers));
        const hasLeaf = (nodes: PsdExportNodeT[]): boolean =>
          nodes.some(
            (n) =>
              n.kind === "layer" || (n.kind === "group" && hasLeaf(n.children)),
          );
        if (!hasLeaf(psdNodes)) {
          throw new Error(
            "PSD export needs at least one pixel layer. Rasterize text/shape/frame layers first.",
          );
        }
        const bytes = exportPsd({
          width: cw,
          height: ch,
          layers: psdNodes,
          // Source-doc colour depth: passed through so text fill/stroke
          // colours round-trip as FRGB (HDR-safe) when the Verve doc is
          // rgba32f, and as 0–255 RGB otherwise.
          bitsPerChannel:
            stateRef.current.pixelFormat === "rgba32f" ? 32 : 8,
        });
        const b64 = bytesToBase64(bytes);
        await window.api.exportImage(settings.filePath, b64);
        return;
      }

      const flat = await handle.rasterizeLayers(
        stateRef.current.layers,
        "export",
      );
      const { width, height } = flat;
      const isHdrDoc = stateRef.current.pixelFormat === "rgba32f";

      // HDR formats — always available for rgba32f docs
      if (settings.format === "exr") {
        if (!(flat.data instanceof Float32Array))
          throw new Error("EXR export requires a rgba32f document.");

        // Multi-layer EXR: when the user picked "Preserve layers" (the
        // default for multi-layer rgba32f docs), write each pixel layer as a
        // channel-named layer ("<Name>.R/G/B/A") in a single-part EXR.
        // Adjustment/mask children are baked into the owning pixel layer's
        // pixels via per-layer rasterization.  Group layers are skipped
        // (their leaves are emitted individually).
        const allLayers = stateRef.current.layers;
        const isPixelLayer = (
          l: AppState["layers"][number],
        ): boolean => {
          if (!("type" in l)) return true;
          const t = (l as { type?: string }).type;
          return (
            t === undefined ||
            t === "pixel" ||
            t === "text" ||
            t === "shape" ||
            t === "path" ||
            t === "frame" ||
            t === "composite"
          );
        };
        const pixelLayers = allLayers.filter(isPixelLayer);
        if (settings.layerMode === "multilayer" && pixelLayers.length > 1) {
          const exrLayers: { name: string; pixels: Float32Array }[] = [];
          for (const ls of pixelLayers) {
            const isComposite =
              "type" in ls && (ls as { type: string }).type === "composite";
            const adjChildren = allLayers.filter(
              (l) =>
                "type" in l &&
                (l as { type: string }).type === "adjustment" &&
                (l as { parentId?: string }).parentId === ls.id,
            );
            const maskChild = allLayers.find(
              (l) =>
                "type" in l &&
                (l as { type: string }).type === "mask" &&
                (l as { parentId?: string }).parentId === ls.id,
            );
            // Neutralize layer-level visibility/opacity/blend so we get the
            // raw layer content composited at canvas size.
            const lsForRaster = {
              ...ls,
              opacity: 1,
              visible: true,
              blendMode: "normal",
            } as typeof ls;
            const adjForRaster = adjChildren.map(
              (a) => ({ ...a, visible: true }) as typeof a,
            );
            let subset: AppState["layers"][number][];
            if (isComposite) {
              const descIds = new Set(getDescendantIds(allLayers, ls.id));
              const descendants = allLayers.filter((l) => descIds.has(l.id));
              const descAttachments = allLayers.filter((l) => {
                if (!("type" in l)) return false;
                const t = (l as { type: string }).type;
                if (t !== "mask" && t !== "adjustment") return false;
                const pid = (l as { parentId?: string }).parentId;
                return pid !== undefined && descIds.has(pid);
              });
              subset = [
                lsForRaster,
                ...descendants,
                ...adjForRaster,
                ...descAttachments,
              ];
            } else {
              subset = [lsForRaster, ...adjForRaster];
              if (maskChild) subset.push(maskChild);
            }
            const flatLayer = await handle.rasterizeLayers(subset, "export");
            if (!(flatLayer.data instanceof Float32Array)) {
              throw new Error(
                `EXR multi-layer export: layer "${ls.name}" did not produce float32 pixels.`,
              );
            }
            exrLayers.push({ name: ls.name, pixels: flatLayer.data });
          }
          const bytes = await encodeExrLayers(
            exrLayers,
            width,
            height,
            settings.exrCompression,
            settings.exrHalfFloat ? 1 : 0,
          );
          const b64 = bytesToBase64(bytes);
          await window.api.exportImage(settings.filePath, b64);
          return;
        }

        const bytes = await encodeExr(
          flat.data,
          width,
          height,
          settings.exrCompression,
          settings.exrHalfFloat ? 1 : 0,
        );
        const b64 = bytesToBase64(bytes);
        await window.api.exportImage(settings.filePath, b64);
        return;
      }
      if (settings.format === "hdr") {
        if (!(flat.data instanceof Float32Array))
          throw new Error("HDR export requires a rgba32f document.");
        const bytes = exportHdr(flat.data, width, height);
        const b64 = bytesToBase64(bytes);
        await window.api.exportImage(settings.filePath, b64);
        return;
      }
      if (settings.format === "tiff32") {
        if (!(flat.data instanceof Float32Array))
          throw new Error("TIFF32 export requires a rgba32f document.");
        const bytes = exportTiff32(flat.data, width, height);
        const b64 = bytesToBase64(bytes);
        await window.api.exportImage(settings.filePath, b64);
        return;
      }
      if (settings.format === "dds") {
        const { ddsCompression } = settings;
        const isHdrComp =
          ddsCompression === "bc6h" || ddsCompression === "rgba32f";
        const fmtMap: Record<string, number> = {
          bc1: DdsFormat.BC1,
          bc3: DdsFormat.BC3,
          bc7: DdsFormat.BC7,
          bc6h: DdsFormat.BC6H,
          rgba32f: DdsFormat.RGBA32F,
        };
        const fmt = fmtMap[ddsCompression];
        if (isHdrComp) {
          if (!(flat.data instanceof Float32Array))
            throw new Error(
              "BC6H/RGBA32F DDS export requires a rgba32f document.",
            );
          const dataUrl = await exportDds({
            pixels: flat.data,
            width,
            height,
            fmt,
            mipLevels: settings.ddsMipLevels,
            inputFormat: "rgba32f",
          });
          await window.api.exportImage(
            settings.filePath,
            dataUrl.replace(/^data:[^;]+;base64,/, ""),
          );
        } else {
          let ldrData: Uint8Array;
          if (isHdrDoc && flat.data instanceof Float32Array) {
            ldrData = toneMapToUint8(
              flat.data,
              displayStore.toneMappingOperator,
              displayStore.exposureEV,
            );
          } else {
            ldrData =
              flat.data instanceof Float32Array
                ? clampF32ToUint8(flat.data)
                : flat.data;
          }
          const dataUrl = await exportDds({
            pixels: ldrData,
            width,
            height,
            fmt,
            mipLevels: settings.ddsMipLevels,
            headerMode: DdsHeaderMode.AUTO,
            inputFormat: "rgba8",
          });
          await window.api.exportImage(
            settings.filePath,
            dataUrl.replace(/^data:[^;]+;base64,/, ""),
          );
        }
        return;
      }

      // LDR formats
      let data: Uint8Array;
      if (isHdrDoc && flat.data instanceof Float32Array) {
        data = toneMapToUint8(
          flat.data,
          displayStore.toneMappingOperator,
          displayStore.exposureEV,
        );
      } else {
        data =
          flat.data instanceof Float32Array
            ? clampF32ToUint8(flat.data)
            : flat.data;
      }

      const iccProfile = stateRef.current.iccProfile;
      let dataUrl: string;
      if (settings.format === "png")
        dataUrl = await exportPng(data, width, height, { iccProfile });
      else if (settings.format === "webp")
        dataUrl = exportWebp(data, width, height, {
          quality: settings.webpQuality,
        });
      else if (settings.format === "tga")
        dataUrl = exportTga(data, width, height);
      else if (settings.format === "tiff")
        dataUrl = exportTiff(data, width, height, { iccProfile });
      else
        dataUrl = exportJpeg(data, width, height, {
          quality: settings.jpegQuality,
          background: settings.jpegBackground,
          iccProfile,
        });
      await window.api.exportImage(
        settings.filePath,
        dataUrl.replace(/^data:[^;]+;base64,/, ""),
      );
    },
    [canvasHandleRef, stateRef],
  );

  const handleExportConfirm = useCallback(
    async (settings: ExportSettings): Promise<void> => {
      try {
        const isHdrDoc = stateRef.current.pixelFormat === "rgba32f";
        const isLdrFormat =
          settings.format !== "exr" &&
          settings.format !== "hdr" &&
          settings.format !== "tiff32" &&
          !(
            settings.format === "dds" &&
            (settings.ddsCompression === "bc6h" ||
              settings.ddsCompression === "rgba32f")
          );
        if (isHdrDoc && isLdrFormat) {
          // Gate behind warning dialog
          setPendingLdrExport(settings);
          return;
        }
        await doExport(settings);
        statusMessageStore.show(
          `Exported ${exportFileName(settings.filePath)}`,
        );
      } catch (error) {
        console.error("[useExportOps] Export failed:", error);
        showOperationError("Export failed.", error);
      }
    },
    [doExport, stateRef],
  );

  const confirmLdrExport = useCallback(async (): Promise<void> => {
    if (!pendingLdrExport) return;
    const settings = pendingLdrExport;
    setPendingLdrExport(null);
    try {
      await doExport(settings);
      statusMessageStore.show(`Exported ${exportFileName(settings.filePath)}`);
    } catch (error) {
      console.error("[useExportOps] Export failed:", error);
      showOperationError("Export failed.", error);
    }
  }, [pendingLdrExport, doExport]);

  const clearPendingLdrExport = useCallback((): void => {
    setPendingLdrExport(null);
  }, []);

  return {
    handleExportConfirm,
    pendingLdrExport,
    clearPendingLdrExport,
    confirmLdrExport,
  };
}
