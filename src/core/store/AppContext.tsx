import React, { createContext, useContext, useReducer } from "react";
import type { AppState, Tool, ShapeType, RGBAColor, LayerState, TextLayerState, ShapeLayerState, FrameLayerState, MaskLayerState, GroupLayerState, CompositeLayerState, BlendMode, BackgroundFill, GridType, SwatchGroup, PixelBrush, Brush, PixelFormat, AnimationDef, AnimationFrame } from "@/types";
import type { EffectLayerState } from "@/core/effects/effectTypes";
import { isGroupLayer, isContainerLayer, isCompositeLayer } from "@/types";
import {
  getDescendantIds,
  getParentGroup,
  hasLockedCompositeAncestor,
} from "@/utils/layerTree";
import { DEFAULT_SWATCHES } from "./tabTypes";

// ─── Actions ──────────────────────────────────────────────────────────────────

export type AppAction =
  | { type: "SET_TOOL"; payload: Tool }
  | { type: "SET_SHAPE"; payload: ShapeType }
  | { type: "SET_PRIMARY_COLOR"; payload: RGBAColor }
  | { type: "SET_SECONDARY_COLOR"; payload: RGBAColor }
  | { type: "ADD_SWATCH"; payload: RGBAColor }
  | { type: "REMOVE_SWATCH"; payload: number }
  | { type: "ADD_LAYER"; payload: LayerState }
  | {
      type: "INSERT_LAYER_ABOVE";
      payload: { layer: LayerState; aboveId: string };
    }
  | { type: "REMOVE_LAYER"; payload: string }
  | { type: "SET_ACTIVE_LAYER"; payload: string }
  | { type: "SET_SELECTED_LAYERS"; payload: string[] }
  | { type: "TOGGLE_LAYER_VISIBILITY"; payload: string }
  | { type: "TOGGLE_LAYER_LOCK"; payload: string }
  | { type: "SET_LAYER_OPACITY"; payload: { id: string; opacity: number } }
  | { type: "SET_LAYER_BLEND"; payload: { id: string; blendMode: BlendMode } }
  | { type: "RENAME_LAYER"; payload: { id: string; name: string } }
  | { type: "REORDER_LAYERS"; payload: LayerState[] }
  | { type: "ADD_TEXT_LAYER"; payload: TextLayerState }
  | { type: "UPDATE_TEXT_LAYER"; payload: TextLayerState }
  | { type: "ADD_SHAPE_LAYER"; payload: ShapeLayerState }
  | { type: "UPDATE_SHAPE_LAYER"; payload: ShapeLayerState }
  | { type: "ADD_FRAME_LAYER"; payload: FrameLayerState }
  | { type: "UPDATE_FRAME_LAYER"; payload: FrameLayerState }
  | { type: "ADD_MASK_LAYER"; payload: MaskLayerState }
  | { type: "ADD_ADJUSTMENT_LAYER"; payload: EffectLayerState }
  | { type: "UPDATE_ADJUSTMENT_LAYER"; payload: EffectLayerState }
  | { type: "SET_OPEN_ADJUSTMENT"; payload: string | null }
  | { type: "SET_ZOOM"; payload: number }
  | { type: "TOGGLE_GRID" }
  | { type: "SET_GRID_SIZE"; payload: number }
  | { type: "SET_GRID_COLOR"; payload: string }
  | { type: "SET_GRID_TYPE"; payload: GridType }
  | { type: "TOGGLE_RULERS" }
  | { type: "TOGGLE_GUIDES" }
  | {
      type: "ADD_GUIDE";
      payload: { id: string; axis: "h" | "v"; position: number };
    }
  | { type: "MOVE_GUIDE"; payload: { id: string; position: number } }
  | { type: "DELETE_GUIDE"; payload: string }
  | { type: "CLEAR_GUIDES" }
  | { type: "SET_HISTORY"; payload: { canUndo: boolean; canRedo: boolean } }
  | {
      type: "NEW_CANVAS";
      payload: {
        width: number;
        height: number;
        backgroundFill: BackgroundFill;
        pixelFormat?: PixelFormat;
      };
    }
  | {
      type: "OPEN_FILE";
      payload: {
        width: number;
        height: number;
        layers: LayerState[];
        activeLayerId: string | null;
        pixelFormat?: PixelFormat;
      };
    }
  | {
      type: "RESTORE_TAB";
      payload: {
        width: number;
        height: number;
        backgroundFill: BackgroundFill;
        layers: LayerState[];
        activeLayerId: string | null;
        zoom: number;
        tiledMode: boolean;
        showTileGrid: boolean;
        pixelFormat?: PixelFormat;
      };
    }
  | {
      type: "SWITCH_TAB";
      payload: {
        width: number;
        height: number;
        backgroundFill: BackgroundFill;
        layers: LayerState[];
        activeLayerId: string | null;
        zoom: number;
        tiledMode: boolean;
        showTileGrid: boolean;
        pixelFormat?: PixelFormat;
      };
    }
  | {
      type: "RESTORE_LAYERS";
      payload: { layers: LayerState[]; activeLayerId: string | null };
    }
  | { type: "RESIZE_CANVAS"; payload: { width: number; height: number } }
  | { type: "SET_SWATCHES"; payload: RGBAColor[] }
  | { type: "SET_SWATCH_GROUPS"; payload: SwatchGroup[] }
  | { type: "ADD_PIXEL_BRUSH"; payload: PixelBrush }
  | { type: "REMOVE_PIXEL_BRUSH"; payload: string }
  | { type: "RENAME_PIXEL_BRUSH"; payload: { id: string; name: string } }
  | { type: "SET_PIXEL_BRUSHES"; payload: PixelBrush[] }
  | { type: "ADD_BRUSH"; payload: Brush }
  | { type: "UPDATE_BRUSH"; payload: Brush }
  | { type: "REMOVE_BRUSH"; payload: string }
  | { type: "SET_BRUSHES"; payload: Brush[] }
  | { type: "SET_ACTIVE_BRUSH"; payload: string | null }
  | { type: "SET_TILED_MODE"; payload: boolean }
  | { type: "SET_SHOW_TILE_GRID"; payload: boolean }
  | { type: "SET_ANIMATION_MODE"; payload: boolean }
  | {
      type: "ADD_SWATCH_GROUP";
      payload: { name: string; swatchIndices: number[] };
    }
  | {
      type: "ADD_SWATCHES_TO_GROUP";
      payload: { id: string; swatchIndices: number[] };
    }
  | { type: "REMOVE_SWATCH_GROUP"; payload: string }
  | { type: "RENAME_SWATCH_GROUP"; payload: { id: string; name: string } }
  | {
      type: "ADD_LAYER_GROUP";
      payload: { id: string; name: string; aboveLayerId?: string };
    }
  | {
      type: "ADD_COMPOSITE_LAYER";
      payload: { id: string; name: string; aboveLayerId?: string };
    }
  | {
      type: "GROUP_LAYERS";
      payload: { groupId: string; groupName: string; layerIds: string[] };
    }
  | { type: "UNGROUP_LAYERS"; payload: { groupId: string } }
  | { type: "TOGGLE_GROUP_COLLAPSE"; payload: string }
  | {
      type: "MOVE_LAYER_INTO_GROUP";
      payload: { layerId: string; targetGroupId: string; insertIndex?: number };
    }
  | {
      type: "MOVE_LAYER_OUT_OF_GROUP";
      payload: {
        layerId: string;
        targetParentGroupId: string | null;
        insertIndex: number;
      };
    }
  | {
      type: "REORDER_ADJUSTMENT_LAYERS";
      payload: { parentId: string; orderedChildIds: string[] };
    }
  | { type: "SET_PIXEL_FORMAT"; payload: PixelFormat }
  | { type: "SET_ACTIVE_SWATCH"; payload: number }
  | { type: "CLEAR_REMOVED_SWATCH_INDEX" }
  | {
      type: "SET_SPRITESHEET";
      payload: Partial<import("@/types").SpritesheetState>;
    }
  | { type: "ADD_ANIMATION"; payload: AnimationDef }
  | { type: "UPDATE_ANIMATION"; payload: AnimationDef }
  | { type: "DELETE_ANIMATION"; payload: string }
  | { type: "SET_SELECTED_ANIMATION"; payload: string | null }
  | { type: "SET_SELECTED_FRAME"; payload: string | null }
  | {
      type: "ADD_FRAME";
      payload: { animationId: string; frame: AnimationFrame };
    }
  | {
      type: "UPDATE_FRAME";
      payload: { animationId: string; frame: AnimationFrame };
    }
  | { type: "DELETE_FRAME"; payload: { animationId: string; frameId: string } };

