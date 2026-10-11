import type { AppShellState } from "@/core/store/AppContext";
import { useCallback, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import {
  createLayerDataBundle,
  type LayerDataBundle,
} from "@/core/store/layerPayload";
import { decodeExrLayers } from "@/wasm";
import {
  IMAGE_EXTENSIONS,
  EXT_TO_MIME,
  loadImageBytes,
} from "@/core/io/imageLoader";
import { makeTabId, fileTitle, DEFAULT_SWATCHES } from "@/core/store/tabTypes";
import type { TabRecord, TabSnapshot } from "@/core/store/tabTypes";
import type {
  LayerState,
  BackgroundFill,
  SwatchGroup,
  PixelFormat,
  ToneMappingOperator,
} from "@/types";
import type { AppAction } from "@/core/store/AppContext";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { showOperationError } from "@/utils/userFeedback";
import { activeScope, createDocumentScope, setActiveScope } from "@/core/store/scope";
import { displayStore } from "@/ux/main/Canvas/displayStore";
import {
  convertToWorkingSpace,
  getWorkingSpaceProfile,
  type PixelLayout,
} from "@/core/cms/lcms2";
import { parseProfileColorSpace } from "@/core/cms/iccProfile";
import { notificationStore } from "@/core/store/notificationStore";
import { statusMessageStore } from "@/core/store/statusMessageStore";
import { preferencesStore } from "@/core/store/preferencesStore";
import { brushStore } from "@/core/store/brushStore";
import {
  VerveBlobWriter,
  decodeVerveContainer,
  isVerveContainer,
  type VerveByteSink,
} from "@/core/io/verveContainer";
import {
  VERVE_DOC_VERSION,
  readVervePayloads,
  serializeBrushes,
  serializeLayer,
  serializeLayerPixels,
  serializePixelBrushes,
  type SavedLayerPayloads,
} from "@/core/io/verveDocument";

// ─── Linked-layer path helpers ────────────────────────────────────────────────
// Renderer-side path arithmetic for the linked-layer feature. The renderer
// can't import `node:path`, but `.verve` documents and linked sources always
// come from a single OS at a time, so we detect the separator from the input
// string and operate on it directly. Cross-OS sharing of `.verve` files with
// linked layers relies on the relative path being portable — slashes vs
// backslashes are normalised on resolve.

function detectSep(p: string): "\\" | "/" {
  return p.includes("\\") && !p.includes("/") ? "\\" : "/";
}

/** Strip the trailing path component (filename) and return the directory. */
function directoryOf(p: string): string {
  const sep = detectSep(p);
  const i = p.lastIndexOf(sep);
  return i >= 0 ? p.slice(0, i) : "";
}

/** Compute `target` expressed relative to `fromDir`. Falls back to the
 *  absolute target when the two paths don't share a root (different drive
 *  letters on Windows, different filesystems, etc.). */
function relativePathFrom(fromDir: string, target: string): string {
  if (!fromDir) return target;
  const sep = detectSep(target);
  const norm = (s: string): string[] =>
    s.replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean);
  const fromParts = norm(fromDir);
  const targetParts = norm(target);
  // Windows: bail to absolute if drive letters differ.
  if (
    fromParts[0]?.endsWith(":") &&
    targetParts[0]?.endsWith(":") &&
    fromParts[0].toLowerCase() !== targetParts[0].toLowerCase()
  ) {
    return target;
  }
  let common = 0;
  while (
    common < fromParts.length &&
    common < targetParts.length &&
    fromParts[common] === targetParts[common]
  ) {
    common++;
  }
  const up = Array(fromParts.length - common).fill("..");
  const down = targetParts.slice(common);
  const rel = [...up, ...down].join(sep);
  return rel || ".";
}

