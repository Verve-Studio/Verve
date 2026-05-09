import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import {
  u8TransferStore,
  f32TransferStore,
} from "@/core/store/layerDataTransfer";
import { decodeExrLayers } from "@/wasm";
import {
  IMAGE_EXTENSIONS,
  EXT_TO_MIME,
  loadImagePixels,
} from "@/core/io/imageLoader";
import { makeTabId, fileTitle, DEFAULT_SWATCHES } from "@/core/store/tabTypes";
import type { TabRecord, TabSnapshot } from "@/core/store/tabTypes";
import type {
  LayerState,
  BackgroundFill,
  AppState,
  SwatchGroup,
  PixelBrush,
  PixelFormat,
  ToneMappingOperator,
} from "@/types";
import type { AppAction } from "@/core/store/AppContext";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { showOperationError } from "@/utils/userFeedback";
import { activeScope, createDocumentScope, setActiveScope } from "@/core/store/scope";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseFileOpsOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  state: AppState;
  tabs: TabRecord[];
  activeTabId: string;
  setTabs: Dispatch<SetStateAction<TabRecord[]>>;
  setActiveTabId: Dispatch<SetStateAction<string>>;
  setPendingLayerData: Dispatch<SetStateAction<Map<string, string> | null>>;
  captureActiveSnapshot: () => TabSnapshot;
  serializeActiveTabPixels: () => Map<string, string> | null;
  handleSwitchTab: (toId: string) => void;
  dispatch: Dispatch<AppAction>;
  onRecentFilesUpdated?: (files: string[]) => void;
}

export interface UseFileOpsReturn {
  untitledCounter: number;
  handleNewConfirm: (settings: {
    width: number;
    height: number;
    backgroundFill: BackgroundFill;
    pixelFormat?: PixelFormat;
  }) => void;
  handleOpen: () => Promise<void>;
  handleOpenPath: (path: string) => Promise<void>;
  handleSave: (saveAs?: boolean) => Promise<void>;
  handleSaveACopy: () => Promise<void>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Encode a Float32Array as base64 using chunked approach to avoid stack overflow. */
function f32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer);
  let str = "";
  const CHUNK = 65536;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    str += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(str);
}

/** Encode a Uint8Array as base64 using chunked approach to avoid stack overflow. */
function uint8ToBase64(arr: Uint8Array): string {
  let str = "";
  const CHUNK = 65536;
  for (let i = 0; i < arr.length; i += CHUNK) {
    str += String.fromCharCode(...arr.subarray(i, i + CHUNK));
  }
  return btoa(str);
}

function isValidSwatchArray(
  val: unknown,
): val is { r: number; g: number; b: number; a: number }[] {
  if (!Array.isArray(val)) return false;
  for (const item of val) {
    if (typeof item !== "object" || item === null) return false;
    const { r, g, b, a } = item as Record<string, unknown>;
    if (
      !Number.isInteger(r) ||
      (r as number) < 0 ||
      (r as number) > 255 ||
      !Number.isInteger(g) ||
      (g as number) < 0 ||
      (g as number) > 255 ||
      !Number.isInteger(b) ||
      (b as number) < 0 ||
      (b as number) > 255 ||
      !Number.isInteger(a) ||
      (a as number) < 0 ||
      (a as number) > 255
    )
      return false;
  }
  return true;
}

