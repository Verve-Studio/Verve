import type { LayerState, RGBAColor, PixelFormat } from "@/types";
import type { EffectLayerState } from "@/core/effects/effectTypes";
import { isGroupLayer, isCompositeLayer, isContainerLayer } from "@/types";
import { effectRegistry } from "@/core/effects";
import type {
  GpuLayer,
  EffectRenderOp,
  RenderPlanEntry,
  SourceLayer,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import { buildRootLayerIds } from "@/utils/layerTree";

interface PlanInputs {
  layers: readonly LayerState[];
  glLayers: Map<string, GpuLayer>;
  maskMap: Map<string, GpuLayer>;
  adjustmentMaskMap: Map<string, GpuLayer>;
  bypassedAdjustmentIds: ReadonlySet<string>;
  swatches: RGBAColor[];
  pixelFormat: PixelFormat;
}

/**
 * Plans the effects attached to a layer, and resolves layer names to the
 * layer as it renders for effects that read other layers (Sample Layer).
 * Resolving a layer plans its effects, which may resolve further layers, so
 * a layer whose effects are being planned resolves to its raw pixels: a
 * layer sampling itself, or layers sampling each other, can't recurse.
 */
class PlanResolver {
  private byName: Map<string, string> | null = null;
  /** Resolved sources that didn't hit a cycle (those depend on where they
   *  were resolved from). */
  private readonly memo = new Map<string, SourceLayer>();
  /** Layers whose attached effects are being planned. */
  private readonly planning = new Set<string>();
  private cycleCut = false;

  constructor(private readonly p: PlanInputs) {}

  readonly resolve = (name: string): SourceLayer | undefined => {
    if (!this.byName) {
      this.byName = new Map();
      for (const l of this.p.layers) {
        if ("type" in l && (l.type === "adjustment" || l.type === "mask")) continue;
        if (this.p.glLayers.has(l.id) && !this.byName.has(l.name)) this.byName.set(l.name, l.id);
      }
    }
    const id = this.byName.get(name);
    if (id === undefined) return undefined;
    const layer = this.p.glLayers.get(id)!;
    const mask = this.p.maskMap.get(id);
    if (this.planning.has(id)) {
      this.cycleCut = true;
      return { layer, mask, adjustments: [] };
    }
    const hit = this.memo.get(id);
    if (hit) return hit;
    const outerCut = this.cycleCut;
    this.cycleCut = false;
    const source: SourceLayer = { layer, mask, adjustments: this.attachedEffects(id, layer) };
    if (!this.cycleCut) this.memo.set(id, source);
    this.cycleCut ||= outerCut;
    return source;
  };

  /** The visible effects attached to layer `parentId`, in stack order. */
  attachedEffects(parentId: string, parent?: GpuLayer): EffectRenderOp[] {
    const { layers, pixelFormat, bypassedAdjustmentIds, adjustmentMaskMap, swatches } = this.p;
    if (pixelFormat === "indexed8") return [];
    this.planning.add(parentId);
    try {
      const ops: EffectRenderOp[] = [];
      for (const adj of layers) {
        if (
          "type" in adj &&
          adj.type === "adjustment" &&
          adj.visible !== false &&
          (adj as EffectLayerState).parentId === parentId &&
          !bypassedAdjustmentIds.has(adj.id)
        ) {
          const op = buildAdjustmentEntry(
            adj as EffectLayerState,
            adjustmentMaskMap.get(adj.id),
            swatches,
            this.resolve,
            parent,
          );
          if (op) ops.push(op);
        }
      }
      return ops;
    } finally {
      this.planning.delete(parentId);
    }
  }
}

export function buildAdjustmentEntry(
  ls: EffectLayerState,
  mask: GpuLayer | undefined,
  swatches: RGBAColor[],
  resolveLayer: (name: string) => SourceLayer | undefined,
  parent?: GpuLayer,
): EffectRenderOp | null {
  const effect = effectRegistry.get(ls.effectType);
  if (!effect) {
    throw new Error(
      `[buildAdjustmentEntry] no effect registered for effectType=${ls.effectType}`,
    );
  }
  const parentRect = parent && {
    x: parent.offsetX,
    y: parent.offsetY,
    width: parent.layerWidth,
    height: parent.layerHeight,
  };
  return effect.buildPlanEntry(ls, { mask, swatches, parentRect, resolveLayer });
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
  const inputs: PlanInputs = {
    layers,
    glLayers,
    maskMap,
    adjustmentMaskMap,
    bypassedAdjustmentIds,
    swatches,
    pixelFormat,
  };
  return planIds(orderedIds, inputs, new Map(layers.map((l) => [l.id, l])), new PlanResolver(inputs));
}

function planIds(
  orderedIds: readonly string[],
  p: PlanInputs,
  layersById: ReadonlyMap<string, LayerState>,
  resolver: PlanResolver,
): RenderPlanEntry[] {
  const plan: RenderPlanEntry[] = [];

  for (const id of orderedIds) {
    const ls = layersById.get(id);
    if (!ls) continue;

    // Skip mask layers — handled via their pixel parent
    if ("type" in ls && ls.type === "mask") continue;

    // Adjustment layers
    if ("type" in ls && ls.type === "adjustment") {
      if (p.pixelFormat === "indexed8") continue;
      const adjLs = ls as EffectLayerState;
      const parent = layersById.get(adjLs.parentId);
      // Per-layer attachment (parentId → non-container layer): skip, bundled with pixel parent
      if (parent && !isContainerLayer(parent)) continue;
      // Composite-layer attachment: bundled into composite-layer entry, skip standalone emission
      if (parent && isCompositeLayer(parent)) continue;
      // Group-scoped adjustment: treat as standalone
      if (p.bypassedAdjustmentIds.has(ls.id)) continue;
      // Invisible adjustments are no-ops — omit from plan so planIsFlatLayersOnly
      // stays true and the incremental paint path remains available.
      if (!adjLs.visible) continue;
      const entry = buildAdjustmentEntry(
        adjLs,
        p.adjustmentMaskMap.get(ls.id),
        p.swatches,
        resolver.resolve,
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
        children: planIds(ls.childIds, p, layersById, resolver),
      });
      continue;
    }

    // Composite layer → flatten children, apply attached adjustments
    if (isCompositeLayer(ls)) {
      plan.push({
        kind: "composite-layer",
        layerId: ls.id,
        opacity: ls.opacity,
        blendMode: ls.blendMode,
        visible: ls.visible,
        children: planIds(ls.childIds, p, layersById, resolver),
        adjustments: resolver.attachedEffects(ls.id),
        locked: ls.locked === true,
      });
      continue;
    }

    // Pixel-bearing leaf layer (pixel, text, shape, frame) — collect any
    // attached per-layer adjustments and either bundle them into an
    // adjustment-group or emit a plain layer entry.
    const baseLayer = p.glLayers.get(ls.id);
    if (!baseLayer) continue;

    const adjustments = resolver.attachedEffects(ls.id, baseLayer);

    if (adjustments.length > 0) {
      const isLocked =
        "locked" in ls && (ls as { locked: boolean }).locked === true;
      plan.push({
        kind: "adjustment-group",
        parentLayerId: ls.id,
        baseLayer,
        baseMask: p.maskMap.get(ls.id),
        adjustments,
        locked: isLocked || undefined,
      });
    } else {
      plan.push({ kind: "layer", layer: baseLayer, mask: p.maskMap.get(ls.id) });
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
