/**
 * App implementation of `AutomationHost`: the surface automation workflows
 * drive. Every operation delegates to the same commands the menus, dialogs
 * and panels use (layer stack / group / import commands, canvas transforms,
 * colour mode, effects, file and export commands), so a node behaves exactly
 * like the matching menu item.
 *
 * The host is created once and reads the latest hook callbacks through a ref
 * (they're re-created as the active document changes). Operations that
 * change the document wait for React to commit and for the canvas to be
 * ready (`settle`) before the next node runs.
 */
import { useEffect, useMemo, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { effectRegistry } from "@/core/effects";
import { customEffectStore } from "@/core/effects/CustomShader/customEffectStore";
import { parseEffect } from "@/core/effects/CustomShader/effectFile";
import { applyFieldValues } from "@/core/effects/_shared/effectParams";
import type { EffectLayerState, EffectType } from "@/core/effects/effectTypes";
import { IMAGE_EXTENSIONS } from "@/core/io/imageLoader";
import type { ExportSettings } from "@/core/io/exportSettings";
import { normalizeExportSettings } from "@/core/io/exportSettings";
import type {
  AddEffectOptions,
  AutomationHost,
  LayerKind,
  LayerProperties,
  LayerQuery,
} from "@/core/nodes/automationHost";
import { automationHostProvider } from "@/core/nodes/automationHostProvider";
import type { DocumentRef, LayerRef } from "@/core/nodes/values";
import type { AppAction } from "@/core/store/AppContext";
import { activeScope } from "@/core/store/scope";
import { upscaleModelStore } from "@/core/store/upscaleModelStore";
import type { TabRecord } from "@/core/store/tabTypes";
import type { AppState, LayerState, RGBAColor } from "@/types";
import { isContainerLayer, isLinkedLayer } from "@/types";
import { buildRootLayerIds, getParentGroup, isDescendantOf } from "@/utils/layerTree";
import { newLayerId } from "@/utils/layerId";
import { srgbToLinearChannel } from "@/utils/pixelFormatConvert";
import { canvasReadyStore } from "@/ux/main/Canvas/canvasReadyStore";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { matchPaletteIndices } from "@/wasm";
import type { AddEffectOptions as AddEffectLayerOptions } from "./useAdjustments";
import { isEffectEligibleLayer } from "./useAdjustments";
import type { DocumentFileCommands } from "./useFileOps";
import type { LayerGroupCommands } from "./useLayerGroups";
import type { LayerImportCommands } from "./useLayerImport";
import type { LayerStackCommands } from "./useLayers";
import type {
  CropRect,
  FlipAxis,
  LayerTransformCallOptions,
  RotateAmount,
  TransformCallOptions,
} from "./useCanvasTransforms";
import type { AlignEdge, DistributeAxis, OrderOp } from "./useLayerArrange";
import type { LayerColorSpace, PixelFormat } from "@/types";
import type { ResizeImageSettings } from "@/ux/modals/ResizeImageDialog/ResizeImageDialog";
import type { ResizeCanvasSettings } from "@/ux/modals/ResizeCanvasDialog/ResizeCanvasDialog";
import type { RescaleImageSettings } from "@/ux/modals/RescaleImageDialog/RescaleImageDialog";
import type { RestoreImageSettings } from "@/ux/modals/RestoreImageDialog/RestoreImageDialog";

export interface AutomationHostDeps {
  stateRef: MutableRefObject<AppState>;
  dispatch: Dispatch<AppAction>;
  canvasHandleRef: { readonly current: CanvasHandle | null };
  captureHistory: (label: string) => void;
  tabs: TabRecord[];
  setTabs: Dispatch<SetStateAction<TabRecord[]>>;
  activeTabIdRef: { readonly current: string };
  switchTab: (id: string) => void;
  closeTabs: (ids: readonly string[]) => void;
  layerStack: LayerStackCommands;
  layerGroups: LayerGroupCommands;
  layerImport: LayerImportCommands;
  files: DocumentFileCommands;
  exportDocument: (settings: ExportSettings) => Promise<void>;
  addEffectLayer: (options: AddEffectLayerOptions) => string;
  transforms: {
    resizeImage: (s: ResizeImageSettings, o?: TransformCallOptions) => Promise<void>;
    resizeCanvas: (s: ResizeCanvasSettings, o?: TransformCallOptions) => void;
    crop: (rect?: CropRect, o?: TransformCallOptions) => void;
    rotate: (a: RotateAmount, o?: TransformCallOptions) => Promise<void>;
    flip: (a: FlipAxis, o?: TransformCallOptions) => Promise<void>;
    rescale: (s: RescaleImageSettings, o?: TransformCallOptions) => Promise<void>;
    restore: (s: RestoreImageSettings, o?: TransformCallOptions) => Promise<void>;
    rotateLayers: (a: RotateAmount, o?: LayerTransformCallOptions) => Promise<void>;
    flipLayers: (a: FlipAxis, o?: LayerTransformCallOptions) => Promise<void>;
  };
  convertColorMode: (
    format: PixelFormat,
    sourceColorSpace?: LayerColorSpace,
    opts?: TransformCallOptions,
  ) => Promise<void>;
  arrange: {
    handleAlign: (edge: AlignEdge, ids?: readonly string[]) => void;
    handleDistribute: (axis: DistributeAxis, ids?: readonly string[]) => void;
    handleOrder: (op: OrderOp, ids?: readonly string[]) => void;
  };
  clipboard: {
    copy: () => void;
    copyMerged: () => void;
    cut: () => void;
    paste: () => void;
    pasteInto: () => void;
  };
  layerSelection: {
    selectAll: () => void;
    deselect: () => void;
  };
  contentAware: {
    fill: (radius: number) => Promise<void>;
    remove: (radius: number) => Promise<void>;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const isAttachment = (l: LayerState): l is LayerState & { parentId: string } =>
  "type" in l && (l.type === "mask" || l.type === "adjustment");

function layerKind(l: LayerState): LayerKind {
  if (!("type" in l)) return "pixel";
  switch (l.type) {
    case "adjustment":
      return "effect";
    case "text":
    case "shape":
    case "path":
    case "frame":
    case "linked":
    case "group":
    case "composite":
    case "mask":
      return l.type;
    default:
      return "pixel";
  }
}

/** Wait one frame (falls back to a timer when the window is hidden and
 *  rAF is throttled). */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 100);
  });

