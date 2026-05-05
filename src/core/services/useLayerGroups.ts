import type { AppAction } from "@/core/store/AppContext";
import type { AppState, LayerState, PixelLayerState } from "@/types";
import { isGroupLayer } from "@/types";
import { getDescendantIds } from "@/utils/layerTree";
import { showOperationError } from "@/utils/userFeedback";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { Dispatch, MutableRefObject } from "react";
import { useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseLayerGroupsOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  captureHistory: (label: string) => void;
  dispatch: Dispatch<AppAction>;
}

export interface UseLayerGroupsReturn {
  handleMergeGroup: (groupId: string) => Promise<void>;
  handleGroupLayers: (layerIds: string[]) => void;
  handleUngroupLayers: (groupId: string) => void;
  handleCreateGroup: () => void;
  handleCreateCompositeLayer: () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useLayerGroups({
  canvasHandleRef,
  stateRef,
  captureHistory,
  dispatch,
}: UseLayerGroupsOptions): UseLayerGroupsReturn {
  const handleGroupLayers = useCallback(
    (layerIds: string[]): void => {
      if (layerIds.length < 2) return;
      const groupId = `group-${Date.now()}`;
      dispatch({
        type: "GROUP_LAYERS",
        payload: { groupId, groupName: "Group", layerIds },
      });
      captureHistory("Group Layers");
    },
    [dispatch, captureHistory],
  );

  const handleUngroupLayers = useCallback(
    (groupId: string): void => {
      const layers = stateRef.current.layers;
      const group = layers.find((l) => l.id === groupId);
      if (!group || !isGroupLayer(group)) return;
      dispatch({ type: "UNGROUP_LAYERS", payload: { groupId } });
      captureHistory("Ungroup Layers");
    },
    [dispatch, stateRef, captureHistory],
  );

  const handleCreateGroup = useCallback((): void => {
    const { selectedLayerIds, activeLayerId } = stateRef.current;
    const effective = [
      ...new Set([
        ...selectedLayerIds,
        ...(activeLayerId ? [activeLayerId] : []),
      ]),
    ];
    if (effective.length >= 2) {
      const groupId = `group-${Date.now()}`;
      dispatch({
        type: "GROUP_LAYERS",
        payload: { groupId, groupName: "Group", layerIds: effective },
      });
      captureHistory("Group Layers");
    } else {
      const id = `group-${Date.now()}`;
      dispatch({
        type: "ADD_LAYER_GROUP",
        payload: {
          id,
          name: "Group",
          aboveLayerId: activeLayerId ?? undefined,
        },
      });
    }
  }, [dispatch, stateRef, captureHistory]);

  const handleMergeGroup = useCallback(
    async (groupId: string): Promise<void> => {
      try {
        const handle = canvasHandleRef.current;
        if (!handle) return;
        const { layers, swatches } = stateRef.current;
        const group = layers.find((l) => l.id === groupId);
        if (!group || !isGroupLayer(group)) return;

        const merged = await handle.rasterizeGroupChildren(
          groupId,
          layers,
          swatches,
          "merge",
        );
        captureHistory("Merge Group");

        const newId = `layer-${Date.now()}`;
        handle.prepareNewLayer(newId, group.name, merged.data as Uint8Array);

        const newPixelLayer: PixelLayerState = {
          id: newId,
          name: group.name,
          visible: group.visible,
          opacity: group.opacity,
          locked: group.locked,
          blendMode:
            group.blendMode === "pass-through" ? "normal" : group.blendMode,
        };

        // Collect all IDs to remove: group's descendants + their attached mask/adjustment children
        const descendantIds = new Set(getDescendantIds(layers, groupId));
        for (const l of layers) {
          if (
            "type" in l &&
            (l.type === "mask" || l.type === "adjustment") &&
            descendantIds.has((l as { parentId: string }).parentId)
          ) {
            descendantIds.add(l.id);
          }
        }

        const newLayers: LayerState[] = [];
        for (const l of layers) {
          if (l.id === groupId) {
            newLayers.push(newPixelLayer);
            continue;
          }
          if (descendantIds.has(l.id)) continue;
          if (isGroupLayer(l) && l.childIds.includes(groupId)) {
            // Parent group: replace groupId with newId in childIds
            newLayers.push({
              ...l,
              childIds: l.childIds.map((id) => (id === groupId ? newId : id)),
            });
            continue;
          }
          newLayers.push(l);
        }

        dispatch({ type: "REORDER_LAYERS", payload: newLayers });
        dispatch({ type: "SET_ACTIVE_LAYER", payload: newId });
      } catch (error) {
        console.error("[useLayerGroups] Merge group failed:", error);
        showOperationError("Merge group failed.", error);
      }
    },
    [canvasHandleRef, stateRef, captureHistory, dispatch],
  );

  const handleCreateCompositeLayer = useCallback((): void => {
    const { activeLayerId } = stateRef.current;
    const id = `composite-${Date.now()}`;
    dispatch({
      type: "ADD_COMPOSITE_LAYER",
      payload: {
        id,
        name: "Composite",
        aboveLayerId: activeLayerId ?? undefined,
      },
    });
  }, [dispatch, stateRef]);

  return {
    handleMergeGroup,
    handleGroupLayers,
    handleUngroupLayers,
    handleCreateGroup,
    handleCreateCompositeLayer,
  };
}
