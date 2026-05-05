import type {
  LayerState,
  GroupLayerState,
  CompositeLayerState,
  MaskLayerState,
  AdjustmentLayerState,
} from "@/types";
import { isContainerLayer, isCompositeLayer } from "@/types";

// ─── Root layer IDs ───────────────────────────────────────────────────────────

/** All layer IDs not appearing in any group's/composite's childIds — in their flat-array order. */
export function buildRootLayerIds(layers: readonly LayerState[]): string[] {
  const inGroup = new Set<string>();
  for (const l of layers) {
    if (isContainerLayer(l)) {
      for (const id of l.childIds) inGroup.add(id);
    }
  }
  return layers.filter((l) => !inGroup.has(l.id)).map((l) => l.id);
}

// ─── Parent lookup ────────────────────────────────────────────────────────────

/** Direct parent container (group or composite) of a layer, or null if it is a root layer. */
export function getParentGroup(
  layers: readonly LayerState[],
  layerId: string,
): GroupLayerState | CompositeLayerState | null {
  for (const l of layers) {
    if (isContainerLayer(l) && l.childIds.includes(layerId)) return l;
  }
  return null;
}

// ─── Descendants ──────────────────────────────────────────────────────────────

/** All descendant IDs of a group (recursive, all depths). Includes direct children. */
export function getDescendantIds(
  layers: readonly LayerState[],
  groupId: string,
): string[] {
  const layersById = new Map(layers.map((l) => [l.id, l]));
  const result: string[] = [];

  function collect(id: string): void {
    const l = layersById.get(id);
    if (!l) return;
    if (isContainerLayer(l)) {
      for (const childId of l.childIds) {
        result.push(childId);
        collect(childId);
      }
    }
  }

  collect(groupId);
  return result;
}

/** True if candidateId is anywhere in the subtree rooted at ancestorId. */
export function isDescendantOf(
  layers: readonly LayerState[],
  candidateId: string,
  ancestorId: string,
): boolean {
  const layersById = new Map(layers.map((l) => [l.id, l]));

  function check(id: string): boolean {
    const l = layersById.get(id);
    if (!l || !isContainerLayer(l)) return false;
    for (const childId of l.childIds) {
      if (childId === candidateId) return true;
      if (check(childId)) return true;
    }
    return false;
  }

  return check(ancestorId);
}

/** True if `layerId` has any locked Composite Layer ancestor (excluding itself).
 *  Used to enforce "locked composite locks all descendants" semantics: child
 *  unlock, child delete, mask creation, and "move into" actions are blocked
 *  whenever this returns true. */
export function hasLockedCompositeAncestor(
  layers: readonly LayerState[],
  layerId: string,
): boolean {
  let current = layerId;
  for (;;) {
    const parent = getParentGroup(layers, current);
    if (!parent) return false;
    if (isCompositeLayer(parent) && parent.locked) return true;
    current = parent.id;
  }
}

// ─── Depth ────────────────────────────────────────────────────────────────────

/** Nesting depth of a layer: 0 = root, 1 = inside one group, etc. */
export function getLayerDepth(
  layers: readonly LayerState[],
  layerId: string,
): number {
  let depth = 0;
  let current = layerId;
  for (;;) {
    const parent = getParentGroup(layers, current);
    if (!parent) break;
    depth++;
    current = parent.id;
  }
  return depth;
}

// ─── Tree walk ────────────────────────────────────────────────────────────────

/**
 * Walk the layer tree in display order (top of panel first = highest render priority).
 * Yields each layer with its nesting depth. Mask and per-layer adjustment layers are
 * yielded at depth+1 immediately after their pixel parent.
 */
export function* walkLayerTree(
  layers: readonly LayerState[],
): Generator<{ layer: LayerState; depth: number }> {
  const rootIds = buildRootLayerIds(layers);
  const layersById = new Map(layers.map((l) => [l.id, l]));

  // Collect attached child layers (mask / per-layer adjustment) of a given pixel parent.
  function getAttached(pixelId: string): LayerState[] {
    return layers.filter(
      (l) =>
        "type" in l &&
        (l.type === "mask" || l.type === "adjustment") &&
        (l as MaskLayerState | AdjustmentLayerState).parentId === pixelId,
    );
  }

  function* walkIds(
    ids: readonly string[],
    depth: number,
  ): Generator<{ layer: LayerState; depth: number }> {
    // Reverse for display order: highest render index first (top of panel).
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      const layer = layersById.get(id);
      if (!layer) continue;

      // Skip mask / per-layer adjustment layers here — they are yielded under
      // their pixel parent below.
      if (
        "type" in layer &&
        (layer.type === "mask" || layer.type === "adjustment")
      ) {
        // Only skip if parentId points to a non-container layer (per-layer attachment).
        const parent = layersById.get(
          (layer as MaskLayerState | AdjustmentLayerState).parentId,
        );
        if (parent && !isContainerLayer(parent)) continue;
        // Group/composite-scoped adjustment: fall through and yield.
      }

      yield { layer, depth };

      if (isContainerLayer(layer)) {
        yield* walkIds(layer.childIds, depth + 1);
      } else if (
        !("type" in layer) ||
        (layer.type !== "mask" && layer.type !== "adjustment")
      ) {
        // Pixel / text / shape: also yield attached children.
        for (const child of getAttached(layer.id)) {
          yield { layer: child, depth: depth + 1 };
        }
      }
    }
  }

  yield* walkIds(rootIds, 0);
}