/** Resolve `relative` against `fromDir`, collapsing `..` and `.` segments. */
function resolveRelative(fromDir: string, relative: string): string {
  if (!fromDir) return relative;
  const sep = detectSep(fromDir);
  const parts = (fromDir + sep + relative)
    .split(/[\\/]+/)
    .filter((p) => p.length > 0 && p !== ".");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else out.push(part);
  }
  // Preserve a leading separator on POSIX paths (lost by the split).
  const leading = fromDir.startsWith("/") ? "/" : "";
  return leading + out.join(sep);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseFileOpsOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  state: AppShellState;
  tabs: TabRecord[];
  activeTabId: string;
  setTabs: Dispatch<SetStateAction<TabRecord[]>>;
  setActiveTabId: Dispatch<SetStateAction<string>>;
  setPendingLayerData: Dispatch<SetStateAction<LayerDataBundle | null>>;
  activeTabIdRef: { readonly current: string };
  captureActiveSnapshot: () => TabSnapshot;
  serializeActiveTabPixels: () => LayerDataBundle | null;
  handleSwitchTab: (toId: string) => void;
  dispatch: Dispatch<AppAction>;
  onRecentFilesUpdated?: (files: string[]) => void;
}

export interface NewDocumentSettings {
  width: number;
  height: number;
  backgroundFill: BackgroundFill;
  pixelFormat?: PixelFormat;
}

/**
 * Document-level file operations with explicit arguments, shared by the
 * menu handlers below and the automation host. They throw on failure.
 */
export interface DocumentFileCommands {
  /** New document tab; returns its tab id. */
  newDocument(settings: NewDocumentSettings): string;
  /** Open any supported file (.verve, .psd, images) as a document tab and
   *  make it active; returns the tab id. */
  openDocument(path: string): Promise<string>;
  /** Save the active document as .verve to `path` (and link the tab to
   *  it), or to its current .verve path when omitted. */
  saveDocument(path?: string): Promise<void>;
  /** Write a .verve copy of the active document without relinking it. */
  saveDocumentCopy(path: string): Promise<void>;
}