// ─── Initial state ────────────────────────────────────────────────────────────

const initialState: AppState = {
  activeTool: "pencil",
  activeShape: "rectangle",
  primaryColor: { r: 0, g: 0, b: 0, a: 1 },
  secondaryColor: { r: 1, g: 1, b: 1, a: 1 },
  swatches: DEFAULT_SWATCHES,
  swatchGroups: [],
  pixelBrushes: [],
  brushes: [],
  activeBrushId: null,
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
  selectedLayerIds: [],
  canvas: {
    width: 512,
    height: 512,
    zoom: 1,
    panX: 0,
    panY: 0,
    showGrid: false,
    gridSize: 16,
    gridColor: "#808080",
    gridType: "normal" as GridType,
    backgroundFill: "white",
    key: 0,
    tiledMode: false,
    showTileGrid: false,
    showRulers: false,
    showGuides: true,
    guides: [],
  },
  history: { canUndo: false, canRedo: false },
  openAdjustmentLayerId: null,
  pixelFormat: "rgba8",
  activePaletteIndex: -1,
  lastRemovedSwatchIndex: null,
  animationMode: false,
  spritesheet: {
    enabled: false,
    cellWidth: 32,
    cellHeight: 32,
    onionSkin: false,
    onionFrames: 1,
    animations: [],
    selectedAnimationId: null,
    selectedFrameId: null,
  },
};