const SETTLE_TIMEOUT_MS = 60_000;

const NO_DOCUMENT = "No document is open (start the workflow with a New or Open node).";

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAutomationHost(deps: AutomationHostDeps): void {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const host = useMemo((): AutomationHost => {
    const d = (): AutomationHostDeps => depsRef.current;
    const state = (): AppState => d().stateRef.current;
    const handle = (): CanvasHandle => {
      if (d().tabs.length === 0) throw new Error(NO_DOCUMENT);
      const h = d().canvasHandleRef.current;
      if (!h) throw new Error("The canvas isn't ready.");
      return h;
    };
    const activeTab = (): TabRecord | undefined =>
      d().tabs.find((t) => t.id === d().activeTabIdRef.current);

    /** Wait until React has committed and the active tab's canvas is mounted
     *  with GPU data for every pixel layer. */
    const settle = async (): Promise<void> => {
      await nextFrame();
      await nextFrame();
      if (d().tabs.length === 0) throw new Error(NO_DOCUMENT);
      const deadline = performance.now() + SETTLE_TIMEOUT_MS;
      for (;;) {
        const tab = activeTab();
        const h = d().canvasHandleRef.current;
        const ready =
          tab !== undefined &&
          h !== null &&
          canvasReadyStore.readyKey === `${tab.id}-${tab.canvasKey}` &&
          // Pixel layers and masks get their GPU data on mount / sync.
          state().layers.every((l) => {
            const kind = layerKind(l);
            return (kind !== "pixel" && kind !== "mask") || h.getGpuLayer(l.id) !== null;
          });
        if (ready) return;
        if (performance.now() > deadline) throw new Error("Timed out waiting for the document to update.");
        await nextFrame();
      }
    };

    const docRef = (tab: TabRecord): DocumentRef => ({ kind: "document", id: tab.id, name: tab.title });

    const layerRef = (id: string): LayerRef => {
      const l = state().layers.find((x) => x.id === id);
      if (!l) throw new Error("The layer no longer exists.");
      return { kind: "layer", id, name: l.name, docId: d().activeTabIdRef.current };
    };

    const activate = async (docId: string): Promise<void> => {
      if (d().activeTabIdRef.current === docId) return;
      if (!d().tabs.some((t) => t.id === docId)) throw new Error("The document is closed.");
      d().switchTab(docId);
      await settle();
    };

    /** The layer behind a ref (switching to its document first). */
    const resolve = async (ref: LayerRef): Promise<LayerState> => {
      if (d().tabs.length === 0) throw new Error(NO_DOCUMENT);
      await activate(ref.docId);
      const l = state().layers.find((x) => x.id === ref.id);
      if (!l) throw new Error(`Layer "${ref.name}" no longer exists (merged, rasterized or deleted?).`);
      return l;
    };
    const resolveAll = async (refs: readonly LayerRef[]): Promise<string[]> => {
      const ids: string[] = [];
      for (const r of refs) ids.push((await resolve(r)).id);
      return ids;
    };

    const toTransformOpts = { throwErrors: true } as const;

    /** Top-level layers, top first (masks / effects excluded). */
    const rootIds = (): string[] =>
      buildRootLayerIds(state().layers).filter((id) => {
        const l = state().layers.find((x) => x.id === id);
        return l !== undefined && !isAttachment(l);
      });

    const attachmentsOf = (id: string): LayerState[] =>
      state().layers.filter((l) => isAttachment(l) && l.parentId === id);

    /** Composite holding the whole image, created when needed. */
    const imageComposite = async (): Promise<string> => {
      const roots = rootIds();
      const only = roots.length === 1 ? state().layers.find((l) => l.id === roots[0]) : undefined;
      if (only && "type" in only && only.type === "composite" && !only.locked) return only.id;
      const id = d().layerGroups.groupLayers(roots, { kind: "composite", name: "Image" });
      await settle();
      return id;
    };

    const selectionMask = (): Uint8Array | null => activeScope().selection.mask;

    const writeLayerData = async (
      layerId: string,
      mutate: (data: Uint8Array | Float32Array, layer: { w: number; h: number; ox: number; oy: number }) => void,
      label: string,
    ): Promise<void> => {
      const h = handle();
      const gpu = h.getGpuLayer(layerId);
      const raw = h.getLayerRawData(layerId);
      if (!gpu || !raw) throw new Error("The layer has no pixels to edit.");
      const copy = raw.slice();
      mutate(copy, { w: gpu.layerWidth, h: gpu.layerHeight, ox: gpu.offsetX, oy: gpu.offsetY });
      h.replaceLayerData(
        layerId,
        copy,
        gpu.format,
        gpu.format === "indexed8" ? (state().swatches as RGBAColor[]) : undefined,
      );
      d().captureHistory(label);
      await settle();
    };

    const requirePixelLayer = (l: LayerState, what: string): void => {
      const kind = layerKind(l);
      if (kind !== "pixel" && kind !== "mask") {
        throw new Error(`${what} works on pixel layers; "${l.name}" is a ${kind} layer (rasterize it first).`);
      }
    };

    const effectFor = (type: string) => {
      const effect = effectRegistry.get(type);
      if (!effect) throw new Error(`Unknown effect "${type}".`);
      return effect;
    };

    /** Run a paste handler and return the layer it adds. */
    const pasteWith = async (run: () => void): Promise<LayerRef> => {
      const before = new Set(state().layers.map((l) => l.id));
      run();
      const deadline = performance.now() + 10_000;
      for (;;) {
        await nextFrame();
        const added = state().layers.find((l) => !before.has(l.id) && !isAttachment(l));
        if (added) {
          await settle();
          return layerRef(added.id);
        }
        if (performance.now() > deadline) throw new Error("The clipboard has no image to paste.");
      }
    };

    const host: AutomationHost = {
      log(message) {
        automationHostProvider.emitLog(message);
      },

      // ── Documents ──────────────────────────────────────────────────────
      activeDocument() {
        const tab = activeTab();
        return tab ? docRef(tab) : null;
      },
      documents() {
        return d().tabs.map(docRef);
      },
      async activateDocument(doc) {
        await activate(doc.id);
      },
      document() {
        if (d().tabs.length === 0) throw new Error(NO_DOCUMENT);
        const s = state();
        const tab = activeTab();
        return {
          name: tab?.title ?? "",
          width: s.canvas.width,
          height: s.canvas.height,
          format: s.pixelFormat,
          path: tab?.filePath ?? "",
          dirty: activeScope().history.isDirty(),
        };
      },
      async newDocument({ name, width, height, pixelFormat, background }) {
        if (width < 1 || height < 1) throw new Error("The document size must be at least 1 × 1.");
        const id = d().files.newDocument({
          width: Math.round(width),
          height: Math.round(height),
          backgroundFill: background,
          pixelFormat,
        });
        if (name) d().setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title: name } : t)));
        await settle();
        return docRef(d().tabs.find((t) => t.id === id) ?? activeTab()!);
      },
      async openDocument(path) {
        const id = await d().files.openDocument(path);
        await settle();
        const tab = d().tabs.find((t) => t.id === id);
        if (!tab) throw new Error(`Couldn't open "${path}".`);
        return docRef(tab);
      },
      async closeDocument(doc) {
        if (!d().tabs.some((t) => t.id === doc.id)) return;
        d().closeTabs([doc.id]);
        await nextFrame();
        if (d().tabs.length > 0) await settle();
      },
      async saveDocument(path, asCopy) {
        if (asCopy) {
          if (!path) throw new Error("Save a Copy needs a path.");
          await d().files.saveDocumentCopy(path);
        } else {
          await d().files.saveDocument(path || undefined);
        }
        await nextFrame();
      },
      async exportImage(settings) {
        const s = state();
        const normalized = normalizeExportSettings(settings, {
          width: s.canvas.width,
          height: s.canvas.height,
          pixelFormat: s.pixelFormat,
        });
        if (normalized.layerMode === "separate" && !normalized.perLayerIds?.length) {
          throw new Error("No layers to export.");
        }
        await d().exportDocument(normalized);
      },

      // ── Files ──────────────────────────────────────────────────────────
      listDirectory(path, options) {
        return window.api.listDirectory(path, options);
      },
      statPath(path) {
        return window.api.statPath(path);
      },
      makeDirectory(path) {
        return window.api.makeDirectory(path);
      },
      supportedImageExtensions() {
        return [...IMAGE_EXTENSIONS].map((e) => e.replace(/^\./, "")).concat("psd", "verve");
      },

      // ── Image ──────────────────────────────────────────────────────────
      async resizeImage(width, height, resample) {
        await d().transforms.resizeImage(
          { width: Math.round(width), height: Math.round(height), filter: resample },
          toTransformOpts,
        );
        await settle();
      },
      async resizeCanvas(width, height, anchor) {
        d().transforms.resizeCanvas(
          { width: Math.round(width), height: Math.round(height), anchorCol: anchor.col, anchorRow: anchor.row },
          toTransformOpts,
        );
        await settle();
      },
      async cropImage({ x, y, width, height }) {
        d().transforms.crop(
          { x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) },
          toTransformOpts,
        );
        await settle();
      },
      async trimImage() {
        const flat = await handle().rasterizeComposite("sample");
        const { data, width, height } = flat;
        const scale = data instanceof Float32Array ? 1 : 255;
        let x0 = width;
        let y0 = height;
        let x1 = -1;
        let y1 = -1;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] / scale > 1 / 512) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          }
        }
        if (x1 < 0) throw new Error("The image is empty; nothing to trim to.");
        if (x0 === 0 && y0 === 0 && x1 === width - 1 && y1 === height - 1) return;
        await host.cropImage({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 });
      },
      async rotateImage(amount) {
        await d().transforms.rotate(amount, toTransformOpts);
        await settle();
      },
      async flipImage(axis) {
        await d().transforms.flip(axis, toTransformOpts);
        await settle();
      },
      async convertColorMode(format, sourceColorSpace) {
        if (format === state().pixelFormat) return;
        await d().convertColorMode(format, sourceColorSpace, toTransformOpts);
        await settle();
      },
      async upscaleModels() {
        const models = await window.api.upscale.listModels();
        return models.map((m) => ({ id: m.id, label: m.label }));
      },
      async rescaleImage(width, height, modelId) {
        if (state().pixelFormat !== "rgba8") throw new Error("AI rescale needs an RGB/8 document.");
        await d().transforms.rescale(
          { width: Math.round(width), height: Math.round(height), modelId },
          toTransformOpts,
        );
        await settle();
      },
      async restoreImage(modelId) {
        if (state().pixelFormat !== "rgba8") throw new Error("AI restore needs an RGB/8 document.");
        await d().transforms.restore({ modelId }, toTransformOpts);
        await settle();
      },

      // ── Layers ─────────────────────────────────────────────────────────
      activeLayer() {
        if (d().tabs.length === 0) return null;
        const id = state().activeLayerId;
        return id && state().layers.some((l) => l.id === id) ? layerRef(id) : null;
      },
      async setActiveLayer(ref) {
        const l = await resolve(ref);
        d().dispatch({ type: "SET_ACTIVE_LAYER", payload: l.id });
        await nextFrame();
      },
      async selectLayers(refs) {
        const ids = await resolveAll(refs);
        if (ids.length > 0) d().dispatch({ type: "SET_ACTIVE_LAYER", payload: ids[ids.length - 1] });
        d().dispatch({ type: "SET_SELECTED_LAYERS", payload: ids });
        await nextFrame();
      },
      async selectAllLayers() {
        d().layerSelection.selectAll();
        await nextFrame();
      },
      async deselectLayers() {
        d().layerSelection.deselect();
        await nextFrame();
      },
      layers(query: LayerQuery) {
        if (d().tabs.length === 0) return [];
        const layers = state().layers;
        const byId = new Map(layers.map((l) => [l.id, l]));
        const out: string[] = [];
        const visit = (ids: readonly string[]): void => {
          for (let i = ids.length - 1; i >= 0; i--) {
            const l = byId.get(ids[i]);
            if (!l || isAttachment(l)) continue;
            if (!query.visibleOnly || l.visible) out.push(l.id);
            if (query.attachments) {
              for (const a of attachmentsOf(l.id)) {
                if (!query.visibleOnly || a.visible) out.push(a.id);
              }
            }
            if (query.recursive && isContainerLayer(l) && (!query.visibleOnly || l.visible)) visit(l.childIds);
          }
        };
        visit(buildRootLayerIds(layers));
        return out.map(layerRef);
      },
      layerProperties(ref): LayerProperties {
        const l = state().layers.find((x) => x.id === ref.id);
        if (!l || ref.docId !== d().activeTabIdRef.current) {
          throw new Error(`Layer "${ref.name}" isn't in the active document.`);
        }
        const gpu = d().canvasHandleRef.current?.getGpuLayer(l.id) ?? null;
        const hasGeometry = gpu !== null && !isAttachment(l) && !isContainerLayer(l);
        return {
          name: l.name,
          kind: layerKind(l),
          visible: l.visible,
          opacity: "opacity" in l ? l.opacity : 1,
          blendMode: "blendMode" in l ? l.blendMode : "normal",
          locked: "locked" in l ? l.locked === true : false,
          x: hasGeometry ? gpu.offsetX : 0,
          y: hasGeometry ? gpu.offsetY : 0,
          width: hasGeometry ? gpu.layerWidth : 0,
          height: hasGeometry ? gpu.layerHeight : 0,
          effectType: "type" in l && l.type === "adjustment" ? l.effectType : "",
        };
      },
      layerChildren(ref) {
        const l = state().layers.find((x) => x.id === ref.id);
        if (!l) return [];
        if (isContainerLayer(l)) return [...l.childIds].reverse().filter((id) => state().layers.some((x) => x.id === id)).map(layerRef);
        return attachmentsOf(l.id).map((a) => layerRef(a.id));
      },
      layerParent(ref) {
        const layers = state().layers;
        const l = layers.find((x) => x.id === ref.id);
        if (!l) return null;
        if (isAttachment(l)) return layers.some((x) => x.id === l.parentId) ? layerRef(l.parentId) : null;
        const group = getParentGroup(layers, l.id);
        return group ? layerRef(group.id) : null;
      },
      async newLayer({ name, above }) {
        if (above) await resolve(above);
        const id = d().layerStack.newLayer({ name, aboveId: above?.id ?? null });
        await settle();
        return layerRef(id);
      },
      async newGroup({ name, kind, above }) {
        if (above) await resolve(above);
        const id = d().layerGroups.newGroup({ name, kind, aboveId: above?.id ?? null });
        await settle();
        return layerRef(id);
      },
      async duplicateLayer(ref, name) {
        const l = await resolve(ref);
        const id = d().layerStack.duplicateLayer(l.id, name);
        await settle();
        return layerRef(id);
      },
      async deleteLayer(ref) {
        const l = await resolve(ref);
        d().layerStack.deleteLayer(l.id);
        await settle();
      },
      async setLayerProperties(ref, patch) {
        const l = await resolve(ref);
        const dispatch = d().dispatch;
        if (patch.name !== undefined && patch.name !== l.name) {
          dispatch({ type: "RENAME_LAYER", payload: { id: l.id, name: patch.name } });
        }
        if (patch.visible !== undefined && patch.visible !== l.visible) {
          dispatch({ type: "TOGGLE_LAYER_VISIBILITY", payload: l.id });
        }
        if (patch.opacity !== undefined) {
          if (!("opacity" in l)) throw new Error(`"${l.name}" has no opacity.`);
          dispatch({ type: "SET_LAYER_OPACITY", payload: { id: l.id, opacity: Math.min(1, Math.max(0, patch.opacity)) } });
        }
        if (patch.blendMode !== undefined) {
          if (!("blendMode" in l)) throw new Error(`"${l.name}" has no blend mode.`);
          if (patch.blendMode === "pass-through" && !(isContainerLayer(l) && l.type === "group")) {
            throw new Error("Pass Through is only available for groups.");
          }
          dispatch({ type: "SET_LAYER_BLEND", payload: { id: l.id, blendMode: patch.blendMode } });
        }
        if (patch.locked !== undefined && "locked" in l && patch.locked !== (l.locked === true)) {
          dispatch({ type: "TOGGLE_LAYER_LOCK", payload: l.id });
        }
        if (patch.colorSpace !== undefined) {
          if (layerKind(l) !== "pixel") throw new Error("Colour space can only be set on pixel layers.");
          dispatch({ type: "SET_LAYER_COLOR_SPACE", payload: { id: l.id, colorSpace: patch.colorSpace } });
        }
        d().captureHistory("Layer Properties");
        await nextFrame();
        return layerRef(l.id);
      },
      async moveLayer(ref, x, y, relative) {
        const l = await resolve(ref);
        if (isLinkedLayer(l)) {
          const gpu = handle().getGpuLayer(l.id);
          const dx = relative ? x : x - (gpu?.offsetX ?? 0);
          const dy = relative ? y : y - (gpu?.offsetY ?? 0);
          d().dispatch({
            type: "UPDATE_LINKED_LAYER",
            payload: { ...l, centerX: l.centerX + dx, centerY: l.centerY + dy },
          });
        } else if ("type" in l && l.type === "text") {
          const dx = relative ? x : x - l.x;
          const dy = relative ? y : y - l.y;
          d().dispatch({ type: "UPDATE_TEXT_LAYER", payload: { ...l, x: l.x + dx, y: l.y + dy } });
        } else {
          requirePixelLayer(l, "Move Layer");
          const gpu = handle().getGpuLayer(l.id);
          if (!gpu) throw new Error("The layer has no pixels.");
          gpu.offsetX = Math.round(relative ? gpu.offsetX + x : x);
          gpu.offsetY = Math.round(relative ? gpu.offsetY + y : y);
          handle().invalidate();
        }
        d().captureHistory("Move Layer");
        await settle();
      },
      async arrangeLayers(refs, op) {
        const ids = await resolveAll(refs);
        if (ids.length === 0) return;
        d().arrange.handleOrder(op, ids);
        await nextFrame();
      },
      async moveLayerToGroup(ref, group, index) {
        const l = await resolve(ref);
        if (isAttachment(l)) throw new Error("Masks and effects move with their layer.");
        if (group === null) {
          d().dispatch({
            type: "MOVE_LAYER_OUT_OF_GROUP",
            payload: { layerId: l.id, targetParentGroupId: null, insertIndex: 0 },
          });
        } else {
          const g = await resolve(group);
          if (!isContainerLayer(g)) throw new Error(`"${g.name}" isn't a group.`);
          if (g.id === l.id || isDescendantOf(state().layers, g.id, l.id)) {
            throw new Error("A group can't be moved into itself.");
          }
          const others = g.childIds.filter((c) => c !== l.id);
          const insertIndex = index < 0 ? others.length + 1 + index : Math.min(index, others.length);
          d().dispatch({
            type: "MOVE_LAYER_INTO_GROUP",
            payload: { layerId: l.id, targetGroupId: g.id, insertIndex: Math.max(0, insertIndex) },
          });
        }
        d().captureHistory("Move Layer");
        await nextFrame();
      },
      async groupLayers(refs, { name, kind }) {
        const ids = await resolveAll(refs);
        const id = d().layerGroups.groupLayers(ids, { name, kind });
        await settle();
        return layerRef(id);
      },
      async ungroupLayers(ref) {
        const l = await resolve(ref);
        d().layerGroups.ungroup(l.id);
        await settle();
      },
      async mergeLayers(refs) {
        const ids = await resolveAll(refs);
        const id = await d().layerStack.mergeLayers(ids);
        await settle();
        return layerRef(id);
      },
      async mergeDown(ref) {
        const l = await resolve(ref);
        const id = await d().layerStack.mergeDown(l.id);
        await settle();
        return layerRef(id);
      },
      async mergeVisible() {
        const id = await d().layerStack.mergeVisible();
        await settle();
        return layerRef(id);
      },
      async mergeGroup(ref) {
        const l = await resolve(ref);
        const id = await d().layerGroups.mergeGroup(l.id);
        await settle();
        return layerRef(id);
      },
      async flattenImage() {
        const id = await d().layerStack.flatten();
        await settle();
        return layerRef(id);
      },
      async rasterizeLayer(ref) {
        const l = await resolve(ref);
        const id = await d().layerStack.rasterizeLayer(l.id);
        await settle();
        return layerRef(id);
      },
      async addLayerMask(ref, fromSelection) {
        const l = await resolve(ref);
        const mask = fromSelection ? selectionMask() : null;
        if (fromSelection && !mask) throw new Error("There's no selection to make the mask from.");
        if (attachmentsOf(l.id).some((a) => "type" in a && a.type === "mask")) {
          throw new Error(`"${l.name}" already has a layer mask.`);
        }
        let id: string;
        if (mask) {
          if (isAttachment(l)) throw new Error("Masks and effects can't have a layer mask.");
          id = newLayerId("mask");
          handle().prepareMaskLayer(id, "Layer Mask", mask);
          d().dispatch({
            type: "ADD_MASK_LAYER",
            payload: { id, name: "Layer Mask", visible: true, type: "mask", parentId: l.id },
          });
        } else {
          id = d().layerStack.addMask(l.id);
        }
        await settle();
        return layerRef(id);
      },
      async alignLayers(refs, edge) {
        const ids = await resolveAll(refs);
        d().arrange.handleAlign(edge, ids);
        await nextFrame();
      },
      async distributeLayers(refs, axis) {
        const ids = await resolveAll(refs);
        d().arrange.handleDistribute(axis, ids);
        await nextFrame();
      },
      async rotateLayers(refs, amount) {
        const ids = await resolveAll(refs);
        await d().transforms.rotateLayers(amount, { throwErrors: true, layerIds: ids });
        await settle();
      },
      async flipLayers(refs, axis) {
        const ids = await resolveAll(refs);
        await d().transforms.flipLayers(axis, { throwErrors: true, layerIds: ids });
        await settle();
      },
      async importImageAsLayer(path, { name, above, position }) {
        if (above) await resolve(above);
        const id = await d().layerImport.importImageAsLayer(path, {
          name,
          aboveId: above === undefined ? undefined : (above?.id ?? null),
          position,
        });
        await settle();
        return layerRef(id);
      },
      async refreshLinkedLayer(ref) {
        const l = await resolve(ref);
        d().layerImport.refreshLinkedLayer(l.id);
        await settle();
      },
      async newLinkedLayer(path, name) {
        const id = await d().layerImport.newLinkedLayer(path, { name });
        await settle();
        return layerRef(id);
      },
      async fillLayer(ref, color) {
        const l = await resolve(ref);
        requirePixelLayer(l, "Fill");
        const [r = 0, g = 0, b = 0, a = 1] = color;
        const mask = selectionMask();
        const canvasW = state().canvas.width;
        const canvasH = state().canvas.height;
        // Pixel layers start small and grow as they're painted: cover the
        // filled area (the selection's bounds, or the canvas) first.
        const area = host.selectionBounds() ?? { x: 0, y: 0, width: canvasW, height: canvasH };
        handle().growLayerToCover(l.id, area.x, area.y, area.x + area.width - 1, area.y + area.height - 1);
        const gpu = handle().getGpuLayer(l.id);
        let index = 0;
        if (gpu?.format === "indexed8") {
          const px = new Uint8Array([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255]);
          index = (await matchPaletteIndices(px, state().swatches, 255))[0];
        }
        const linear = [srgbToLinearChannel(r), srgbToLinearChannel(g), srgbToLinearChannel(b)];
        await writeLayerData(
          l.id,
          (data, geo) => {
            const indexed = gpu?.format === "indexed8";
            const isFloat = data instanceof Float32Array;
            for (let ly = 0; ly < geo.h; ly++) {
              const cy = ly + geo.oy;
              if (cy < 0 || cy >= canvasH) continue;
              for (let lx = 0; lx < geo.w; lx++) {
                const cx = lx + geo.ox;
                if (cx < 0 || cx >= canvasW) continue;
                // Soft selections scale the deposit.
                const m = mask ? mask[cy * canvasW + cx] / 255 : 1;
                if (m <= 0) continue;
                const i = ly * geo.w + lx;
                if (indexed) {
                  if (m >= 0.5) data[i] = index;
                  continue;
                }
                const sa = a * m;
                const p = i * 4;
                const scale = isFloat ? 1 : 255;
                const da = data[p + 3] / scale;
                const outA = sa + da * (1 - sa);
                const src = isFloat ? linear : [r, g, b];
                for (let c = 0; c < 3; c++) {
                  const dc = data[p + c] / scale;
                  const v = outA > 0 ? (src[c] * sa + dc * da * (1 - sa)) / outA : 0;
                  data[p + c] = isFloat ? v : Math.round(v * 255);
                }
                data[p + 3] = isFloat ? outA : Math.round(outA * 255);
              }
            }
          },
          "Fill",
        );
      },
      async clearLayer(ref) {
        const l = await resolve(ref);
        requirePixelLayer(l, "Clear");
        const s = state();
        const mask = selectionMask() ?? new Uint8Array(s.canvas.width * s.canvas.height).fill(255);
        handle().clearLayerPixels(l.id, mask);
        d().captureHistory("Delete");
        await settle();
      },

      // ── Effects ────────────────────────────────────────────────────────
      async addEffect(opts: AddEffectOptions) {
        const effect = effectFor(opts.effectType);
        if (state().pixelFormat === "indexed8") {
          throw new Error("Effects aren't available in indexed-colour documents.");
        }
        let parentId: string;
        if (opts.target === "image") {
          parentId = await imageComposite();
        } else {
          const l = await resolve(opts.target);
          if (!isEffectEligibleLayer(l)) {
            throw new Error(
              `"${l.name}" can't take effects (${layerKind(l)} layer${"locked" in l && l.locked ? ", locked" : ""}). Use a pixel, text, shape, frame, linked or composite layer.`,
            );
          }
          parentId = l.id;
        }
        const base = { ...(effect.defaultParams as Record<string, unknown>), ...(opts.baseParams ?? {}) };
        const params = effect.paramFields
          ? applyFieldValues(effect.paramFields, base, opts.values as Record<string, never>)
          : base;
        const id = d().addEffectLayer({
          parentId,
          effectType: opts.effectType as EffectType,
          params: params as never,
          name: opts.name,
          useSelection: opts.useSelection,
          openPanel: false,
        });
        await settle();
        if (effect.prepareHeadless) {
          const layer = state().layers.find((l) => l.id === id) as EffectLayerState | undefined;
          if (layer) {
            const prepared = await effect.prepareHeadless(layer as never, {
              canvasHandle: handle(),
              layers: state().layers,
            });
            if (prepared) {
              d().dispatch({ type: "UPDATE_ADJUSTMENT_LAYER", payload: { ...layer, params: prepared } as EffectLayerState });
              await nextFrame();
            }
          }
        }
        if (!opts.bake) return layerRef(id);
        const baked = await d().layerStack.rasterizeLayer(parentId);
        await settle();
        return layerRef(baked);
      },
      async loadCustomEffect(nameOrPath) {
        customEffectStore.start();
        const wanted = nameOrPath.trim();
        const lower = wanted.toLowerCase();
        const entry = customEffectStore
          .all()
          .find((e) => e.label.toLowerCase() === lower || e.path.toLowerCase() === lower);
        if (entry) {
          if (!entry.graph) throw new Error(`Effect "${entry.label}" can't be used: ${entry.error ?? "unreadable"}`);
          return { name: entry.label, graph: entry.graph, path: entry.source === "user" ? entry.path : null };
        }
        if (!lower.endsWith(".effect")) {
          const names = customEffectStore.all().map((e) => e.label);
          throw new Error(`No custom effect named "${wanted}"${names.length ? ` (available: ${names.join(", ")})` : ""}`);
        }
        const parsed = parseEffect(await window.api.readEffectFile(wanted));
        if (!parsed.ok) throw new Error(`Can't use ${wanted}: ${parsed.error}`);
        const fileName = (wanted.split(/[\\/]/).pop() ?? wanted).replace(/\.effect$/i, "");
        return { name: parsed.graph.info?.name || fileName, graph: parsed.graph, path: wanted };
      },
      async setEffectValues(ref, values) {
        const l = await resolve(ref);
        if (!("type" in l) || l.type !== "adjustment") throw new Error(`"${l.name}" isn't an effect layer.`);
        const effect = effectFor(l.effectType);
        const params = effect.paramFields
          ? applyFieldValues(effect.paramFields, l.params as never, values as Record<string, never>)
          : l.params;
        d().dispatch({ type: "UPDATE_ADJUSTMENT_LAYER", payload: { ...l, params } as EffectLayerState });
        d().captureHistory(l.name);
        await nextFrame();
      },

      // ── Selection ──────────────────────────────────────────────────────
      async selectAll() {
        const { width, height } = state().canvas;
        activeScope().selection.setRect(0, 0, width - 1, height - 1, "set");
      },
      async deselect() {
        activeScope().selection.clear();
      },
      async invertSelection() {
        activeScope().selection.invert();
      },
      async selectRect({ x, y, width, height }, mode, feather) {
        if (width <= 0 || height <= 0) throw new Error("The rectangle is empty.");
        activeScope().selection.setRect(
          Math.round(x),
          Math.round(y),
          Math.round(x + width) - 1,
          Math.round(y + height) - 1,
          mode,
          Math.max(0, feather),
        );
      },
      async selectLayerAlpha(ref, mode) {
        const l = await resolve(ref);
        const pixels = handle().getLayerPixels(l.id);
        if (!pixels) throw new Error(`"${l.name}" has no pixels.`);
        const mask = new Uint8Array(pixels.length / 4);
        for (let i = 0; i < mask.length; i++) mask[i] = pixels[i * 4 + 3];
        const sel = activeScope().selection;
        if (mode === "set" && !mask.some((v) => v > 0)) sel.clear();
        else sel.mergeMask(mask, mode);
      },
      hasSelection() {
        return activeScope().selection.hasSelection();
      },
      selectionBounds() {
        const mask = selectionMask();
        if (!mask) return null;
        const w = state().canvas.width;
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -1;
        let y1 = -1;
        for (let i = 0; i < mask.length; i++) {
          if (!mask[i]) continue;
          const x = i % w;
          const y = (i - x) / w;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
      },

      // ── Edit ───────────────────────────────────────────────────────────
      async copy(ref, merged) {
        await host.setActiveLayer(ref);
        if (merged) d().clipboard.copyMerged();
        else d().clipboard.copy();
        await settle();
      },
      async cut(ref) {
        await host.setActiveLayer(ref);
        d().clipboard.cut();
        await settle();
      },
      paste() {
        return pasteWith(() => d().clipboard.paste());
      },
      pasteInto() {
        if (!activeScope().selection.hasSelection()) {
          return Promise.reject(new Error("Paste Into needs a selection."));
        }
        return pasteWith(() => d().clipboard.pasteInto());
      },
      async contentAwareFill(ref, mode, radius) {
        if (!activeScope().selection.hasSelection()) throw new Error("Content-aware fill needs a selection.");
        await host.setActiveLayer(ref);
        const r = Math.max(0, Math.round(radius));
        if (mode === "fill") await d().contentAware.fill(r);
        else await d().contentAware.remove(r);
        await settle();
      },
    };
    return host;
  }, []);

  useEffect(() => automationHostProvider.provide(host), [host]);

  // Lists that automation node dropdowns show (same sources as the menus
  // and dialogs), loaded up front so nodes have them when created.
  useEffect(() => {
    void upscaleModelStore.load();
    customEffectStore.start();
  }, []);
}