// ─── Root-layer reordering ────────────────────────────────────────────────────

/**
 * Reorder root layers by moving srcId to dstIndex (0 = topmost in the panel).
 * Returns a new flat LayerState[] with the root-layer order changed.
 * Non-root layers (group children, attached masks/adjustments) move with their
 * logical parent.
 */
export function reorderRootLayers(
  layers: readonly LayerState[],
  srcId: string,
  dstIndex: number,
): LayerState[] {
  const { clusters, remaining } = buildClusters(layers);

  const realRootIds = clusters.map((c) => c[0].id);
  const srcClusterIdx = realRootIds.findIndex((id) => id === srcId);
  if (srcClusterIdx === -1) return [...layers];

  const [srcCluster] = clusters.splice(srcClusterIdx, 1);
  // dstIndex 0 = topmost in panel = highest render priority = last in render order.
  const renderDst = Math.max(
    0,
    Math.min(clusters.length, clusters.length - dstIndex),
  );
  clusters.splice(renderDst, 0, srcCluster);

  return [...clusters.flat(), ...remaining];
}

/**
 * Build ordered clusters (bottom-to-top) from a flat layer array.
 * Each cluster is [rootLayer, ...children/masks/adjustments].
 * `remaining` contains layers not covered by any cluster (orphaned sub-layers).
 */
export function buildClusters(layers: readonly LayerState[]): {
  clusters: LayerState[][];
  remaining: LayerState[];
} {
  const realRootIds = buildRootLayerIds(layers).filter((id) => {
    const l = layers.find((x) => x.id === id);
    return (
      l !== undefined &&
      !("type" in l && (l.type === "mask" || l.type === "adjustment"))
    );
  });

  function collectCluster(rootId: string): LayerState[] {
    const root = layers.find((l) => l.id === rootId);
    if (!root) return [];
    const cluster: LayerState[] = [root];
    const usedIds = new Set<string>([rootId]);

    if (isContainerLayer(root)) {
      const descIds = getDescendantIds(layers, rootId);
      for (const id of descIds) {
        const l = layers.find((x) => x.id === id);
        if (l) {
          cluster.push(l);
          usedIds.add(id);
        }
      }
      for (const l of layers) {
        if ("type" in l && (l.type === "mask" || l.type === "adjustment")) {
          const parentId = (l as MaskLayerState | AdjustmentLayerState)
            .parentId;
          if (usedIds.has(parentId) && !usedIds.has(l.id)) {
            cluster.push(l);
            usedIds.add(l.id);
          }
        }
      }
    } else {
      for (const l of layers) {
        if (
          "type" in l &&
          (l.type === "mask" || l.type === "adjustment") &&
          (l as MaskLayerState | AdjustmentLayerState).parentId === rootId
        ) {
          cluster.push(l);
          usedIds.add(l.id);
        }
      }
    }
    return cluster;
  }

  const clusters = realRootIds.map((id) => collectCluster(id));
  const usedIds = new Set(clusters.flat().map((l) => l.id));
  const remaining = layers.filter((l) => !usedIds.has(l.id));
  return { clusters, remaining };
}

// ─── Deep duplicate ───────────────────────────────────────────────────────────

/**
 * Deep-duplicate a group and all its descendants, generating fresh IDs.
 * Returns new LayerState[] entries (not the full array) and a Map of old→new IDs.
 */
export function deepDuplicateGroup(
  layers: readonly LayerState[],
  groupId: string,
): { newLayers: LayerState[]; idMap: Map<string, string> } {
  const layersById = new Map(layers.map((l) => [l.id, l]));
  const idMap = new Map<string, string>();
  const newLayers: LayerState[] = [];

  function ensureId(oldId: string): string {
    if (!idMap.has(oldId)) idMap.set(oldId, crypto.randomUUID());
    return idMap.get(oldId)!;
  }

  function dupe(layerId: string): void {
    const layer = layersById.get(layerId);
    if (!layer) return;
    const newId = ensureId(layerId);

    if (isContainerLayer(layer)) {
      for (const childId of layer.childIds) dupe(childId);
      const newContainer = {
        ...layer,
        id: newId,
        childIds: layer.childIds.map((id) => idMap.get(id) ?? id),
      } as GroupLayerState | CompositeLayerState;
      newLayers.push(newContainer);
    } else {
      const newLayer = { ...layer, id: newId } as LayerState;
      newLayers.push(newLayer);
      // Duplicate attached mask/adjustment layers.
      const attached = layers.filter(
        (l) =>
          "type" in l &&
          (l.type === "mask" || l.type === "adjustment") &&
          (l as MaskLayerState | AdjustmentLayerState).parentId === layerId,
      );
      for (const child of attached) {
        const newChildId = ensureId(child.id);
        const newChild = {
          ...child,
          id: newChildId,
          parentId: newId,
        } as LayerState;
        newLayers.push(newChild);
      }
    }
  }

  dupe(groupId);
  return { newLayers, idMap };
}
