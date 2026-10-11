import type { AppAction } from "@/core/store/AppContext";
import type { AppState, LayerState, PixelLayerState } from "@/types";
import { isContainerLayer } from "@/types";
import { showOperationError } from "@/utils/userFeedback";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { matchPaletteIndices } from "@/wasm";
import type { Dispatch, MutableRefObject } from "react";
import { useCallback, useMemo } from "react";
import { newLayerId } from "@/utils/layerId";
import { getDescendantIds, getParentGroup } from "@/utils/layerTree";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseLayersOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  captureHistory: (label: string) => void;
  dispatch: Dispatch<AppAction>;
  pendingLayerLabelRef: MutableRefObject<string | null>;
}

/**
 * Layer-stack operations on explicit layer ids. They throw a descriptive
 * error when the operation can't run (shown by the caller) and return the id
 * of the layer they produce. Shared by the menu / panel handlers below and
 * the automation host.
 */
export interface LayerStackCommands {
  /** New empty pixel layer on top, or directly above `aboveId` (inside the
   *  same group). */
  newLayer(options?: { name?: string; aboveId?: string | null }): string;
  /** Copy of the layer (groups / composites with their contents, leaves
   *  with their mask and effects), placed directly above it. */
  duplicateLayer(id: string, name?: string): string;
  deleteLayer(id: string): void;
  /** Merge two or more root pixel / text / shape / frame layers. */
  mergeLayers(ids: readonly string[]): Promise<string>;
  /** Merge `id` with the root pixel layers below it. */
  mergeDown(id: string): Promise<string>;
  mergeVisible(): Promise<string>;
  flatten(): Promise<string>;
  /** Bake the layer with its mask and effects into a pixel layer. */
  rasterizeLayer(id: string): Promise<string>;
  /** Add a (white) layer mask; returns the mask's id. */
  addMask(id: string): string;
}

export interface UseLayersReturn {
  commands: LayerStackCommands;
  handleMergeSelected: (ids: string[]) => void;
  handleMergeDown: () => void;
  handleMergeVisible: () => void;
  handleNewLayer: () => void;
  handleDuplicateLayer: () => void;
  handleDeleteActiveLayer: () => void;
  handleFlattenImage: () => void;
  handleRasterizeLayer: (layerId: string) => void;
  handleAddMaskLayer: () => void;
}

function isPixelRootLayer(layer: LayerState): boolean {
  if (!("type" in layer)) return true; // plain pixel layer
  return (
    layer.type === "text" ||
    layer.type === "shape" ||
    layer.type === "frame"
  ); // rasterisable root layers
}

const isAttachment = (l: LayerState): l is LayerState & { parentId: string } =>
  "type" in l && (l.type === "mask" || l.type === "adjustment");

function expandMergeLayerIds(
  layers: readonly LayerState[],
  rootIds: ReadonlySet<string>,
): Set<string> {
  const mergeIds = new Set<string>(rootIds);
  for (const layer of layers) {
    if (isAttachment(layer) && rootIds.has(layer.parentId)) mergeIds.add(layer.id);
  }
  return mergeIds;
}

