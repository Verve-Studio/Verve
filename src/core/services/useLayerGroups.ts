import type { AppAction } from "@/core/store/AppContext";
import type { AppState, CompositeLayerState, LayerState, PixelLayerState } from "@/types";
import { isCompositeLayer, isContainerLayer, isGroupLayer } from "@/types";
import {
  getDescendantIds,
  getParentGroup,
  hasLockedCompositeAncestor,
} from "@/utils/layerTree";
import { showOperationError } from "@/utils/userFeedback";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { Dispatch, MutableRefObject } from "react";
import { useCallback, useMemo } from "react";
import { newLayerId } from "@/utils/layerId";
import { matchPaletteIndices } from "@/wasm";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseLayerGroupsOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  dispatch: Dispatch<AppAction>;
  /** Labels the history entry captured after the layer-stack change
   *  (see useHistory). */
  pendingLayerLabelRef: MutableRefObject<string | null>;
}

export type ContainerKind = "group" | "composite";

/** Group operations on explicit ids (see `LayerStackCommands`): they throw
 *  when the operation can't run and return the produced layer's id. */
export interface LayerGroupCommands {
  /** Put `ids` (siblings: all at the top level or in the same group) into a
   *  new group or composite, placed at the topmost one. */
  groupLayers(ids: readonly string[], options?: { name?: string; kind?: ContainerKind }): string;
  /** Move a group's (or composite's) children up one level and remove it. */
  ungroup(id: string): void;
  /** New empty group / composite on top, or directly above `aboveId`. */
  newGroup(options?: { name?: string; kind?: ContainerKind; aboveId?: string | null }): string;
  /** Bake a group's contents into one pixel layer. */
  mergeGroup(id: string): Promise<string>;
}

export interface UseLayerGroupsReturn {
  commands: LayerGroupCommands;
  handleMergeGroup: (groupId: string) => Promise<void>;
  handleGroupLayers: (layerIds: string[]) => void;
  handleUngroupLayers: (groupId: string) => void;
  handleCreateGroup: () => void;
  handleCreateCompositeLayer: () => void;
}

const isAttachment = (l: LayerState): l is LayerState & { parentId: string } =>
  "type" in l && (l.type === "mask" || l.type === "adjustment");

/** `LayerGroupCommands.newGroup` on an explicit store: a new empty group /
 *  composite on top, or directly above `aboveId` inside its parent group.
 *  Shared by the command and the Layers panel's New Group button, which
 *  reaches the store directly rather than through this hook. */