// ─── Reducer ──────────────────────────────────────────────────────────────────

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_TOOL":
      return { ...state, activeTool: action.payload };

    case "SET_SHAPE":
      return { ...state, activeShape: action.payload };

    case "SET_PRIMARY_COLOR":
      return { ...state, primaryColor: action.payload };

    case "SET_SECONDARY_COLOR":
      return { ...state, secondaryColor: action.payload };

    case "ADD_SWATCH":
      return { ...state, swatches: [...state.swatches, action.payload] };

    case "SET_SWATCHES":
      return { ...state, swatches: action.payload };

    case "REMOVE_SWATCH": {
      const idx = action.payload;
      const nextSwatches = state.swatches.filter((_, i) => i !== idx);
      const nextGroups = state.swatchGroups.map((g) => ({
        ...g,
        swatchIndices: g.swatchIndices
          .filter((i) => i !== idx)
          .map((i) => (i > idx ? i - 1 : i)),
      }));
      return {
        ...state,
        swatches: nextSwatches,
        swatchGroups: nextGroups,
        lastRemovedSwatchIndex: idx,
      };
    }

    case "SET_SWATCH_GROUPS":
      return { ...state, swatchGroups: action.payload };

    case "ADD_PIXEL_BRUSH":
      return {
        ...state,
        pixelBrushes: [...state.pixelBrushes, action.payload],
      };

    case "REMOVE_PIXEL_BRUSH":
      return {
        ...state,
        pixelBrushes: state.pixelBrushes.filter((b) => b.id !== action.payload),
      };

    case "RENAME_PIXEL_BRUSH":
      return {
        ...state,
        pixelBrushes: state.pixelBrushes.map((b) =>
          b.id === action.payload.id ? { ...b, name: action.payload.name } : b,
        ),
      };

    case "SET_PIXEL_BRUSHES":
      return { ...state, pixelBrushes: action.payload };

    case "ADD_BRUSH":
      return { ...state, brushes: [...state.brushes, action.payload] };

    case "UPDATE_BRUSH":
      return {
        ...state,
        brushes: state.brushes.map((b) =>
          b.id === action.payload.id ? action.payload : b,
        ),
      };

    case "REMOVE_BRUSH":
      return {
        ...state,
        brushes: state.brushes.filter((b) => b.id !== action.payload),
        activeBrushId:
          state.activeBrushId === action.payload ? null : state.activeBrushId,
      };

    case "SET_BRUSHES":
      return { ...state, brushes: action.payload };

    case "SET_ACTIVE_BRUSH":
      return { ...state, activeBrushId: action.payload };

    case "ADD_SWATCH_GROUP": {
      const { name, swatchIndices } = action.payload;
      const existing = state.swatchGroups.find((g) => g.name === name);
      if (existing) {
        const merged = [
          ...new Set([...existing.swatchIndices, ...swatchIndices]),
        ];
        return {
          ...state,
          swatchGroups: state.swatchGroups.map((g) =>
            g.id === existing.id ? { ...g, swatchIndices: merged } : g,
          ),
        };
      }
      return {
        ...state,
        swatchGroups: [
          ...state.swatchGroups,
          { id: crypto.randomUUID(), name, swatchIndices },
        ],
      };
    }

    case "ADD_SWATCHES_TO_GROUP": {
      const { id, swatchIndices } = action.payload;
      return {
        ...state,
        swatchGroups: state.swatchGroups.map((g) =>
          g.id === id
            ? {
                ...g,
                swatchIndices: [
                  ...new Set([...g.swatchIndices, ...swatchIndices]),
                ],
              }
            : g,
        ),
      };
    }

    case "REMOVE_SWATCH_GROUP":
      return {
        ...state,
        swatchGroups: state.swatchGroups.filter((g) => g.id !== action.payload),
      };

    case "RENAME_SWATCH_GROUP":
      return {
        ...state,
        swatchGroups: state.swatchGroups.map((g) =>
          g.id === action.payload.id ? { ...g, name: action.payload.name } : g,
        ),
      };

    case "ADD_LAYER":
      return {
        ...state,
        layers: [...state.layers, action.payload],
        activeLayerId: action.payload.id,
      };

    case "INSERT_LAYER_ABOVE": {
      const idx = state.layers.findIndex(
        (l) => l.id === action.payload.aboveId,
      );
      const insertAt = idx >= 0 ? idx + 1 : state.layers.length;
      const next = [...state.layers];
      next.splice(insertAt, 0, action.payload.layer);
      return { ...state, layers: next, activeLayerId: action.payload.layer.id };
    }

    case "REMOVE_LAYER": {
      if (state.layers.length <= 1) return state;
      const target = state.layers.find((l) => l.id === action.payload);
      if (!target) return state;
      // A locked Composite Layer locks its entire subtree. Block deletion of
      // any descendant; the user must unlock the composite first.
      if (hasLockedCompositeAncestor(state.layers, action.payload))
        return state;
      // Collect all IDs to remove: the target + its descendants (for groups/composites) + per-layer children.
      const toRemove = new Set<string>([action.payload]);
      if (isContainerLayer(target)) {
        for (const id of getDescendantIds(state.layers, action.payload))
          toRemove.add(id);
      }
      // Also remove per-layer mask/adjustment children.
      for (const l of state.layers) {
        if (
          "type" in l &&
          (l.type === "mask" || l.type === "adjustment") &&
          toRemove.has((l as MaskLayerState | EffectLayerState).parentId)
        ) {
          toRemove.add(l.id);
        }
      }
      const remaining = state.layers
        .filter((l) => !toRemove.has(l.id))
        .map((l) =>
          isContainerLayer(l)
            ? { ...l, childIds: l.childIds.filter((id) => !toRemove.has(id)) }
            : l,
        );
      if (remaining.length === 0) return state;
      const newOpenAdjId =
        state.openAdjustmentLayerId !== null &&
        remaining.some((l) => l.id === state.openAdjustmentLayerId)
          ? state.openAdjustmentLayerId
          : null;
      return {
        ...state,
        layers: remaining,
        activeLayerId:
          state.activeLayerId !== null && toRemove.has(state.activeLayerId)
            ? (remaining[remaining.length - 1]?.id ?? null)
            : state.activeLayerId,
        openAdjustmentLayerId: newOpenAdjId,
      };
    }

    case "ADD_MASK_LAYER": {
      const parentIdx = state.layers.findIndex(
        (l) => l.id === action.payload.parentId,
      );
      if (parentIdx < 0) return state;
      // Block mask creation on a locked composite or any of its descendants.
      const parent = state.layers[parentIdx];
      if (isCompositeLayer(parent) && parent.locked) return state;
      if (hasLockedCompositeAncestor(state.layers, action.payload.parentId))
        return state;
      const next = [...state.layers];
      next.splice(parentIdx + 1, 0, action.payload);
      return { ...state, layers: next, activeLayerId: action.payload.id };
    }
    case "ADD_ADJUSTMENT_LAYER": {
      const parentIdx = state.layers.findIndex(
        (l) => l.id === action.payload.parentId,
      );
      if (parentIdx < 0) return state;
      let insertAt = parentIdx + 1;
      while (
        insertAt < state.layers.length &&
        "type" in state.layers[insertAt] &&
        (state.layers[insertAt] as MaskLayerState | EffectLayerState)
          .parentId === action.payload.parentId
      ) {
        insertAt++;
      }
      const next = [...state.layers];
      next.splice(insertAt, 0, action.payload);
      return { ...state, layers: next, activeLayerId: action.payload.id };
    }

    case "UPDATE_ADJUSTMENT_LAYER":
      return {
        ...state,
        layers: state.layers.map((l) =>
          l.id === action.payload.id ? action.payload : l,
        ),
      };

    case "REORDER_ADJUSTMENT_LAYERS": {
      const { parentId, orderedChildIds } = action.payload;
      // Build new layers array: keep everything except the children of this parent,
      // then re-insert them in the new order immediately after the parent.
      const childSet = new Set(orderedChildIds);
      const withoutChildren = state.layers.filter((l) => !childSet.has(l.id));
      const parentIdx = withoutChildren.findIndex((l) => l.id === parentId);
      if (parentIdx < 0) return state;
      // Re-order child layers according to orderedChildIds
      const childLayersOrdered = orderedChildIds
        .map((id) => state.layers.find((l) => l.id === id))
        .filter((l): l is LayerState => l !== undefined);
      const next = [...withoutChildren];
      next.splice(parentIdx + 1, 0, ...childLayersOrdered);
      return { ...state, layers: next };
    }

    case "SET_OPEN_ADJUSTMENT":
      return { ...state, openAdjustmentLayerId: action.payload };
    case "SET_ACTIVE_LAYER":
      return { ...state, activeLayerId: action.payload, selectedLayerIds: [] };

    case "SET_SELECTED_LAYERS":
      return { ...state, selectedLayerIds: action.payload };

    case "TOGGLE_LAYER_VISIBILITY": {
      const target = state.layers.find((l) => l.id === action.payload);
      const newVisible = target ? !target.visible : false;
      const affected =
        target && isContainerLayer(target)
          ? new Set([
              action.payload,
              ...getDescendantIds(state.layers, action.payload),
            ])
          : new Set([action.payload]);
      return {
        ...state,
        layers: state.layers.map((l) =>
          affected.has(l.id) ? { ...l, visible: newVisible } : l,
        ),
      };
    }

    case "TOGGLE_LAYER_LOCK": {
      const target = state.layers.find((l) => l.id === action.payload);
      if (!target || ("type" in target && target.type === "mask")) return state;
      // A locked Composite Layer locks its entire subtree. Block per-child
      // unlock attempts so the user can't desynchronise the cascade.
      if (hasLockedCompositeAncestor(state.layers, action.payload))
        return state;
      const newLocked = !(target as { locked: boolean }).locked;
      // Locking a container (group / composite) cascades to every descendant
      // so the user can't accidentally edit a layer baked into the cached
      // composite output. Unlocking releases the cascade.
      const affected = isContainerLayer(target)
        ? new Set([
            action.payload,
            ...getDescendantIds(state.layers, action.payload),
          ])
        : new Set([action.payload]);
      return {
        ...state,
        layers: state.layers.map((l) =>
          affected.has(l.id) && !("type" in l && l.type === "mask")
            ? { ...l, locked: newLocked }
            : l,
        ),
      };
    }

    case "SET_LAYER_OPACITY":
      return {
        ...state,
        layers: state.layers.map((l) =>
          l.id === action.payload.id
            ? { ...l, opacity: action.payload.opacity }
            : l,
        ),
      };

    case "SET_LAYER_BLEND":
      return {
        ...state,
        layers: state.layers.map((l) =>
          l.id === action.payload.id
            ? { ...l, blendMode: action.payload.blendMode }
            : l,
        ),
      };

    case "RENAME_LAYER":
      return {
        ...state,
        layers: state.layers.map((l) =>
          l.id === action.payload.id ? { ...l, name: action.payload.name } : l,
        ),
      };

    case "REORDER_LAYERS": {
      // A locked Composite Layer locks its entire subtree against structural
      // changes. Reject any reorder that:
      //   - adds new ids to a locked composite's childIds, OR
      //   - reorders existing ids inside a locked composite, OR
      //   - changes any descendant container's childIds (intra-group reorder
      //     while that group is itself nested inside a locked composite).
      const next = action.payload;
      const nextById = new Map(next.map((l) => [l.id, l]));
      for (const prev of state.layers) {
        if (!isContainerLayer(prev)) continue;
        const updated = nextById.get(prev.id);
        if (!updated || !isContainerLayer(updated)) continue;
        const lockedAncestor =
          (isCompositeLayer(prev) && prev.locked) ||
          hasLockedCompositeAncestor(state.layers, prev.id);
        if (!lockedAncestor) continue;
        // Compare childIds arrays in order — any difference is rejected.
        if (prev.childIds.length !== updated.childIds.length) return state;
        for (let i = 0; i < prev.childIds.length; i++) {
          if (prev.childIds[i] !== updated.childIds[i]) return state;
        }
      }
      return { ...state, layers: next, selectedLayerIds: [] };
    }

    case "ADD_TEXT_LAYER":
      return {
        ...state,
        layers: [...state.layers, action.payload],
        activeLayerId: action.payload.id,
      };

    case "UPDATE_TEXT_LAYER":
      return {
        ...state,
        layers: state.layers.map((l) =>
          l.id === action.payload.id ? action.payload : l,
        ),
      };

    case "ADD_SHAPE_LAYER":
      return {
        ...state,
        layers: [...state.layers, action.payload],
        activeLayerId: action.payload.id,
      };

    case "UPDATE_SHAPE_LAYER":
      return {
        ...state,
        layers: state.layers.map((l) =>
          l.id === action.payload.id ? action.payload : l,
        ),
      };

    case "ADD_FRAME_LAYER":
      return {
        ...state,
        layers: [...state.layers, action.payload],
        activeLayerId: action.payload.id,
      };

    case "UPDATE_FRAME_LAYER":
      return {
        ...state,
        layers: state.layers.map((l) =>
          l.id === action.payload.id ? action.payload : l,
        ),
      };

    case "SET_ZOOM":
      return { ...state, canvas: { ...state.canvas, zoom: action.payload } };

    case "TOGGLE_GRID":
      return {
        ...state,
        canvas: { ...state.canvas, showGrid: !state.canvas.showGrid },
      };

    case "TOGGLE_RULERS":
      return {
        ...state,
        canvas: { ...state.canvas, showRulers: !state.canvas.showRulers },
      };

    case "TOGGLE_GUIDES":
      return {
        ...state,
        canvas: { ...state.canvas, showGuides: !state.canvas.showGuides },
      };

    case "ADD_GUIDE":
      return {
        ...state,
        canvas: {
          ...state.canvas,
          guides: [...state.canvas.guides, action.payload],
        },
      };

    case "MOVE_GUIDE":
      return {
        ...state,
        canvas: {
          ...state.canvas,
          guides: state.canvas.guides.map((g) =>
            g.id === action.payload.id
              ? { ...g, position: action.payload.position }
              : g,
          ),
        },
      };

    case "DELETE_GUIDE":
      return {
        ...state,
        canvas: {
          ...state.canvas,
          guides: state.canvas.guides.filter((g) => g.id !== action.payload),
        },
      };

    case "CLEAR_GUIDES":
      return { ...state, canvas: { ...state.canvas, guides: [] } };

    case "SET_TILED_MODE":
      return {
        ...state,
        canvas: {
          ...state.canvas,
          tiledMode: action.payload,
          showTileGrid: action.payload ? state.canvas.showTileGrid : false,
        },
      };

    case "SET_SHOW_TILE_GRID":
      return {
        ...state,
        canvas: { ...state.canvas, showTileGrid: action.payload },
      };

    case "SET_ANIMATION_MODE":
      return { ...state, animationMode: action.payload };

    case "SET_SPRITESHEET":
      return {
        ...state,
        spritesheet: { ...state.spritesheet, ...action.payload },
      };

    case "ADD_ANIMATION":
      return {
        ...state,
        spritesheet: {
          ...state.spritesheet,
          animations: [...state.spritesheet.animations, action.payload],
          selectedAnimationId: action.payload.id,
        },
      };

    case "UPDATE_ANIMATION":
      return {
        ...state,
        spritesheet: {
          ...state.spritesheet,
          animations: state.spritesheet.animations.map((a) =>
            a.id === action.payload.id ? action.payload : a,
          ),
        },
      };

    case "DELETE_ANIMATION": {
      const remaining = state.spritesheet.animations.filter(
        (a) => a.id !== action.payload,
      );
      const nextSel =
        state.spritesheet.selectedAnimationId === action.payload
          ? (remaining[0]?.id ?? null)
          : state.spritesheet.selectedAnimationId;
      return {
        ...state,
        spritesheet: {
          ...state.spritesheet,
          animations: remaining,
          selectedAnimationId: nextSel,
          selectedFrameId: null,
        },
      };
    }

    case "SET_SELECTED_ANIMATION":
      return {
        ...state,
        spritesheet: {
          ...state.spritesheet,
          selectedAnimationId: action.payload,
          selectedFrameId: null,
        },
      };

    case "SET_SELECTED_FRAME":
      return {
        ...state,
        spritesheet: { ...state.spritesheet, selectedFrameId: action.payload },
      };

    case "ADD_FRAME":
      return {
        ...state,
        spritesheet: {
          ...state.spritesheet,
          animations: state.spritesheet.animations.map((a) =>
            a.id === action.payload.animationId
              ? { ...a, frames: [...a.frames, action.payload.frame] }
              : a,
          ),
        },
      };

    case "UPDATE_FRAME":
      return {
        ...state,
        spritesheet: {
          ...state.spritesheet,
          animations: state.spritesheet.animations.map((a) =>
            a.id === action.payload.animationId
              ? {
                  ...a,
                  frames: a.frames.map((f) =>
                    f.id === action.payload.frame.id ? action.payload.frame : f,
                  ),
                }
              : a,
          ),
        },
      };

    case "DELETE_FRAME": {
      const nextSelectedFrameId =
        state.spritesheet.selectedFrameId === action.payload.frameId
          ? null
          : state.spritesheet.selectedFrameId;
      return {
        ...state,
        spritesheet: {
          ...state.spritesheet,
          selectedFrameId: nextSelectedFrameId,
          animations: state.spritesheet.animations.map((a) =>
            a.id === action.payload.animationId
              ? {
                  ...a,
                  frames: a.frames.filter(
                    (f) => f.id !== action.payload.frameId,
                  ),
                }
              : a,
          ),
        },
      };
    }

    case "SET_GRID_SIZE":
      return {
        ...state,
        canvas: { ...state.canvas, gridSize: Math.max(1, action.payload) },
      };

    case "SET_GRID_COLOR":
      return {
        ...state,
        canvas: { ...state.canvas, gridColor: action.payload },
      };

    case "SET_GRID_TYPE":
      return {
        ...state,
        canvas: { ...state.canvas, gridType: action.payload },
      };

    case "SET_HISTORY":
      return { ...state, history: action.payload };

    case "SET_PIXEL_FORMAT":
      return { ...state, pixelFormat: action.payload };

    case "SET_ACTIVE_SWATCH":
      return { ...state, activePaletteIndex: action.payload };

    case "CLEAR_REMOVED_SWATCH_INDEX":
      return { ...state, lastRemovedSwatchIndex: null };

    case "NEW_CANVAS":
      return {
        ...state,
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
        selectedLayerIds: [],
        pixelFormat: action.payload.pixelFormat ?? "rgba8",
        animationMode: false,
        spritesheet: initialState.spritesheet,
        canvas: {
          ...state.canvas,
          width: action.payload.width,
          height: action.payload.height,
          backgroundFill: action.payload.backgroundFill,
          zoom: 1,
          panX: 0,
          panY: 0,
          guides: [],
          key: state.canvas.key + 1,
        },
        history: { canUndo: false, canRedo: false },
      };

    case "OPEN_FILE":
      return {
        ...state,
        layers: action.payload.layers,
        activeLayerId: action.payload.activeLayerId,
        selectedLayerIds: [],
        pixelFormat: action.payload.pixelFormat ?? "rgba8",
        canvas: {
          ...state.canvas,
          width: action.payload.width,
          height: action.payload.height,
          zoom: 1,
          panX: 0,
          panY: 0,
          guides: [],
          key: state.canvas.key + 1,
        },
        history: { canUndo: false, canRedo: false },
      };

    case "RESTORE_LAYERS":
      return {
        ...state,
        layers: action.payload.layers,
        activeLayerId: action.payload.activeLayerId,
        selectedLayerIds: [],
      };

    case "RESIZE_CANVAS":
      return {
        ...state,
        canvas: {
          ...state.canvas,
          width: action.payload.width,
          height: action.payload.height,
          // canvas.key intentionally NOT incremented — per-tab canvasKey handles remounting
        },
      };

    case "RESTORE_TAB":
      return {
        ...state,
        layers: action.payload.layers,
        activeLayerId: action.payload.activeLayerId,
        selectedLayerIds: [],
        pixelFormat: action.payload.pixelFormat ?? "rgba8",
        canvas: {
          ...state.canvas,
          width: action.payload.width,
          height: action.payload.height,
          backgroundFill: action.payload.backgroundFill,
          zoom: action.payload.zoom,
          panX: 0,
          panY: 0,
          tiledMode: action.payload.tiledMode ?? false,
          showTileGrid: action.payload.showTileGrid ?? false,
          key: state.canvas.key + 1,
        },
        history: { canUndo: false, canRedo: false },
      };

    case "SWITCH_TAB":
      // Same as RESTORE_TAB but does NOT increment canvas.key and does NOT reset history.
      // Used for fast tab switching where the Canvas stays mounted.
      return {
        ...state,
        layers: action.payload.layers,
        activeLayerId: action.payload.activeLayerId,
        selectedLayerIds: [],
        pixelFormat: action.payload.pixelFormat ?? "rgba8",
        animationMode: false,
        spritesheet: initialState.spritesheet,
        canvas: {
          ...state.canvas,
          width: action.payload.width,
          height: action.payload.height,
          backgroundFill: action.payload.backgroundFill,
          zoom: action.payload.zoom,
          tiledMode: action.payload.tiledMode ?? false,
          showTileGrid: action.payload.showTileGrid ?? false,
        },
      };

    case "ADD_LAYER_GROUP": {
      const { id, name, aboveLayerId } = action.payload;
      const newGroup: GroupLayerState = {
        id,
        name,
        visible: true,
        opacity: 1,
        locked: false,
        blendMode: "pass-through",
        type: "group",
        collapsed: false,
        childIds: [],
      };
      if (!aboveLayerId) {
        return {
          ...state,
          layers: [...state.layers, newGroup],
          activeLayerId: id,
        };
      }
      const idx = state.layers.findIndex((l) => l.id === aboveLayerId);
      const insertAt = idx >= 0 ? idx + 1 : state.layers.length;
      const next = [...state.layers];
      next.splice(insertAt, 0, newGroup);
      return { ...state, layers: next, activeLayerId: id };
    }

    case "ADD_COMPOSITE_LAYER": {
      const { id, name, aboveLayerId } = action.payload;
      const newComposite: CompositeLayerState = {
        id,
        name,
        visible: true,
        opacity: 1,
        locked: false,
        blendMode: "normal",
        type: "composite",
        collapsed: false,
        childIds: [],
      };
      if (!aboveLayerId) {
        return {
          ...state,
          layers: [...state.layers, newComposite],
          activeLayerId: id,
        };
      }
      const idx = state.layers.findIndex((l) => l.id === aboveLayerId);
      const insertAt = idx >= 0 ? idx + 1 : state.layers.length;
      const next = [...state.layers];
      next.splice(insertAt, 0, newComposite);
      return { ...state, layers: next, activeLayerId: id };
    }

    case "GROUP_LAYERS": {
      const { groupId, groupName, layerIds } = action.payload;
      if (layerIds.length === 0) return state;
      const layerIdSet = new Set(layerIds);

      // Determine parent context (they must all share one parent; enforced by UI).
      const parentGroup = getParentGroup(state.layers, layerIds[0]);

      // Remove the layers from their current parent's childIds (if in a group/composite).
      let nextLayers = state.layers.map((l) =>
        isContainerLayer(l)
          ? { ...l, childIds: l.childIds.filter((id) => !layerIdSet.has(id)) }
          : l,
      );

      // Create the new group with childIds in the caller's supplied order.
      const newGroup: GroupLayerState = {
        id: groupId,
        name: groupName,
        visible: true,
        opacity: 1,
        locked: false,
        blendMode: "pass-through",
        type: "group",
        collapsed: false,
        childIds: layerIds,
      };

      if (parentGroup) {
        // Insert group into parent's childIds at the position of the topmost selected layer.
        const topmostIdx = parentGroup.childIds.findIndex((id) =>
          layerIdSet.has(id),
        );
        const insertPos =
          topmostIdx >= 0 ? topmostIdx : parentGroup.childIds.length;

        // Insert the group layer into the flat array at the position of the first selected layer in flat order.
        const firstFlatIdx = nextLayers.findIndex((l) => l.id === layerIds[0]);
        nextLayers.splice(firstFlatIdx, 0, newGroup);

        // Update the parent's childIds to include the new group.
        nextLayers = nextLayers.map((l) =>
          l.id === parentGroup.id && isContainerLayer(l)
            ? {
                ...l,
                childIds: [
                  ...l.childIds.slice(0, insertPos),
                  groupId,
                  ...l.childIds.slice(insertPos),
                ],
              }
            : l,
        );
      } else {
        // Root-level insertion: place the group in the flat array above the topmost selected layer.
        const topmostFlatIdx = Math.max(
          ...layerIds.map((id) => nextLayers.findIndex((l) => l.id === id)),
        );
        nextLayers.splice(topmostFlatIdx + 1, 0, newGroup);
      }

      return {
        ...state,
        layers: nextLayers,
        activeLayerId: groupId,
        selectedLayerIds: [],
      };
    }

    case "UNGROUP_LAYERS": {
      const { groupId } = action.payload;
      const group = state.layers.find((l) => l.id === groupId);
      if (!group || !isGroupLayer(group)) return state;

      const parentGroup = getParentGroup(state.layers, groupId);
      let nextLayers: LayerState[];

      if (parentGroup) {
        // Insert children into parent's childIds at group's former position.
        const groupPosInParent = parentGroup.childIds.indexOf(groupId);
        nextLayers = state.layers
          .filter((l) => l.id !== groupId)
          .map((l) =>
            l.id === parentGroup.id && isContainerLayer(l)
              ? {
                  ...l,
                  childIds: [
                    ...l.childIds.slice(0, groupPosInParent),
                    ...group.childIds,
                    ...l.childIds.slice(groupPosInParent + 1),
                  ],
                }
              : l,
          );
      } else {
        // Root level: remove group from flat array; children remain in flat array as root layers.
        nextLayers = state.layers.filter((l) => l.id !== groupId);
      }

      const topmostChild = group.childIds[group.childIds.length - 1] ?? null;
      return {
        ...state,
        layers: nextLayers,
        activeLayerId: topmostChild,
        selectedLayerIds: [],
      };
    }

    case "TOGGLE_GROUP_COLLAPSE": {
      return {
        ...state,
        layers: state.layers.map((l) =>
          l.id === action.payload && isContainerLayer(l)
            ? { ...l, collapsed: !l.collapsed }
            : l,
        ),
      };
    }

    case "MOVE_LAYER_INTO_GROUP": {
      const { layerId, targetGroupId, insertIndex } = action.payload;
      // Block any structural change that touches a locked Composite Layer's
      // subtree: moving INTO it, moving OUT of it, or reordering WITHIN it
      // (drag-and-drop reorder routes through here as remove+reinsert).
      const targetGroup = state.layers.find((l) => l.id === targetGroupId);
      if (targetGroup && isCompositeLayer(targetGroup) && targetGroup.locked)
        return state;
      if (hasLockedCompositeAncestor(state.layers, targetGroupId)) return state;
      if (hasLockedCompositeAncestor(state.layers, layerId)) return state;
      // Remove from current parent's childIds (if any).
      let nextLayers = state.layers.map((l) =>
        isContainerLayer(l) && l.id !== targetGroupId
          ? { ...l, childIds: l.childIds.filter((id) => id !== layerId) }
          : l,
      );
      // Insert into target group's childIds.
      nextLayers = nextLayers.map((l) => {
        if (!isContainerLayer(l) || l.id !== targetGroupId) return l;
        const idx = insertIndex !== undefined ? insertIndex : 0;
        const next = [...l.childIds.filter((id) => id !== layerId)];
        next.splice(Math.max(0, Math.min(idx, next.length)), 0, layerId);
        return { ...l, childIds: next };
      });
      return { ...state, layers: nextLayers };
    }

    case "MOVE_LAYER_OUT_OF_GROUP": {
      const { layerId, targetParentGroupId, insertIndex } = action.payload;
      // Block if the layer is currently inside a locked Composite Layer
      // subtree, or if the destination parent is.
      if (hasLockedCompositeAncestor(state.layers, layerId)) return state;
      if (targetParentGroupId !== null) {
        const targetParent = state.layers.find(
          (l) => l.id === targetParentGroupId,
        );
        if (
          targetParent &&
          isCompositeLayer(targetParent) &&
          targetParent.locked
        )
          return state;
        if (hasLockedCompositeAncestor(state.layers, targetParentGroupId))
          return state;
      }
      // Remove from all containers' childIds.
      let nextLayers = state.layers.map((l) =>
        isContainerLayer(l)
          ? { ...l, childIds: l.childIds.filter((id) => id !== layerId) }
          : l,
      );
      if (targetParentGroupId !== null) {
        // Insert into target container at insertIndex.
        nextLayers = nextLayers.map((l) => {
          if (!isContainerLayer(l) || l.id !== targetParentGroupId) return l;
          const next = [...l.childIds];
          next.splice(
            Math.max(0, Math.min(insertIndex, next.length)),
            0,
            layerId,
          );
          return { ...l, childIds: next };
        });
      }
      // If targetParentGroupId === null, the layer becomes root.
      // Its flat array position already determines root render order.
      return { ...state, layers: nextLayers };
    }

    default:
      return state;
  }
}

// ─── Context ──────────────────────────────────────────────────────────────────

interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [state, dispatch] = useReducer(appReducer, initialState);
  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be used within an AppProvider");
  return ctx;
}