const mergedLayer = (id: string, name: string): PixelLayerState => ({
  id,
  name,
  visible: true,
  opacity: 1,
  locked: false,
  blendMode: "normal",
});

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useLayers({
  canvasHandleRef,
  stateRef,
  captureHistory,
  dispatch,
  pendingLayerLabelRef,
}: UseLayersOptions): UseLayersReturn {
  const commands = useMemo((): LayerStackCommands => {
    const requireHandle = (): CanvasHandle => {
      const handle = canvasHandleRef.current;
      if (!handle) throw new Error("The canvas isn't ready yet.");
      return handle;
    };
    const requireLayer = (id: string): LayerState => {
      const layer = stateRef.current.layers.find((l) => l.id === id);
      if (!layer) throw new Error("The layer no longer exists.");
      return layer;
    };

    /** Create the GPU layer for merged / rasterised canvas-sized pixels in
     *  the document's format. */
    const prepareMerged = async (
      handle: CanvasHandle,
      id: string,
      name: string,
      data: Uint8Array | Float32Array,
    ): Promise<void> => {
      const { pixelFormat, swatches } = stateRef.current;
      if (pixelFormat === "indexed8") {
        // Convert the rasterised RGBA back to palette indices so the new
        // layer plays nicely with palette cycling and indexed8-only tools.
        const indexData = await matchPaletteIndices(data as Uint8Array, swatches, 255);
        handle.prepareNewLayerIndexed(id, name, indexData);
      } else {
        // Pass the format so f32 documents get a Float32-backed layer; the
        // float data would otherwise be clamped into a Uint8Array.
        handle.prepareNewLayer(id, name, data, undefined, undefined, undefined, undefined, pixelFormat);
      }
    };

    /** Replace `mergeIds` by one merged layer at the topmost root's place. */
    const mergeInto = async (
      label: string,
      rootIds: ReadonlySet<string>,
      name: string,
    ): Promise<string> => {
      const handle = requireHandle();
      const layers = stateRef.current.layers;
      const mergeIds = expandMergeLayerIds(layers, rootIds);
      const merged = (await handle.rasterizeLayers(
        layers.filter((l) => mergeIds.has(l.id)),
        "merge",
      )).data;
      captureHistory(label);
      const newId = newLayerId("layer");
      await prepareMerged(handle, newId, name, merged);
      const topIdx = layers.findLastIndex((l) => rootIds.has(l.id));
      const newLayers: LayerState[] = [];
      layers.forEach((l, i) => {
        if (i === topIdx) newLayers.push(mergedLayer(newId, name));
        if (!mergeIds.has(l.id)) newLayers.push(l);
      });
      dispatch({ type: "REORDER_LAYERS", payload: newLayers });
      dispatch({ type: "SET_ACTIVE_LAYER", payload: newId });
      return newId;
    };

    return {
      newLayer({ name, aboveId } = {}) {
        const id = newLayerId("layer");
        const layer = mergedLayer(id, name || `Layer ${stateRef.current.layers.length + 1}`);
        pendingLayerLabelRef.current = "New Layer";
        if (!aboveId) {
          dispatch({ type: "ADD_LAYER", payload: layer });
          return id;
        }
        const layers = stateRef.current.layers;
        // Insert above the reference layer's whole cluster (its mask and
        // effects follow it in the array).
        let anchor = aboveId;
        for (const l of layers) if (isAttachment(l) && l.parentId === aboveId) anchor = l.id;
        dispatch({ type: "INSERT_LAYER_ABOVE", payload: { layer, aboveId: anchor } });
        const parent = getParentGroup(layers, aboveId);
        if (parent) {
          dispatch({
            type: "MOVE_LAYER_INTO_GROUP",
            payload: {
              layerId: id,
              targetGroupId: parent.id,
              insertIndex: parent.childIds.indexOf(aboveId) + 1,
            },
          });
        }
        return id;
      },

      duplicateLayer(id, name) {
        const handle = requireHandle();
        const layers = stateRef.current.layers;
        const src = requireLayer(id);
        if (isAttachment(src)) throw new Error("Masks and effects can't be duplicated on their own.");

        // The source cluster: the layer, its descendants, and every mask /
        // effect attached to any of them.
        const subtree = new Set([id, ...(isContainerLayer(src) ? getDescendantIds(layers, id) : [])]);
        for (const l of layers) if (isAttachment(l) && subtree.has(l.parentId)) subtree.add(l.id);
        const idMap = new Map<string, string>();
        for (const l of layers) {
          if (!subtree.has(l.id)) continue;
          const prefix = isContainerLayer(l) ? "group" : "type" in l && l.type === "mask" ? "mask" : "layer";
          idMap.set(l.id, newLayerId(prefix));
        }
        const remap = (oldId: string): string => idMap.get(oldId) ?? oldId;
        const copies: LayerState[] = [];
        for (const l of layers) {
          if (!subtree.has(l.id)) continue;
          const newId = remap(l.id);
          let copy = { ...l, id: newId } as LayerState;
          if (l.id === id) copy = { ...copy, name: name || `${src.name} copy` } as LayerState;
          if (isContainerLayer(l)) copy = { ...copy, childIds: l.childIds.map(remap) } as LayerState;
          if (isAttachment(l)) copy = { ...copy, parentId: remap(l.parentId) } as LayerState;
          handle.cloneLayerData(l.id, newId, copy.name);
          if (isAttachment(l) && "hasMask" in l && l.hasMask) {
            const mask = handle.getAdjustmentMaskPixels(l.id);
            if (mask instanceof Uint8Array) handle.registerAdjustmentSelectionMask(newId, mask);
          }
          copies.push(copy);
        }

        // Place the copies directly above the source cluster; inside a group
        // the copy also joins the group, right above the source.
        const lastIdx = layers.findLastIndex((l) => subtree.has(l.id));
        const parent = getParentGroup(layers, id);
        const next = layers.map((l) =>
          parent && l.id === parent.id && isContainerLayer(l)
            ? {
                ...l,
                childIds: [
                  ...l.childIds.slice(0, l.childIds.indexOf(id) + 1),
                  remap(id),
                  ...l.childIds.slice(l.childIds.indexOf(id) + 1),
                ],
              }
            : l,
        );
        next.splice(lastIdx + 1, 0, ...copies);
        pendingLayerLabelRef.current = "Duplicate Layer";
        dispatch({ type: "REORDER_LAYERS", payload: next });
        dispatch({ type: "SET_ACTIVE_LAYER", payload: remap(id) });
        return remap(id);
      },

      deleteLayer(id) {
        requireLayer(id);
        if (stateRef.current.layers.length <= 1) throw new Error("A document needs at least one layer.");
        dispatch({ type: "REMOVE_LAYER", payload: id });
        if (stateRef.current.layers.some((l) => l.id === id)) {
          throw new Error("The layer can't be deleted (it's inside a locked composite).");
        }
      },

      async mergeLayers(ids) {
        const set = new Set(ids);
        const roots = stateRef.current.layers.filter((l) => set.has(l.id) && isPixelRootLayer(l));
        if (roots.length < 2) {
          throw new Error("Merging needs at least two pixel, text, shape or frame layers.");
        }
        return mergeInto("Merge Layers", new Set(roots.map((l) => l.id)), roots[roots.length - 1].name);
      },

      async mergeDown(id) {
        const layer = requireLayer(id);
        if (!isPixelRootLayer(layer)) throw new Error("Only pixel, text, shape and frame layers can be merged.");
        const pixelRoots = stateRef.current.layers.filter(isPixelRootLayer);
        const idx = pixelRoots.findIndex((l) => l.id === id);
        if (idx <= 0) throw new Error("There's no layer below to merge into.");
        const roots = pixelRoots.slice(0, idx + 1);
        return mergeInto("Merge Down", new Set(roots.map((l) => l.id)), roots[0].name);
      },

      async mergeVisible() {
        const roots = stateRef.current.layers.filter((l) => l.visible && isPixelRootLayer(l));
        if (roots.length < 2) throw new Error("Merge Visible needs at least two visible layers.");
        return mergeInto("Merge Visible", new Set(roots.map((l) => l.id)), "Merged");
      },

      async flatten() {
        const handle = requireHandle();
        const flat = await handle.rasterizeComposite("flatten");
        captureHistory("Flatten Image");
        const newId = newLayerId("layer");
        await prepareMerged(handle, newId, "Background", flat.data);
        dispatch({ type: "REORDER_LAYERS", payload: [mergedLayer(newId, "Background")] });
        dispatch({ type: "SET_ACTIVE_LAYER", payload: newId });
        return newId;
      },

      async rasterizeLayer(id) {
        const handle = requireHandle();
        const layers = stateRef.current.layers;
        const layer = requireLayer(id);
        if (isAttachment(layer)) throw new Error("Masks and effects can't be rasterized on their own.");

        // The layer plus its mask / effect children; a container also brings
        // its descendants (and their attachments).
        const descendants = new Set(isContainerLayer(layer) ? getDescendantIds(layers, id) : []);
        const owners = new Set([id, ...descendants]);
        const children = layers.filter((l) => isAttachment(l) && owners.has(l.parentId));
        const childIds = new Set([...descendants, ...children.map((l) => l.id)]);
        const result = await handle.rasterizeLayers(
          layers.filter((l) => l.id === id || childIds.has(l.id)),
          "merge",
        );
        captureHistory("Rasterize Layer");

        const newId = newLayerId("layer");
        // Preserve opacity + blend mode from the source layer.
        const src = layer as PixelLayerState;
        const pixel: PixelLayerState = {
          id: newId,
          name: src.name,
          visible: src.visible,
          opacity: src.opacity,
          locked: src.locked,
          blendMode: src.blendMode,
        };
        await prepareMerged(handle, newId, src.name, result.data);
        const next = layers
          .map((l) => (l.id === id ? pixel : l))
          .filter((l) => !childIds.has(l.id))
          .map((l) =>
            isContainerLayer(l) ? { ...l, childIds: l.childIds.map((c) => (c === id ? newId : c)) } : l,
          );
        dispatch({ type: "REORDER_LAYERS", payload: next });
        dispatch({ type: "SET_ACTIVE_LAYER", payload: newId });
        return newId;
      },

      addMask(id) {
        const layer = requireLayer(id);
        if (isAttachment(layer)) throw new Error("Masks and effects can't have a layer mask.");
        const existing = stateRef.current.layers.find(
          (l) => "type" in l && l.type === "mask" && l.parentId === id,
        );
        if (existing) return existing.id;
        const maskId = newLayerId("mask");
        dispatch({
          type: "ADD_MASK_LAYER",
          payload: { id: maskId, name: "Layer Mask", visible: true, type: "mask", parentId: id },
        });
        return maskId;
      },
    };
  }, [canvasHandleRef, stateRef, captureHistory, dispatch, pendingLayerLabelRef]);

  /** Run a command from a menu / panel: failures are reported, not thrown. */
  const report = useCallback(
    (what: string, run: () => unknown): void => {
      void (async () => {
        try {
          await run();
        } catch (error) {
          console.error(`[useLayers] ${what} failed:`, error);
          showOperationError(`${what} failed.`, error);
        }
      })();
    },
    [],
  );

  return {
    commands,
    handleMergeSelected: useCallback(
      (ids: string[]) => {
        if (ids.length >= 2) report("Merge selected", () => commands.mergeLayers(ids));
      },
      [commands, report],
    ),
    handleMergeDown: useCallback(() => {
      const id = stateRef.current.activeLayerId;
      if (id) report("Merge down", () => commands.mergeDown(id));
    }, [commands, report, stateRef]),
    handleMergeVisible: useCallback(
      () => report("Merge visible", () => commands.mergeVisible()),
      [commands, report],
    ),
    handleNewLayer: useCallback(() => {
      commands.newLayer();
    }, [commands]),
    handleDuplicateLayer: useCallback(() => {
      const id = stateRef.current.activeLayerId;
      if (id) report("Duplicate layer", () => commands.duplicateLayer(id));
    }, [commands, report, stateRef]),
    handleDeleteActiveLayer: useCallback(() => {
      const id = stateRef.current.activeLayerId;
      if (id && stateRef.current.layers.length > 1) dispatch({ type: "REMOVE_LAYER", payload: id });
    }, [stateRef, dispatch]),
    handleFlattenImage: useCallback(() => {
      if (stateRef.current.layers.filter((l) => !("type" in l && l.type === "mask")).length < 2) return;
      report("Flatten image", () => commands.flatten());
    }, [commands, report, stateRef]),
    handleRasterizeLayer: useCallback(
      (layerId: string) => report("Rasterize layer", () => commands.rasterizeLayer(layerId)),
      [commands, report],
    ),
    handleAddMaskLayer: useCallback(() => {
      const id = stateRef.current.activeLayerId;
      if (id) report("Add layer mask", () => commands.addMask(id));
    }, [commands, report, stateRef]),
  };
}
