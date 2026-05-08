import { exportJpeg } from "@/core/io/exportJpeg";
import { exportPng } from "@/core/io/exportPng";
import { exportTga } from "@/core/io/exportTga";
import { exportTiff } from "@/core/io/exportTiff";
import { exportWebp } from "@/core/io/exportWebp";
import { exportHdr } from "@/core/io/exportHdr";
import { exportTiff32 } from "@/core/io/exportTiff32";
import { exportDds } from "@/core/io/exportDds";
import { encodeExr } from "@/wasm";
import { DdsFormat, DdsHeaderMode } from "@/wasm";
import { displayStore } from "@/core/store/displayStore";
import type { AppState, ToneMappingOperator } from "@/types";
import { showOperationError } from "@/utils/userFeedback";
import { clampF32ToUint8 } from "@/utils/pixelFormatConvert";
import { buildRootLayerIds, getDescendantIds } from "@/utils/layerTree";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { ExportSettings } from "@/ux/modals/ExportDialog/ExportDialog";
import { useCallback, useState, type MutableRefObject } from "react";

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
        const bytes = exportPsd({ width: cw, height: ch, layers: psdNodes });
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

      let dataUrl: string;
      if (settings.format === "png") dataUrl = exportPng(data, width, height);
      else if (settings.format === "webp")
        dataUrl = exportWebp(data, width, height, {
          quality: settings.webpQuality,
        });
      else if (settings.format === "tga")
        dataUrl = exportTga(data, width, height);
      else if (settings.format === "tiff")
        dataUrl = exportTiff(data, width, height);
      else
        dataUrl = exportJpeg(data, width, height, {
          quality: settings.jpegQuality,
          background: settings.jpegBackground,
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
