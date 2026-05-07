import type {
  AdjustmentLayerState,
  LayerState,
  RGBAColor,
  PixelFormat,
} from "@/types";
import { isGroupLayer, isCompositeLayer, isContainerLayer } from "@/types";
import { effectRegistry } from "@/core/effects";
import type {
  GpuLayer,
  AdjustmentRenderOp,
  RenderPlanEntry,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import { buildRootLayerIds } from "@/utils/layerTree";

export function buildAdjustmentEntry(
  ls: AdjustmentLayerState,
  mask: GpuLayer | undefined,
  swatches: RGBAColor[],
): AdjustmentRenderOp | null {
  const effect = effectRegistry.get(ls.adjustmentType);
  if (!effect) {
    throw new Error(
      `[buildAdjustmentEntry] no effect registered for adjustmentType=${ls.adjustmentType}`,
    );
  }
  return effect.buildPlanEntry(ls, { mask, swatches });
}

export function buildSubPlan(
  orderedIds: readonly string[],
  layers: readonly LayerState[],
  glLayers: Map<string, GpuLayer>,
  maskMap: Map<string, GpuLayer>,
  adjustmentMaskMap: Map<string, GpuLayer>,
  bypassedAdjustmentIds: ReadonlySet<string>,
  swatches: RGBAColor[],
  pixelFormat: PixelFormat = "rgba8",
): RenderPlanEntry[] {
  const layersById = new Map(layers.map((l) => [l.id, l]));
  const plan: RenderPlanEntry[] = [];

  for (const id of orderedIds) {
    const ls = layersById.get(id);
    if (!ls) continue;

    // Skip mask layers — handled via their pixel parent
    if ("type" in ls && ls.type === "mask") continue;

    // Adjustment layers
    if ("type" in ls && ls.type === "adjustment") {
      if (pixelFormat === "indexed8") continue;
      const adjLs = ls as AdjustmentLayerState;
      const parent = layersById.get(adjLs.parentId);
      // Per-layer attachment (parentId → non-container layer): skip, bundled with pixel parent
      if (parent && !isContainerLayer(parent)) continue;
      // Composite-layer attachment: bundled into composite-layer entry, skip standalone emission
      if (parent && isCompositeLayer(parent)) continue;
      // Group-scoped adjustment: treat as standalone
      if (bypassedAdjustmentIds.has(ls.id)) continue;
      // Invisible adjustments are no-ops — omit from plan so planIsFlatLayersOnly
      // stays true and the incremental paint path remains available.
      if (!adjLs.visible) continue;
      const entry = buildAdjustmentEntry(
        adjLs,
        adjustmentMaskMap.get(ls.id),
        swatches,
      );
      if (entry) plan.push(entry);
      continue;
    }

    // Group layer → recurse. Groups are purely organisational: always
    // pass-through with full opacity, no mask, no adjustments. For non-trivial
    // compositing semantics use a Composite Layer instead.
    if (isGroupLayer(ls)) {
      plan.push({
        kind: "layer-group",
        groupId: ls.id,
        opacity: 1,
        blendMode: "pass-through",
        visible: ls.visible,
        children: buildSubPlan(
          ls.childIds,
          layers,
          glLayers,
          maskMap,
          adjustmentMaskMap,
          bypassedAdjustmentIds,
          swatches,
          pixelFormat,
        ),
      });
      continue;
    }

    // Composite layer → flatten children, apply attached adjustments
    if (isCompositeLayer(ls)) {
      const attachedAdj: AdjustmentRenderOp[] = [];
      if (pixelFormat !== "indexed8") {
        for (const adj of layers) {
          if (
            "type" in adj &&
            adj.type === "adjustment" &&
            adj.visible !== false &&
            (adj as AdjustmentLayerState).parentId === ls.id &&
            !bypassedAdjustmentIds.has(adj.id)
          ) {
            const op = buildAdjustmentEntry(
              adj as AdjustmentLayerState,
              adjustmentMaskMap.get(adj.id),
              swatches,
            );
            if (op) attachedAdj.push(op);
          }
        }
      }
      plan.push({
        kind: "composite-layer",
        layerId: ls.id,
        opacity: ls.opacity,
        blendMode: ls.blendMode,
        visible: ls.visible,
        children: buildSubPlan(
          ls.childIds,
          layers,
          glLayers,
          maskMap,
          adjustmentMaskMap,
          bypassedAdjustmentIds,
          swatches,
          pixelFormat,
        ),
        adjustments: attachedAdj,
        locked: ls.locked === true,
      });
      continue;
    }

    // Pixel, text, or shape layer — collect attached per-layer adjustments
    const baseLayer = glLayers.get(ls.id);
    if (!baseLayer) continue;

    const adjustments: AdjustmentRenderOp[] = [];
    if (pixelFormat !== "indexed8") {
      for (const adj of layers) {
        if (
          "type" in adj &&
          adj.type === "adjustment" &&
          adj.visible !== false &&
          (adj as AdjustmentLayerState).parentId === ls.id &&
          !bypassedAdjustmentIds.has(adj.id)
        ) {
          const op = buildAdjustmentEntry(
            adj as AdjustmentLayerState,
            adjustmentMaskMap.get(adj.id),
            swatches,
          );
          if (op) adjustments.push(op);
        }
      }
    }

    if (adjustments.length > 0) {
      const isLocked =
        "locked" in ls && (ls as { locked: boolean }).locked === true;
      plan.push({
        kind: "adjustment-group",
        parentLayerId: ls.id,
        baseLayer,
        baseMask: maskMap.get(ls.id),
        adjustments,
        locked: isLocked || undefined,
      });
    } else {
      plan.push({ kind: "layer", layer: baseLayer, mask: maskMap.get(ls.id) });
    }
  }

  return plan;
}

export function buildRenderPlan(
  layers: readonly LayerState[],
  glLayers: Map<string, GpuLayer>,
  maskMap: Map<string, GpuLayer>,
  adjustmentMaskMap: Map<string, GpuLayer>,
  bypassedAdjustmentIds: ReadonlySet<string>,
  swatches: RGBAColor[],
  pixelFormat: PixelFormat = "rgba8",
): RenderPlanEntry[] {
  return buildSubPlan(
    buildRootLayerIds(layers),
    layers,
    glLayers,
    maskMap,
    adjustmentMaskMap,
    bypassedAdjustmentIds,
    swatches,
    pixelFormat,
  );
}