function isValidSwatchGroupsArray(
  val: unknown,
  swatchCount: number,
): val is SwatchGroup[] {
  if (!Array.isArray(val)) return false;
  const names = new Set<string>();
  for (const item of val) {
    if (typeof item !== "object" || item === null) return false;
    const { id, name, swatchIndices } = item as Record<string, unknown>;
    if (typeof id !== "string" || id === "") return false;
    if (typeof name !== "string" || name === "") return false;
    if (names.has(name)) return false;
    names.add(name);
    if (!Array.isArray(swatchIndices)) return false;
    for (const idx of swatchIndices) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= swatchCount) return false;
    }
  }
  return true;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useFileOps({
  canvasHandleRef,
  state,
  tabs,
  activeTabId,
  setTabs,
  setActiveTabId,
  setPendingLayerData,
  captureActiveSnapshot,
  serializeActiveTabPixels,
  handleSwitchTab,
  dispatch,
  onRecentFilesUpdated,
}: UseFileOpsOptions): UseFileOpsReturn {
  const [untitledCounter, setUntitledCounter] = useState(0);

  const handleNewConfirm = useCallback(
    ({
      width,
      height,
      backgroundFill,
      pixelFormat,
    }: {
      width: number;
      height: number;
      backgroundFill: BackgroundFill;
      pixelFormat?: PixelFormat;
    }): void => {
      const snapshot = captureActiveSnapshot();
      const savedLayerData = serializeActiveTabPixels();
      const n = untitledCounter;
      setUntitledCounter(n + 1);
      const newId: string = makeTabId();
      const newScope = createDocumentScope();
      const fmt: PixelFormat = pixelFormat ?? "rgba8";
      const newSnapshot: TabSnapshot = {
        canvasWidth: width,
        canvasHeight: height,
        backgroundFill,
        layers: [
          {
            id: "layer-0",
            name: "Background",
            visible: true,
            opacity: 1,
            locked: false,
            blendMode: "normal",
          },
        ],
        activeLayerId: "layer-0",
        zoom: 1,
        swatches: DEFAULT_SWATCHES,
        swatchGroups: [],
        pixelBrushes: [],
        pixelFormat: fmt,
      };
      const updated: TabRecord[] = [
        ...tabs.map((t) =>
          t.id === activeTabId
            ? { ...t, snapshot, savedLayerData }
            : t,
        ),
        {
          id: newId,
          title: `Untitled-${n + 1}`,
          filePath: null,
          snapshot: newSnapshot,
          savedLayerData: null,
          scope: newScope,
          canvasKey: 1,
          tiledMode: false,
          showTileGrid: false,
          pixelFormat: fmt,
          exposureEV: 0,
          toneMappingOperator: "reinhard",
          animationMode: false,
        },
      ];
      setTabs(updated);
      setActiveScope(newScope);
      setActiveTabId(newId);
      activeScope().history.clear({ recaptureSnapshot: false });
      setPendingLayerData(null);
      dispatch({
        type: "NEW_CANVAS",
        payload: { width, height, backgroundFill, pixelFormat: fmt },
      });
    },
    [
      tabs,
      activeTabId,
      untitledCounter,
      captureActiveSnapshot,
      serializeActiveTabPixels,
      dispatch,
      setTabs,
      setActiveTabId,
      setPendingLayerData,
    ],
  );

  const openFromPath = useCallback(
    async (path: string): Promise<void> => {
      // ── Image file import ──────────────────────────────────────────────────
      const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
      if (ext === ".psd") {
        const { loadPsdLayers } = await import("@/core/io/psdLoader");
        const base64 = await window.api.readFileBase64(path);
        const bin = atob(base64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const psd = loadPsdLayers(buf.buffer);
        const hasAnyLeaf = (
          ns: import("@/core/io/psdLoader").PsdImportedNode[],
        ): boolean =>
          ns.some(
            (n) =>
              n.kind === "layer" ||
              (n.kind === "group" && hasAnyLeaf(n.children)),
          );
        if (!hasAnyLeaf(psd.nodes)) {
          showOperationError(
            "Could not open file.",
            "The PSD has no supported pixel layers.",
          );
          return;
        }
        const newId = makeTabId();
      const newScope = createDocumentScope();
        const layerData = new Map<string, string>();
        const layers: LayerState[] = [];
        // Recursively flatten the PSD tree into Verve's flat layer array.
        // Groups become GroupLayerState entries with childIds that mirror
        // PSD folder structure. Mask layers stay flat (parentId-linked) and
        // are NOT added to any parent group's childIds — they're attached
        // to a pixel layer regardless of where that layer is nested, which
        // matches the rest of Verve's mask handling.
        const flatten = (
          nodes: import("@/core/io/psdLoader").PsdImportedNode[],
          parentChildIds: string[] | null,
        ): void => {
          for (const node of nodes) {
            if (node.kind === "group") {
              const childIds: string[] = [];
              flatten(node.children, childIds);
              layers.push({
                id: node.id,
                name: node.name,
                visible: node.visible,
                opacity: 1,
                locked: false,
                blendMode: "normal",
                type: "group",
                collapsed: node.collapsed,
                childIds,
              });
              if (parentChildIds) parentChildIds.push(node.id);
              continue;
            }
            const psdLayer = node;
            const storeKey = `${newId}:${psdLayer.id}`;
            u8TransferStore.set(storeKey, psdLayer.pixels);
            layerData.set(psdLayer.id, `data:raw/rgba8-ref;id=${storeKey}`);
            layerData.set(
              `${psdLayer.id}:geo`,
              JSON.stringify({
                layerWidth: psdLayer.layerWidth,
                layerHeight: psdLayer.layerHeight,
                offsetX: psdLayer.offsetX,
                offsetY: psdLayer.offsetY,
              }),
            );
            layers.push({
              id: psdLayer.id,
              name: psdLayer.name,
              visible: psdLayer.visible,
              opacity: psdLayer.opacity,
              locked: false,
              blendMode: psdLayer.blendMode,
            });
            if (parentChildIds) parentChildIds.push(psdLayer.id);
            // Optional mask child. Mask pixel data is single-channel — encode
            // it as 4-channel grey RGBA (tools downstream still expect RGBA).
            if (psdLayer.mask) {
              const maskId = `${psdLayer.id}-mask`;
              const m = psdLayer.mask;
              const rgba = new Uint8Array(m.width * m.height * 4);
              for (let p = 0; p < m.width * m.height; p++) {
                const v = m.pixels[p];
                const j = p * 4;
                rgba[j] = v;
                rgba[j + 1] = v;
                rgba[j + 2] = v;
                rgba[j + 3] = 255;
              }
              const maskStoreKey = `${newId}:${maskId}`;
              u8TransferStore.set(maskStoreKey, rgba);
              layerData.set(
                maskId,
                `data:raw/rgba8-ref;id=${maskStoreKey}`,
              );
              layerData.set(
                `${maskId}:geo`,
                JSON.stringify({
                  layerWidth: m.width,
                  layerHeight: m.height,
                  offsetX: m.offsetX,
                  offsetY: m.offsetY,
                }),
              );
              layers.push({
                id: maskId,
                name: "Mask",
                visible: true,
                type: "mask",
                parentId: psdLayer.id,
              });
            }
          }
        };
        flatten(psd.nodes, null);
        const title = fileTitle(path);
        const newSnapshot: TabSnapshot = {
          canvasWidth: psd.width,
          canvasHeight: psd.height,
          backgroundFill: "transparent",
          layers,
          activeLayerId: layers[layers.length - 1]?.id ?? null,
          zoom: 1,
          swatches: DEFAULT_SWATCHES,
          swatchGroups: [],
          pixelBrushes: [],
          pixelFormat: "rgba8",
        };
        const snapshot = captureActiveSnapshot();
        const savedLayerData = serializeActiveTabPixels();
        const updated: TabRecord[] = [
          ...tabs.map((t) =>
            t.id === activeTabId
              ? { ...t, snapshot, savedLayerData }
              : t,
          ),
          {
            id: newId,
            title,
            filePath: path,
            snapshot: newSnapshot,
            savedLayerData: layerData,
            scope: newScope,
            canvasKey: 1,
            tiledMode: false,
            showTileGrid: false,
            pixelFormat: "rgba8" as PixelFormat,
            exposureEV: 0,
            toneMappingOperator: "reinhard",
            animationMode: false,
          },
        ];
        setTabs(updated);
        setActiveScope(newScope);
        setActiveTabId(newId);
        activeScope().history.clear({ recaptureSnapshot: false });
        setPendingLayerData(null);
        dispatch({
          type: "SWITCH_TAB",
          payload: {
            width: psd.width,
            height: psd.height,
            backgroundFill: "transparent",
            layers,
            activeLayerId: newSnapshot.activeLayerId,
            zoom: 1,
            tiledMode: false,
            showTileGrid: false,
            swatches: newSnapshot.swatches,
            swatchGroups: newSnapshot.swatchGroups,
          },
        });
        const updatedRecent = await window.api.addRecentFile(path);
        onRecentFilesUpdated?.(updatedRecent);
        if (psd.hadUnsupportedLayers) {
          showOperationError(
            "Some PSD content was skipped.",
            "Verve only imports rasterized pixel layers + masks. Text, shape, smart object, and adjustment layers in this PSD have been omitted.",
          );
        }
        return;
      }
      // ── Multi-layer EXR ───────────────────────────────────────────────
      if (ext === ".exr") {
        const base64 = await window.api.readFileBase64(path);
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const exr = await decodeExrLayers(bytes);
        if (exr.layers.length > 1) {
          const newId = makeTabId();
      const newScope = createDocumentScope();
          const layerData = new Map<string, string>();
          const layers: LayerState[] = [];
          // Track names already used so we can disambiguate duplicates.
          const seenNames = new Map<string, number>();
          exr.layers.forEach((L, i) => {
            const layerId = `layer-${i}`;
            let name = L.name.trim() || `Layer ${i + 1}`;
            const n = seenNames.get(name) ?? 0;
            if (n > 0) name = `${name} (${n + 1})`;
            seenNames.set(name, n + 1);
            const storeKey = `${newId}:${layerId}`;
            f32TransferStore.set(storeKey, L.pixels);
            layerData.set(layerId, `data:raw/f32-ref;id=${storeKey}`);
            layerData.set(
              `${layerId}:geo`,
              JSON.stringify({
                layerWidth: L.width,
                layerHeight: L.height,
                offsetX: L.offsetX,
                offsetY: L.offsetY,
              }),
            );
            layers.push({
              id: layerId,
              name,
              visible: true,
              opacity: 1,
              locked: false,
              blendMode: "normal",
            });
          });
          const title = fileTitle(path);
          const newSnapshot: TabSnapshot = {
            canvasWidth: exr.canvasWidth,
            canvasHeight: exr.canvasHeight,
            backgroundFill: "transparent",
            layers,
            activeLayerId: layers[layers.length - 1]?.id ?? null,
            zoom: 1,
            swatches: DEFAULT_SWATCHES,
            swatchGroups: [],
            pixelBrushes: [],
            pixelFormat: "rgba32f",
          };
          const snapshot = captureActiveSnapshot();
          const savedLayerData = serializeActiveTabPixels();
          const updated: TabRecord[] = [
            ...tabs.map((t) =>
              t.id === activeTabId
                ? { ...t, snapshot, savedLayerData }
                : t,
            ),
            {
              id: newId,
              title,
              filePath: path,
              snapshot: newSnapshot,
              savedLayerData: layerData,
            scope: newScope,
              canvasKey: 1,
              tiledMode: false,
              showTileGrid: false,
              pixelFormat: "rgba32f" as PixelFormat,
              exposureEV: 0,
              toneMappingOperator: "reinhard",
              animationMode: false,
            },
          ];
          setTabs(updated);
          setActiveScope(newScope);
          setActiveTabId(newId);
          activeScope().history.clear({ recaptureSnapshot: false });
          setPendingLayerData(null);
          dispatch({
            type: "SWITCH_TAB",
            payload: {
              width: exr.canvasWidth,
              height: exr.canvasHeight,
              backgroundFill: "transparent",
              layers,
              activeLayerId: newSnapshot.activeLayerId,
              zoom: 1,
              tiledMode: false,
              showTileGrid: false,
              pixelFormat: "rgba32f",
              swatches: newSnapshot.swatches,
              swatchGroups: newSnapshot.swatchGroups,
            },
          });
          const updatedRecent = await window.api.addRecentFile(path);
          onRecentFilesUpdated?.(updatedRecent);
          return;
        }
        // Single-layer EXR — fall through to the standard image-import path.
      }

      if (IMAGE_EXTENSIONS.has(ext)) {
        const base64 = await window.api.readFileBase64(path);
        const mime = EXT_TO_MIME[ext] ?? "image/png";
        const loaded = await loadImagePixels(`data:${mime};base64,${base64}`);
        const { width, height } = loaded;

        if (loaded.isHdr) {
          // HDR file — create a rgba32f tab, store float pixels via f32TransferStore
          const layerId = "layer-0";
          const f32Data = loaded.data as Float32Array;
          const layerDataKey = `f32:${layerId}`;
          // Encode float pixels as data URL for savedLayerData map
          const u8 = new Uint8Array(f32Data.buffer);
          let binary = "";
          const CHUNK = 8192;
          for (let i = 0; i < u8.length; i += CHUNK) {
            binary += String.fromCharCode(...u8.subarray(i, i + CHUNK));
          }
          const rawB64 = btoa(binary);
          const layerData = new Map([
            [layerId, `data:raw/f32;base64,${rawB64}`],
          ]);
          const layers: LayerState[] = [
            {
              id: layerId,
              name: "Background",
              visible: true,
              opacity: 1,
              locked: false,
              blendMode: "normal",
            },
          ];
          const title = fileTitle(path);
          const newSnapshot: TabSnapshot = {
            canvasWidth: width,
            canvasHeight: height,
            backgroundFill: "transparent",
            layers,
            activeLayerId: layerId,
            zoom: 1,
            swatches: DEFAULT_SWATCHES,
            swatchGroups: [],
            pixelBrushes: [],
            pixelFormat: "rgba32f",
          };
          const snapshot = captureActiveSnapshot();
          const savedLayerData = serializeActiveTabPixels();
          const newId = makeTabId();
      const newScope = createDocumentScope();
          const updated: TabRecord[] = [
            ...tabs.map((t) =>
              t.id === activeTabId
                ? { ...t, snapshot, savedLayerData }
                : t,
            ),
            {
              id: newId,
              title,
              filePath: null,
              snapshot: newSnapshot,
              savedLayerData: layerData,
            scope: newScope,
              canvasKey: 1,
              tiledMode: false,
              showTileGrid: false,
              pixelFormat: "rgba32f" as PixelFormat,
              exposureEV: 0,
              toneMappingOperator: "reinhard",
              animationMode: false,
            },
          ];
          setTabs(updated);
          setActiveScope(newScope);
          setActiveTabId(newId);
          activeScope().history.clear({ recaptureSnapshot: false });
          setPendingLayerData(null);
          dispatch({
            type: "SWITCH_TAB",
            payload: {
              width,
              height,
              backgroundFill: "transparent",
              layers,
              activeLayerId: layerId,
              zoom: 1,
              tiledMode: false,
              showTileGrid: false,
              pixelFormat: "rgba32f",
              swatches: newSnapshot.swatches,
              swatchGroups: newSnapshot.swatchGroups,
            },
          });
          const updatedRecent = await window.api.addRecentFile(path);
          onRecentFilesUpdated?.(updatedRecent);
          void layerDataKey; // used in savedLayerData map above
          return;
        }

        const data = loaded.data as Uint8Array;
        const layerId = "layer-0";
        const newId = makeTabId();
      const newScope = createDocumentScope();
        const storeKey = `${newId}:${layerId}`;
        u8TransferStore.set(storeKey, data);
        const layerData = new Map([
          [layerId, `data:raw/rgba8-ref;id=${storeKey}`],
        ]);
        const layers: LayerState[] = [
          {
            id: layerId,
            name: "Background",
            visible: true,
            opacity: 1,
            locked: false,
            blendMode: "normal",
          },
        ];
        const title = fileTitle(path);
        const newSnapshot: TabSnapshot = {
          canvasWidth: width,
          canvasHeight: height,
          backgroundFill: "transparent",
          layers,
          activeLayerId: layerId,
          zoom: 1,
          swatches: DEFAULT_SWATCHES,
          swatchGroups: [],
          pixelBrushes: [],
          pixelFormat: "rgba8",
        };
        const snapshot = captureActiveSnapshot();
        const savedLayerData = serializeActiveTabPixels();
        const updated: TabRecord[] = [
          ...tabs.map((t) =>
            t.id === activeTabId
              ? { ...t, snapshot, savedLayerData }
              : t,
          ),
          {
            id: newId,
            title,
            filePath: null,
            snapshot: newSnapshot,
            savedLayerData: layerData,
            scope: newScope,
            canvasKey: 1,
            tiledMode: false,
            showTileGrid: false,
            pixelFormat: "rgba8" as PixelFormat,
            exposureEV: 0,
            toneMappingOperator: "reinhard",
            animationMode: false,
          },
        ];
        setTabs(updated);
        setActiveScope(newScope);
        setActiveTabId(newId);
        activeScope().history.clear({ recaptureSnapshot: false });
        setPendingLayerData(null);
        dispatch({
          type: "SWITCH_TAB",
          payload: {
            width,
            height,
            backgroundFill: "transparent",
            layers,
            activeLayerId: layerId,
            zoom: 1,
            tiledMode: false,
            showTileGrid: false,
            swatches: newSnapshot.swatches,
            swatchGroups: newSnapshot.swatchGroups,
          },
        });
        const updatedRecent = await window.api.addRecentFile(path);
        onRecentFilesUpdated?.(updatedRecent);
        return;
      }

      // Already open? Just switch.
      const existing = tabs.find((t) => t.filePath === path);
      if (existing) {
        handleSwitchTab(existing.id);
        return;
      }

      // ── .verve file ──────────────────────────────────────────────────────
      const json = await window.api.openverveFile(path);
      const doc = JSON.parse(json) as {
        version: number;
        pixelFormat?: string;
        canvas: {
          width: number;
          height: number;
          backgroundFill?: BackgroundFill;
        };
        activeLayerId: string | null;
        layers: Array<
          LayerState & {
            layerDataRGBA8?: string | null;
            layerDataF32?: string | null;
            layerDataIndexed?: string | null;
            layerGeo?: {
              layerWidth: number;
              layerHeight: number;
              offsetX: number;
              offsetY: number;
            } | null;
            adjustmentMaskPng?: string | null;
          }
        >;
        swatches?: unknown;
        swatchGroups?: unknown;
        pixelBrushes?: unknown;
        spritesheet?: unknown;
      };

      // ── Legacy field migration ────────────────────────────────────────────
      // Older .verve files (pre-EffectType rename) tagged adjustment/effect/
      // filter layers with `adjustmentType` instead of `effectType`. Copy the
      // legacy field forward in-place so downstream code only ever sees the
      // new name. Idempotent: if `effectType` is already present we leave it.
      if (Array.isArray(doc.layers)) {
        for (const rawLayer of doc.layers as unknown as Array<
          Record<string, unknown>
        >) {
          if (
            rawLayer &&
            typeof rawLayer === "object" &&
            "adjustmentType" in rawLayer
          ) {
            if (!("effectType" in rawLayer)) {
              rawLayer.effectType = rawLayer.adjustmentType;
            }
            delete rawLayer.adjustmentType;
          }
        }
      }

      const layerData = new Map<string, string>();
      const layers: LayerState[] = doc.layers.map(
        ({
          layerDataRGBA8,
          layerDataF32,
          layerDataIndexed,
          layerGeo,
          adjustmentMaskPng,
          ...meta
        }) => {
          if (layerDataRGBA8) layerData.set(meta.id, layerDataRGBA8);
          if (layerDataF32)
            layerData.set(meta.id, `data:raw/f32;base64,${layerDataF32}`);
          if (layerDataIndexed)
            layerData.set(
              meta.id,
              `data:raw/indexed8;base64,${layerDataIndexed}`,
            );
          if (layerGeo)
            layerData.set(`${meta.id}:geo`, JSON.stringify(layerGeo));
          if (adjustmentMaskPng)
            layerData.set(`${meta.id}:adjustment-mask`, adjustmentMaskPng);
          return meta as LayerState;
        },
      );
      const title = fileTitle(path);
      const bg = doc.canvas.backgroundFill ?? "transparent";
      if (doc.version >= 2) {
        if (!isValidSwatchArray(doc.swatches)) {
          showOperationError(
            "Could not open file.",
            "The file contains invalid swatch data.",
          );
          return;
        }
      }
      const docSwatches =
        doc.version >= 2
          ? (doc.swatches as { r: number; g: number; b: number; a: number }[])
          : DEFAULT_SWATCHES;
      let docSwatchGroups: SwatchGroup[] = [];
      if (doc.version >= 3) {
        if (!isValidSwatchGroupsArray(doc.swatchGroups, docSwatches.length)) {
          showOperationError(
            "Could not open file.",
            "The file contains invalid swatch group data.",
          );
          return;
        }
        docSwatchGroups = doc.swatchGroups as SwatchGroup[];
      }
      let docPixelBrushes: PixelBrush[] = [];
      if (doc.version >= 4 && Array.isArray(doc.pixelBrushes)) {
        docPixelBrushes = doc.pixelBrushes as PixelBrush[];
      }
      let docPixelFormat: PixelFormat = "rgba8";
      if (doc.version >= 5) {
        const fmt = doc.pixelFormat;
        if (fmt !== "rgba8" && fmt !== "rgba32f" && fmt !== "indexed8") {
          showOperationError(
            "Could not open file.",
            "This document uses an unsupported pixel format and cannot be opened.",
          );
          return;
        }
        docPixelFormat = fmt as PixelFormat;
      }
      let docSpritesheet: import("@/types").SpritesheetState | undefined;
      if (
        doc.version >= 6 &&
        doc.spritesheet &&
        typeof doc.spritesheet === "object"
      ) {
        docSpritesheet = doc.spritesheet as import("@/types").SpritesheetState;
      }
      const newSnapshot: TabSnapshot = {
        canvasWidth: doc.canvas.width,
        canvasHeight: doc.canvas.height,
        backgroundFill: bg,
        layers,
        activeLayerId: doc.activeLayerId ?? layers[0]?.id ?? null,
        zoom: 1,
        swatches: docSwatches,
        swatchGroups: docSwatchGroups,
        pixelBrushes: docPixelBrushes,
        pixelFormat: docPixelFormat,
        spritesheet: docSpritesheet,
      };
      const snapshot = captureActiveSnapshot();
      const savedLayerData = serializeActiveTabPixels();
      const newId = makeTabId();
      const newScope = createDocumentScope();
      const updated: TabRecord[] = [
        ...tabs.map((t) =>
          t.id === activeTabId
            ? { ...t, snapshot, savedLayerData }
            : t,
        ),
        {
          id: newId,
          title,
          filePath: path,
          snapshot: newSnapshot,
          savedLayerData: layerData,
            scope: newScope,
          canvasKey: 1,
          tiledMode: false,
          showTileGrid: false,
          pixelFormat: docPixelFormat,
          exposureEV: 0,
          toneMappingOperator: "reinhard" as ToneMappingOperator,
          animationMode: false,
        },
      ];
      setTabs(updated);
      setActiveScope(newScope);
      setActiveTabId(newId);
      activeScope().history.clear({ recaptureSnapshot: false });
      setPendingLayerData(null);
      dispatch({
        type: "SWITCH_TAB",
        payload: {
          width: doc.canvas.width,
          height: doc.canvas.height,
          backgroundFill: bg,
          layers,
          activeLayerId: newSnapshot.activeLayerId,
          zoom: 1,
          tiledMode: false,
          showTileGrid: false,
          pixelFormat: docPixelFormat,
          swatches: docSwatches,
          swatchGroups: docSwatchGroups,
        },
      });
      dispatch({ type: "SET_PIXEL_BRUSHES", payload: docPixelBrushes });
      if (docSpritesheet) {
        dispatch({ type: "SET_SPRITESHEET", payload: docSpritesheet });
      }
      // animationMode is never serialized — always open in normal mode
      const updated2 = await window.api.addRecentFile(path);
      onRecentFilesUpdated?.(updated2);
    },
    [
      tabs,
      activeTabId,
      captureActiveSnapshot,
      serializeActiveTabPixels,
      handleSwitchTab,
      dispatch,
      setTabs,
      setActiveTabId,
      setPendingLayerData,
      onRecentFilesUpdated,
    ],
  );

  const handleOpen = useCallback(async (): Promise<void> => {
    const path = await window.api.openverveDialog();
    if (!path) return;
    await openFromPath(path);
  }, [openFromPath]);

  const handleOpenPath = useCallback(
    async (path: string): Promise<void> => {
      await openFromPath(path);
    },
    [openFromPath],
  );

  const handleSave = useCallback(
    async (saveAs = false): Promise<void> => {
      const activeTab = tabs.find((t) => t.id === activeTabId);
      const existingPath = activeTab?.filePath ?? null;
      // Non-.verve files (imported images) must not be overwritten via Save — force Save As dialog.
      const isVerve = existingPath?.toLowerCase().endsWith(".verve") === true;
      let path = saveAs || !isVerve ? null : existingPath;
      if (!path) {
        path = await window.api.saveverveDialog(
          activeTab?.filePath ?? undefined,
        );
        if (!path) return;
      }

      const layerPngs: Record<string, string> = {};
      const layerF32Data: Record<string, string> = {};
      const layerIndexedData: Record<string, string> = {};
      const adjustmentMaskPngs: Record<string, string> = {};
      const layerGeos: Record<
        string,
        {
          layerWidth: number;
          layerHeight: number;
          offsetX: number;
          offsetY: number;
        }
      > = {};

      // Get all layer geometries at once (used for non-rgba8 pixel layers)
      const allGeos =
        canvasHandleRef.current?.captureAllLayerGeometry() ?? new Map();
      for (const [id, geo] of allGeos) {
        layerGeos[id] = geo;
      }

      for (const layer of state.layers) {
        if (!("type" in layer)) {
          // Pixel layer — use format-specific export
          if (state.pixelFormat === "rgba8") {
            const result = canvasHandleRef.current?.exportLayerPng(layer.id);
            if (result) {
              layerPngs[layer.id] = result.png;
              layerGeos[layer.id] = {
                layerWidth: result.layerWidth,
                layerHeight: result.layerHeight,
                offsetX: result.offsetX,
                offsetY: result.offsetY,
              };
            }
          } else if (state.pixelFormat === "rgba32f") {
            const f32 = canvasHandleRef.current?.exportLayerF32(layer.id);
            if (f32) layerF32Data[layer.id] = f32ToBase64(f32);
          } else {
            const idx = canvasHandleRef.current?.exportLayerIndexed(layer.id);
            if (idx) layerIndexedData[layer.id] = uint8ToBase64(idx);
          }
        } else if (layer.type !== "adjustment" && layer.type !== "group") {
          // Text, shape, mask layers — always serialized as PNG (they are always rgba8 internally)
          const result = canvasHandleRef.current?.exportLayerPng(layer.id);
          if (result) {
            layerPngs[layer.id] = result.png;
            layerGeos[layer.id] = {
              layerWidth: result.layerWidth,
              layerHeight: result.layerHeight,
              offsetX: result.offsetX,
              offsetY: result.offsetY,
            };
          }
        }
        if ("type" in layer && layer.type === "adjustment") {
          const maskPng = canvasHandleRef.current?.exportAdjustmentMaskPng(
            layer.id,
          );
          if (maskPng) adjustmentMaskPngs[layer.id] = maskPng;
        }
      }
      const doc = {
        version: 6,
        pixelFormat: state.pixelFormat,
        canvas: {
          width: state.canvas.width,
          height: state.canvas.height,
          backgroundFill: state.canvas.backgroundFill,
        },
        activeLayerId: state.activeLayerId,
        layers: state.layers.map((l) => ({
          ...l,
          layerDataRGBA8: layerPngs[l.id] ?? null,
          layerDataF32: layerF32Data[l.id] ?? null,
          layerDataIndexed: layerIndexedData[l.id] ?? null,
          layerGeo: layerGeos[l.id] ?? null,
          adjustmentMaskPng: adjustmentMaskPngs[l.id] ?? null,
        })),
        swatches: state.swatches,
        swatchGroups: state.swatchGroups,
        pixelBrushes: state.pixelBrushes,
        spritesheet: state.spritesheet,
      };
      await window.api.saveverveFile(path, JSON.stringify(doc));
      const savedPath = path;
      const title = fileTitle(savedPath);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId ? { ...t, filePath: savedPath, title } : t,
        ),
      );
      const updated = await window.api.addRecentFile(savedPath);
      onRecentFilesUpdated?.(updated);
    },
    [tabs, activeTabId, state, canvasHandleRef, setTabs, onRecentFilesUpdated],
  );

  const handleSaveACopy = useCallback(async (): Promise<void> => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const path = await window.api.saveverveDialog(
      activeTab?.filePath ?? undefined,
    );
    if (!path) return;

    const layerPngs2: Record<string, string> = {};
    const layerF32Data2: Record<string, string> = {};
    const layerIndexedData2: Record<string, string> = {};
    const adjustmentMaskPngs2: Record<string, string> = {};
    const layerGeos2: Record<
      string,
      {
        layerWidth: number;
        layerHeight: number;
        offsetX: number;
        offsetY: number;
      }
    > = {};

    const allGeos2 =
      canvasHandleRef.current?.captureAllLayerGeometry() ?? new Map();
    for (const [id, geo] of allGeos2) {
      layerGeos2[id] = geo;
    }

    for (const layer of state.layers) {
      if (!("type" in layer)) {
        if (state.pixelFormat === "rgba8") {
          const result = canvasHandleRef.current?.exportLayerPng(layer.id);
          if (result) {
            layerPngs2[layer.id] = result.png;
            layerGeos2[layer.id] = {
              layerWidth: result.layerWidth,
              layerHeight: result.layerHeight,
              offsetX: result.offsetX,
              offsetY: result.offsetY,
            };
          }
        } else if (state.pixelFormat === "rgba32f") {
          const f32 = canvasHandleRef.current?.exportLayerF32(layer.id);
          if (f32) layerF32Data2[layer.id] = f32ToBase64(f32);
        } else {
          const idx = canvasHandleRef.current?.exportLayerIndexed(layer.id);
          if (idx) layerIndexedData2[layer.id] = uint8ToBase64(idx);
        }
      } else if (layer.type !== "adjustment" && layer.type !== "group") {
        const result = canvasHandleRef.current?.exportLayerPng(layer.id);
        if (result) {
          layerPngs2[layer.id] = result.png;
          layerGeos2[layer.id] = {
            layerWidth: result.layerWidth,
            layerHeight: result.layerHeight,
            offsetX: result.offsetX,
            offsetY: result.offsetY,
          };
        }
      }
      if ("type" in layer && layer.type === "adjustment") {
        const maskPng = canvasHandleRef.current?.exportAdjustmentMaskPng(
          layer.id,
        );
        if (maskPng) adjustmentMaskPngs2[layer.id] = maskPng;
      }
    }
    const doc2 = {
      version: 6,
      pixelFormat: state.pixelFormat,
      canvas: {
        width: state.canvas.width,
        height: state.canvas.height,
        backgroundFill: state.canvas.backgroundFill,
      },
      activeLayerId: state.activeLayerId,
      layers: state.layers.map((l) => ({
        ...l,
        layerDataRGBA8: layerPngs2[l.id] ?? null,
        layerDataF32: layerF32Data2[l.id] ?? null,
        layerDataIndexed: layerIndexedData2[l.id] ?? null,
        layerGeo: layerGeos2[l.id] ?? null,
        adjustmentMaskPng: adjustmentMaskPngs2[l.id] ?? null,
      })),
      swatches: state.swatches,
      swatchGroups: state.swatchGroups,
      pixelBrushes: state.pixelBrushes,
      spritesheet: state.spritesheet,
    };
    await window.api.saveverveFile(path, JSON.stringify(doc2));
    // The current tab's filePath is NOT updated — this is a copy.
  }, [tabs, activeTabId, state, canvasHandleRef]);

  return {
    untitledCounter,
    handleNewConfirm,
    handleOpen,
    handleOpenPath,
    handleSave,
    handleSaveACopy,
  };
}