export function newGroupCommand(
  env: {
    /** Live state: read again after each dispatch. */
    getState: () => AppState;
    dispatch: Dispatch<AppAction>;
    pendingLayerLabelRef: MutableRefObject<string | null>;
  },
  { name, kind = "group", aboveId }: { name?: string; kind?: ContainerKind; aboveId?: string | null } = {},
): string {
  const { getState, dispatch, pendingLayerLabelRef } = env;
  const id = newLayerId(kind);
  const payload = {
    id,
    name: name || (kind === "composite" ? "Composite" : "Group"),
    aboveLayerId: aboveId ?? undefined,
  };
  pendingLayerLabelRef.current = kind === "composite" ? "New Composite Layer" : "New Group";
  if (kind === "composite") dispatch({ type: "ADD_COMPOSITE_LAYER", payload });
  else dispatch({ type: "ADD_LAYER_GROUP", payload });
  if (aboveId) {
    const parent = getParentGroup(getState().layers, aboveId);
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
  }
  return id;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useLayerGroups({
  canvasHandleRef,
  stateRef,
  dispatch,
  pendingLayerLabelRef,
}: UseLayerGroupsOptions): UseLayerGroupsReturn {
  const commands = useMemo((): LayerGroupCommands => {
    /** Change a container's kind in place (GROUP_LAYERS / UNGROUP_LAYERS
     *  only know groups). */
    const setContainerKind = (id: string, kind: ContainerKind): void => {
      dispatch({
        type: "REORDER_LAYERS",
        payload: stateRef.current.layers.map((l) =>
          l.id === id && isContainerLayer(l)
            ? kind === "composite"
              ? ({ ...l, type: "composite", blendMode: "normal" } as CompositeLayerState)
              : ({ ...l, type: "group", blendMode: "pass-through" } as LayerState)
            : l,
        ),
      });
    };

    return {
      groupLayers(ids, { name, kind = "group" } = {}) {
        const layers = stateRef.current.layers;
        if (ids.length === 0) throw new Error("No layers to group.");
        for (const id of ids) {
          const l = layers.find((x) => x.id === id);
          if (!l) throw new Error("A layer to group no longer exists.");
          if (isAttachment(l)) {
            throw new Error("Masks and effects move with their layer; group the layer instead.");
          }
        }
        const parentOf = (id: string): string | null => getParentGroup(layers, id)?.id ?? null;
        const parent = parentOf(ids[0]);
        if (ids.some((id) => parentOf(id) !== parent)) {
          throw new Error(
            "Only layers in the same group (or all at the top level) can be grouped together.",
          );
        }
        const groupId = newLayerId(kind);
        const groupName = name || (kind === "composite" ? "Composite" : "Group");
        pendingLayerLabelRef.current = kind === "composite" ? "Group Into Composite" : "Group Layers";
        dispatch({ type: "GROUP_LAYERS", payload: { groupId, groupName, layerIds: [...ids] } });
        if (!stateRef.current.layers.some((l) => l.id === groupId)) {
          pendingLayerLabelRef.current = null;
          throw new Error("The layers can't be grouped (they're inside a locked composite).");
        }
        if (kind === "composite") {
          setContainerKind(groupId, "composite");
          dispatch({ type: "SET_ACTIVE_LAYER", payload: groupId });
        }
        return groupId;
      },

      ungroup(id) {
        const group = stateRef.current.layers.find((l) => l.id === id);
        if (!group || !isContainerLayer(group)) throw new Error("The layer isn't a group.");
        // A locked composite (or anything inside one) is structurally frozen.
        // Checked up front so a refused ungroup never half-applies the
        // composite → group conversion below.
        if (isCompositeLayer(group) && group.locked) {
          throw new Error("A locked composite can't be ungrouped. Unlock it first.");
        }
        if (hasLockedCompositeAncestor(stateRef.current.layers, id)) {
          throw new Error("The group can't be ungrouped (it's inside a locked composite).");
        }
        pendingLayerLabelRef.current = "Ungroup Layers";
        if (!isGroupLayer(group)) setContainerKind(id, "group");
        dispatch({ type: "UNGROUP_LAYERS", payload: { groupId: id } });
        if (stateRef.current.layers.some((l) => l.id === id)) {
          pendingLayerLabelRef.current = null;
          throw new Error("The group couldn't be ungrouped.");
        }
      },

      newGroup(options) {
        return newGroupCommand(
          { getState: () => stateRef.current, dispatch, pendingLayerLabelRef },
          options,
        );
      },

      async mergeGroup(id) {
        const handle = canvasHandleRef.current;
        if (!handle) throw new Error("The canvas isn't ready yet.");
        const { layers, swatches } = stateRef.current;
        const group = layers.find((l) => l.id === id);
        if (!group || !isGroupLayer(group)) throw new Error("The layer isn't a group.");

        const merged = await handle.rasterizeGroupChildren(id, layers, swatches, "merge");

        const newId = newLayerId("layer");
        const { pixelFormat } = stateRef.current;
        if (pixelFormat === "indexed8") {
          // The composite is RGBA: map it back to palette indices.
          const indexData = await matchPaletteIndices(
            merged.data as Uint8Array,
            swatches,
            255,
          );
          handle.prepareNewLayerIndexed(newId, group.name, indexData);
        } else {
          handle.prepareNewLayer(
            newId,
            group.name,
            merged.data,
            undefined,
            undefined,
            undefined,
            undefined,
            pixelFormat,
          );
        }

        const newPixelLayer: PixelLayerState = {
          id: newId,
          name: group.name,
          visible: group.visible,
          opacity: group.opacity,
          locked: group.locked,
          blendMode: group.blendMode === "pass-through" ? "normal" : group.blendMode,
        };

        // Collect all IDs to remove: group's descendants + their attached mask/adjustment children
        const descendantIds = new Set(getDescendantIds(layers, id));
        for (const l of layers) {
          if (isAttachment(l) && descendantIds.has(l.parentId)) descendantIds.add(l.id);
        }

        const newLayers: LayerState[] = [];
        for (const l of layers) {
          if (l.id === id) {
            newLayers.push(newPixelLayer);
            continue;
          }
          if (descendantIds.has(l.id)) continue;
          if (isContainerLayer(l) && l.childIds.includes(id)) {
            // Parent container: replace groupId with newId in childIds
            newLayers.push({ ...l, childIds: l.childIds.map((c) => (c === id ? newId : c)) });
            continue;
          }
          newLayers.push(l);
        }

        // Recorded once the canvas holds the merged layer (useHistory).
        pendingLayerLabelRef.current = "Merge Group";
        dispatch({ type: "REORDER_LAYERS", payload: newLayers });
        dispatch({ type: "SET_ACTIVE_LAYER", payload: newId });
        return newId;
      },
    };
  }, [canvasHandleRef, stateRef, dispatch, pendingLayerLabelRef]);

  const handleGroupLayers = useCallback(
    (layerIds: string[]): void => {
      if (layerIds.length < 2) return;
      try {
        commands.groupLayers(layerIds);
      } catch (error) {
        showOperationError("Group layers failed.", error);
      }
    },
    [commands],
  );

  const handleUngroupLayers = useCallback(
    (groupId: string): void => {
      const group = stateRef.current.layers.find((l) => l.id === groupId);
      if (!group || !isGroupLayer(group)) return;
      try {
        commands.ungroup(groupId);
      } catch (error) {
        showOperationError("Ungroup layers failed.", error);
      }
    },
    [commands, stateRef],
  );

  const handleCreateGroup = useCallback((): void => {
    const { selectedLayerIds, activeLayerId } = stateRef.current;
    const effective = [
      ...new Set([...selectedLayerIds, ...(activeLayerId ? [activeLayerId] : [])]),
    ];
    if (effective.length >= 2) {
      handleGroupLayers(effective);
    } else {
      commands.newGroup({ aboveId: activeLayerId });
    }
  }, [commands, stateRef, handleGroupLayers]);

  const handleMergeGroup = useCallback(
    async (groupId: string): Promise<void> => {
      try {
        await commands.mergeGroup(groupId);
      } catch (error) {
        console.error("[useLayerGroups] Merge group failed:", error);
        showOperationError("Merge group failed.", error);
      }
    },
    [commands],
  );

  const handleCreateCompositeLayer = useCallback((): void => {
    commands.newGroup({ kind: "composite", aboveId: stateRef.current.activeLayerId });
  }, [commands, stateRef]);

  return {
    commands,
    handleMergeGroup,
    handleGroupLayers,
    handleUngroupLayers,
    handleCreateGroup,
    handleCreateCompositeLayer,
  };
}