export interface UseFileOpsReturn {
  commands: DocumentFileCommands;
  untitledCounter: number;
  handleNewConfirm: (settings: NewDocumentSettings) => string;
  handleOpen: () => Promise<void>;
  handleOpenPath: (path: string) => Promise<void>;
  handleSave: (saveAs?: boolean) => Promise<void>;
  handleSaveACopy: () => Promise<void>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  activeTabIdRef,
}: UseFileOpsOptions): UseFileOpsReturn {
  const [untitledCounter, setUntitledCounter] = useState(0);

  // Latest-render versions of the snapshot/serialize helpers. File opens
  // await disk reads and decodes; anything captured from the render that
  // started the open (tabs, active tab, state) can be stale by the time the
  // new tab is committed — e.g. the user switched tabs meanwhile.
  const liveRef = useRef({ captureActiveSnapshot, serializeActiveTabPixels });
  liveRef.current = { captureActiveSnapshot, serializeActiveTabPixels };

  /**
   * Background whichever tab is active *now* (snapshot + pixels) and append
   * `newTab`, using a functional update so concurrent opens can't drop each
   * other's tabs. If the active tab's canvas hasn't mounted yet (nothing to
   * serialize) its existing `savedLayerData` is kept.
   */
  const addTabBackgroundingActive = useCallback(
    (newTab: TabRecord): void => {
      const live = liveRef.current;
      const activeId = activeTabIdRef.current;
      const snapshot = live.captureActiveSnapshot();
      const savedLayerData = live.serializeActiveTabPixels();
      setTabs((prev) => [
        ...prev.map((t) =>
          t.id === activeId
            ? {
                ...t,
                snapshot,
                savedLayerData: savedLayerData ?? t.savedLayerData,
                exposureEV: displayStore.exposureEV,
                toneMappingOperator: displayStore.toneMappingOperator,
                viewTransformLutId: displayStore.viewTransformLutId,
              }
            : t,
        ),
        newTab,
      ]);
    },
    [activeTabIdRef, setTabs],
  );

  // Opens run one at a time: each open backgrounds the active tab and
  // swaps the active scope, so two interleaved opens would serialize the
  // wrong canvas. After each open we also wait for React to commit and
  // paint, so the next open sees the new tab as active.
  const openQueueRef = useRef<Promise<void>>(Promise.resolve());

  /** The tab the last open / new activated (returned to programmatic callers). */
  const lastActivatedRef = useRef<string | null>(null);
  const activateTab = useCallback(
    (id: string): void => {
      lastActivatedRef.current = id;
      setActiveTabId(id);
    },
    [setActiveTabId],
  );

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
    }): string => {
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
      addTabBackgroundingActive({
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
          toneMappingOperator: "clamp",
            viewTransformLutId: null,
          animationMode: false,
        });
      setActiveScope(newScope);
      activateTab(newId);
      activeScope().history.clear({ recaptureSnapshot: false });
      setPendingLayerData(null);
      dispatch({
        type: "NEW_CANVAS",
        payload: { width, height, backgroundFill, pixelFormat: fmt },
      });
      return newId;
    },
    [
      untitledCounter,
      addTabBackgroundingActive,
      dispatch,
      setTabs,
      activateTab,
      setPendingLayerData,
    ],
  );

  const openFromPathNow = useCallback(
    async (path: string): Promise<void> => {
      // ── Image file import ──────────────────────────────────────────────────
      const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
      if (ext === ".psd") {
        const { loadPsdLayers } = await import("@/core/io/psdLoader");
        const buf = await window.api.readFile(path);
        // The IPC result normally owns its whole buffer: hand it over
        // without copying the file.
        const psd = loadPsdLayers(
          (buf.byteOffset === 0 && buf.buffer.byteLength === buf.byteLength
            ? buf.buffer
            : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
          ) as ArrayBuffer,
        );
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
        const layerData = createLayerDataBundle();
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
            if (node.kind === "text") {
              // Live text layer — emit a TextLayerState directly, no pixel
              // buffer. The renderer's parametric-layer pipeline rasterises
              // it the same way it does any text layer authored in Verve.
              layers.push({
                id: node.id,
                name: node.name,
                visible: node.visible,
                opacity: node.opacity,
                locked: false,
                blendMode: node.blendMode,
                type: "text",
                ...node.text,
              });
              if (parentChildIds) parentChildIds.push(node.id);
              continue;
            }
            const psdLayer = node;
            layerData.layers.set(psdLayer.id, {
              format: "rgba8",
              data: psdLayer.pixels,
              geo: {
                layerWidth: psdLayer.layerWidth,
                layerHeight: psdLayer.layerHeight,
                offsetX: psdLayer.offsetX,
                offsetY: psdLayer.offsetY,
              },
            });
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
              layerData.layers.set(maskId, {
                format: "rgba8",
                data: rgba,
                geo: {
                  layerWidth: m.width,
                  layerHeight: m.height,
                  offsetX: m.offsetX,
                  offsetY: m.offsetY,
                },
              });
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
          iccProfile: psd.iccProfile,
        };
        addTabBackgroundingActive({
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
            toneMappingOperator: "clamp",
            viewTransformLutId: null,
            animationMode: false,
          });
        setActiveScope(newScope);
        activateTab(newId);
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
            iccProfile: psd.iccProfile,
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
        const bytes = await window.api.readFile(path);
        const exr = await decodeExrLayers(bytes);
        if (exr.layers.length > 1) {
          const newId = makeTabId();
      const newScope = createDocumentScope();
          const layerData = createLayerDataBundle();
          const layers: LayerState[] = [];
          // Track names already used so we can disambiguate duplicates.
          const seenNames = new Map<string, number>();
          exr.layers.forEach((L, i) => {
            const layerId = `layer-${i}`;
            let name = L.name.trim() || `Layer ${i + 1}`;
            const n = seenNames.get(name) ?? 0;
            if (n > 0) name = `${name} (${n + 1})`;
            seenNames.set(name, n + 1);
            layerData.layers.set(layerId, {
              format: "rgba32f",
              data: L.pixels,
              geo: {
                layerWidth: L.width,
                layerHeight: L.height,
                offsetX: L.offsetX,
                offsetY: L.offsetY,
              },
            });
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
          addTabBackgroundingActive({
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
              toneMappingOperator: "clamp",
            viewTransformLutId: null,
              animationMode: false,
            });
          setActiveScope(newScope);
          activateTab(newId);
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
        const mime = EXT_TO_MIME[ext] ?? "image/png";
        const loaded = await loadImageBytes(await window.api.readFile(path), mime);
        const { width, height } = loaded;

        // ── Tier-2 early-binding ICC conversion ─────────────────────────────
        // Convert source-profile pixels into the document's working space
        // (sRGB for rgba8, linear-sRGB for rgba32f) and retag with the
        // working-space profile. Falls back to Tier-1 passthrough when
        // lcms2 isn't linked into the WASM build. Intent + BPC come from
        // the user's Color Settings preferences (Tier 2c).
        //
        // Tier-3c: drop profiles whose data colour space isn't RGB or
        // Grayscale. Image decoders (PNG, JPEG, browser TIFF, etc.) always
        // hand us RGBA pixels, so a CMYK/Lab/etc. profile tag no longer
        // matches the buffer — applying it would corrupt colour.
        let importPixels: Uint8Array | Float32Array = loaded.data;
        let importIccProfile = loaded.iccProfile;
        const layout: PixelLayout = loaded.isHdr ? "rgba32f" : "rgba8";
        if (loaded.iccProfile) {
          const cs = parseProfileColorSpace(loaded.iccProfile);
          if (cs !== "rgb" && cs !== "gray") {
            notificationStore.error(
              `Embedded ${cs.toUpperCase()} profile dropped — pixels were decoded to RGB before reaching the editor.`,
            );
            importIccProfile = undefined;
          } else {
            const prefs = preferencesStore.get();
            const converted = await convertToWorkingSpace(
              loaded.data,
              loaded.iccProfile,
              layout,
              prefs.colorImportIntent,
              prefs.colorUseBpc,
            );
            if (converted) {
              importPixels = converted;
              const wsProfile = await getWorkingSpaceProfile(layout);
              if (wsProfile) importIccProfile = wsProfile;
            }
          }
        }
        if (
          !importIccProfile &&
          preferencesStore.get().colorMissingProfilePolicy ===
            "assume-working-space"
        ) {
          // Untagged (or just-untagged-due-to-non-RGB) image: tag with the
          // working-space profile so export round-trips correctly.
          const wsProfile = await getWorkingSpaceProfile(layout);
          if (wsProfile) importIccProfile = wsProfile;
        }

        if (loaded.isHdr) {
          // HDR file — create a rgba32f tab with the float pixels.
          const layerId = "layer-0";
          const layerData = createLayerDataBundle();
          layerData.layers.set(layerId, {
            format: "rgba32f",
            data: importPixels as Float32Array,
          });
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
            iccProfile: importIccProfile,
          };
          const newId = makeTabId();
      const newScope = createDocumentScope();
          addTabBackgroundingActive({
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
              toneMappingOperator: "clamp",
            viewTransformLutId: null,
              animationMode: false,
            });
          setActiveScope(newScope);
          activateTab(newId);
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
              iccProfile: importIccProfile,
            },
          });
          const updatedRecent = await window.api.addRecentFile(path);
          onRecentFilesUpdated?.(updatedRecent);
          return;
        }

        const data = importPixels as Uint8Array;
        const layerId = "layer-0";
        const newId = makeTabId();
      const newScope = createDocumentScope();
        const layerData = createLayerDataBundle();
        layerData.layers.set(layerId, { format: "rgba8", data });
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
          iccProfile: importIccProfile,
        };
        addTabBackgroundingActive({
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
            toneMappingOperator: "clamp",
            viewTransformLutId: null,
            animationMode: false,
          });
        setActiveScope(newScope);
        activateTab(newId);
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
            iccProfile: importIccProfile,
          },
        });
        const updatedRecent = await window.api.addRecentFile(path);
        onRecentFilesUpdated?.(updatedRecent);
        return;
      }

      // Already open? Just switch.
      const existing = tabs.find((t) => t.filePath === path);
      if (existing) {
        lastActivatedRef.current = existing.id;
        handleSwitchTab(existing.id);
        return;
      }

      // ── .verve file ──────────────────────────────────────────────────────
      const fileBytes = await window.api.openverveFile(path);
      const container = isVerveContainer(fileBytes)
        ? decodeVerveContainer<Record<string, unknown>>(fileBytes)
        : null;
      const doc = (container
        ? container.doc
        : JSON.parse(new TextDecoder().decode(fileBytes))) as {
        version: number;
        pixelFormat?: string;
        canvas: {
          width: number;
          height: number;
          backgroundFill?: BackgroundFill;
        };
        activeLayerId: string | null;
        layers: Array<LayerState & SavedLayerPayloads>;
        swatches?: unknown;
        swatchGroups?: unknown;
        pixelBrushes?: unknown;
        brushes?: unknown;
        activeBrushId?: unknown;
        spritesheet?: unknown;
        iccProfile?: string | null;
        /** Version ≤ 6. */
        iccProfileBase64?: string | null;
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

      const docDir = directoryOf(path);
      // Resolve every binary payload (blobs, or base64 / PNG in older files)
      // to typed arrays before the tab is created.
      const payloads = await readVervePayloads(
        doc,
        container ? container.blob : null,
        doc.canvas.width,
        doc.canvas.height,
      );
      const layerData = payloads.data;
      const layers: LayerState[] = payloads.layers.map(
        (meta) => {
          // For linked layers, prefer the relative path (resolved against
          // the document we just opened) over the stale absolute path. The
          // init hook just reads `source.absolutePath`, so re-stamp it here.
          if ("type" in meta && meta.type === "linked") {
            const m = meta as unknown as import("@/types").LinkedLayerState;
            if (m.source && m.source.relativePath && docDir) {
              return {
                ...m,
                source: {
                  ...m.source,
                  absolutePath: resolveRelative(docDir, m.source.relativePath),
                },
              } as LayerState;
            }
          }
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
      const docPixelBrushes = doc.version >= 4 ? payloads.pixelBrushes : [];
      const docBrushes = payloads.brushes;
      // The saved active brush, if it still exists (a document brush or one
      // in the user library); else keep the current user-library brush.
      const userBrushIds = new Set(brushStore.getUserBrushes().map((b) => b.id));
      const brushExists = (id: unknown): id is string =>
        typeof id === "string" &&
        (userBrushIds.has(id) || docBrushes.some((b) => b.id === id));
      const docActiveBrushId = brushExists(doc.activeBrushId)
        ? doc.activeBrushId
        : state.activeBrushId && userBrushIds.has(state.activeBrushId)
          ? state.activeBrushId
          : (brushStore.getUserBrushes()[0]?.id ?? null);
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
      const docIccProfile = payloads.iccProfile;
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
        brushes: docBrushes,
        activeBrushId: docActiveBrushId,
        pixelFormat: docPixelFormat,
        spritesheet: docSpritesheet,
        iccProfile: docIccProfile,
      };
      const newId = makeTabId();
      const newScope = createDocumentScope();
      addTabBackgroundingActive({
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
          toneMappingOperator: "clamp" as ToneMappingOperator,
          viewTransformLutId: null,
          animationMode: false,
        });
      setActiveScope(newScope);
      activateTab(newId);
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
          iccProfile: docIccProfile,
        },
      });
      dispatch({ type: "SET_PIXEL_BRUSHES", payload: docPixelBrushes });
      dispatch({ type: "SET_BRUSHES", payload: docBrushes });
      dispatch({ type: "SET_ACTIVE_BRUSH", payload: docActiveBrushId });
      if (docSpritesheet) {
        dispatch({ type: "SET_SPRITESHEET", payload: docSpritesheet });
      }
      // animationMode is never serialized — always open in normal mode
      const updated2 = await window.api.addRecentFile(path);
      onRecentFilesUpdated?.(updated2);
    },
    [
      addTabBackgroundingActive,
      handleSwitchTab,
      dispatch,
      setTabs,
      activateTab,
      setPendingLayerData,
      onRecentFilesUpdated,
    ],
  );

  /** Queued open that resolves with the activated tab id, or rejects. */
  const openPathQueued = useCallback(
    (path: string): Promise<string> => {
      const run = openQueueRef.current.then(async () => {
        lastActivatedRef.current = null;
        try {
          await openFromPathNow(path);
        } finally {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => setTimeout(resolve, 0)),
          );
        }
        const id = lastActivatedRef.current;
        if (!id) throw new Error(`${fileTitle(path)} didn't open.`);
        return id;
      });
      openQueueRef.current = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    [openFromPathNow],
  );

  const openFromPath = useCallback(
    async (path: string): Promise<void> => {
      try {
        await openPathQueued(path);
      } catch (err) {
        console.error("[Open] Failed:", path, err);
        showOperationError(`Could not open ${fileTitle(path)}.`, err);
      }
    },
    [openPathQueued],
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

  /** Encode the active document as a `.verve` container. Every binary
   *  payload goes to a blob: layer pixels in their native format with
   *  geometry, adjustment masks, frame content, pixel brushes, ICC profile.
   *  Returns the writer that streams it; layer pixels are read from the
   *  live layers while it runs, never copied whole. */
  const encodeDocument = useCallback(
    (path: string): ((sink: VerveByteSink) => Promise<void>) => {
      const handle = canvasHandleRef.current;
      if (!handle) throw new Error("The canvas isn't ready yet.");
      const blobs = new VerveBlobWriter();
      const docDir = directoryOf(path);
      const doc = {
        version: VERVE_DOC_VERSION,
        pixelFormat: state.pixelFormat,
        canvas: {
          width: state.canvas.width,
          height: state.canvas.height,
          backgroundFill: state.canvas.backgroundFill,
        },
        activeLayerId: state.activeLayerId,
        layers: state.layers.map((l) => {
          // Linked layers persist only their `source` metadata; pixels are
          // re-read from the source file on next open. Their
          // `source.relativePath` is re-stamped against the document being
          // saved so the link survives moving both files together.
          if ("type" in l && l.type === "linked") {
            return {
              ...l,
              source: {
                ...l.source,
                relativePath: relativePathFrom(docDir, l.source.absolutePath),
              },
            };
          }
          if ("type" in l && l.type === "adjustment") {
            const mask = handle.exportAdjustmentMask(l.id);
            return { ...l, adjustmentMask: mask ? blobs.add(mask) : null };
          }
          if ("type" in l && l.type === "group") return l;
          // Pixel layers, and text / shape / path / frame / mask layers
          // (stored rasterized).
          return {
            ...serializeLayer(l, blobs),
            pixels: serializeLayerPixels(handle.exportLayerData(l.id), blobs),
          };
        }),
        swatches: state.swatches,
        swatchGroups: state.swatchGroups,
        pixelBrushes: serializePixelBrushes(state.pixelBrushes, blobs),
        brushes: serializeBrushes(state.brushes, blobs),
        activeBrushId: state.activeBrushId,
        spritesheet: state.spritesheet,
        iccProfile: state.iccProfile ? blobs.add(state.iccProfile) : null,
      };
      return (sink) => blobs.write(doc, sink);
    },
    [state, canvasHandleRef],
  );

  /** Write the active document to `path`. The file is streamed to the main
   *  process in bounded chunks and replaces `path` atomically on success;
   *  on any failure (including the document changing mid-save) the temp
   *  file is removed and the previous file is untouched. */
  const writeDocument = useCallback(
    async (path: string): Promise<void> => {
      if (!canvasHandleRef.current) throw new Error("The canvas isn't ready yet.");
      const writeId = await window.api.saveverveBegin(path);
      try {
        // Header and payloads are captured in one synchronous step here.
        await encodeDocument(path)((chunk) => window.api.saveverveChunk(writeId, chunk));
      } catch (err) {
        await window.api.saveverveAbort(writeId).catch(() => undefined);
        throw err;
      }
      await window.api.saveverveCommit(writeId);
    },
    [encodeDocument, canvasHandleRef],
  );

  const handleSaveNow = useCallback(
    async (saveAs = false, targetPath?: string): Promise<void> => {
      const activeTab = tabs.find((t) => t.id === activeTabId);
      const existingPath = activeTab?.filePath ?? null;
      // Non-.verve files (imported images) must not be overwritten via Save — force Save As dialog.
      const isVerve = existingPath?.toLowerCase().endsWith(".verve") === true;
      let path = targetPath ?? (saveAs || !isVerve ? null : existingPath);
      if (!path) {
        path = await window.api.saveverveDialog(
          activeTab?.filePath ?? undefined,
        );
        if (!path) return;
      }
      await writeDocument(path);
      activeScope().history.markSaved();
      const savedPath = path;
      const title = fileTitle(savedPath);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId ? { ...t, filePath: savedPath, title } : t,
        ),
      );
      const updated = await window.api.addRecentFile(savedPath);
      onRecentFilesUpdated?.(updated);
      statusMessageStore.show(`Saved ${title}`);
    },
    [tabs, activeTabId, writeDocument, setTabs, onRecentFilesUpdated],
  );

  const handleSave = useCallback(
    async (saveAs = false): Promise<void> => {
      try {
        await handleSaveNow(saveAs);
      } catch (err) {
        console.error("[Save] Failed:", err);
        showOperationError("The document could not be saved.", err);
      }
    },
    [handleSaveNow],
  );

  const handleSaveACopyNow = useCallback(async (targetPath?: string): Promise<void> => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const path =
      targetPath ??
      (await window.api.saveverveDialog(activeTab?.filePath ?? undefined));
    if (!path) return;
    await writeDocument(path);
    // The current tab's filePath is NOT updated — this is a copy.
    statusMessageStore.show(`Saved a copy to ${fileTitle(path)}`);
  }, [tabs, activeTabId, writeDocument]);

  const handleSaveACopy = useCallback(async (): Promise<void> => {
    try {
      await handleSaveACopyNow();
    } catch (err) {
      console.error("[Save a Copy] Failed:", err);
      showOperationError("The copy could not be saved.", err);
    }
  }, [handleSaveACopyNow]);

  const commands = useMemo((): DocumentFileCommands => {
    const verve = (path: string): string => {
      if (!path.toLowerCase().endsWith(".verve")) {
        throw new Error(`Documents are saved as .verve files ("${path}").`);
      }
      return path;
    };
    return {
      newDocument: (settings) => handleNewConfirm(settings),
      openDocument: (path) => openPathQueued(path),
      saveDocument: async (path) => {
        if (!path) {
          const tab = tabs.find((t) => t.id === activeTabId);
          if (!tab?.filePath?.toLowerCase().endsWith(".verve")) {
            throw new Error("The document hasn't been saved as a .verve file yet; give a path.");
          }
        }
        await handleSaveNow(false, path ? verve(path) : undefined);
      },
      saveDocumentCopy: (path) => handleSaveACopyNow(verve(path)),
    };
  }, [handleNewConfirm, openPathQueued, handleSaveNow, handleSaveACopyNow, tabs, activeTabId]);

  return {
    commands,
    untitledCounter,
    handleNewConfirm,
    handleOpen,
    handleOpenPath,
    handleSave,
    handleSaveACopy,
  };
}
