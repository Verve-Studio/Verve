# Technical Design: Layer Groups

## Overview

Layer Groups introduce non-destructive organisational containers into the layer stack. A group holds an ordered list of child layers (pixel, text, shape, adjustment, and nested groups) and composites its children into a sub-stack before blending the result into the parent context. Groups with `blendMode = 'pass-through'` skip the intermediate buffer entirely and inline their children directly into the parent composite. This is the direct equivalent of Photoshop's Layer Groups.

The feature touches six areas of the codebase: the type system, the AppContext reducer, the render plan builder (`canvasPlan.ts`), the WebGPU renderer (`WebGPURenderer.ts`), the LayerPanel UI, and `useLayers`. A new `layerTree.ts` utility module provides shared tree traversal helpers consumed by all of the above.

---

## Affected Areas

| File | Change |
|---|---|
| `src/types/index.ts` | Add `GroupLayerState`; add `'pass-through'` to `BlendMode`; update `LayerState` union; add type guard `isGroupLayer` |
| `src/store/AppContext.tsx` | Add `GROUP_LAYERS`, `UNGROUP_LAYERS`, `TOGGLE_GROUP_COLLAPSE`, `ADD_LAYER_GROUP`, `MOVE_LAYER_INTO_GROUP`, `MOVE_LAYER_OUT_OF_GROUP` actions; update `REMOVE_LAYER`, `TOGGLE_LAYER_VISIBILITY`, `DUPLICATE_LAYER` to handle descendants |
| `src/utils/layerTree.ts` | **New file** — all tree-traversal helpers |
| `src/components/window/Canvas/canvasPlan.ts` | Refactor `buildRenderPlan` to recursive `buildSubPlan`; add `layer-group` entry kind to output |
| `src/webgpu/WebGPURenderer.ts` | Add `layer-group` handling to `RenderPlanEntry`; refactor `encodePlanToComposite` into recursive `encodeSubPlan`; add temp-texture allocator for isolated groups |
| `src/hooks/useLayers.ts` | Update merge operations to expand groups; add `handleMergeGroup`; update `handleDuplicateLayer` to deep-copy groups |
| `src/components/panels/LayerPanel/LayerPanel.tsx` | Replace flat `displayLayers` with tree walk; update drag-and-drop; add group footer button, disclosure triangle, context menu entries |
| `src/components/panels/LayerPanel/LayerPanel.module.scss` | Add depth-indent classes, folder thumb, group metadata row, drop-onto-group highlight |
| `src/hooks/useLayerGroups.ts` | **New file** — group-specific operations called by LayerPanel |
| `src/App.tsx` | Wire `useLayerGroups` keyboard shortcuts (Cmd+G, Cmd+Shift+G) |

---

## State Changes

### 1. New type: `GroupLayerState`

```typescript
// src/types/index.ts

export interface GroupLayerState {
  id:        string
  name:      string
  visible:   boolean
  opacity:   number
  locked:    boolean
  blendMode: BlendMode        // includes 'pass-through'
  type:      'group'
  collapsed: boolean          // UI-only; no effect on compositing
  childIds:  string[]         // direct children, ordered bottom-to-top
}
```

`childIds` is the **sole** source of truth for group membership and child render order. The flat `state.layers` array contains every layer including group layers; `childIds` encodes the tree structure on top of it.

### 2. `'pass-through'` added to `BlendMode`

```typescript
export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay'
  | 'soft-light' | 'hard-light' | 'darken' | 'lighten'
  | 'difference' | 'exclusion' | 'color-dodge' | 'color-burn'
  | 'pass-through'     // ← new; only meaningful for GroupLayerState
```

`'pass-through'` is never passed to `BLEND_MODE_INDEX` in the renderer (pass-through groups never call `encodeCompositeTexture`). The LayerPanel blend mode selector shows `Pass Through` as the first option only when the active layer is a group; non-group layers filter it out.

### 3. Updated `LayerState` union and type guard

```typescript
export type LayerState =
  | PixelLayerState | TextLayerState | ShapeLayerState
  | MaskLayerState  | AdjustmentLayerState | GroupLayerState

export function isGroupLayer(l: LayerState): l is GroupLayerState {
  return 'type' in l && l.type === 'group'
}
```

### 4. No change to `AppState` shape

`AppState.layers` remains `LayerState[]`. No new top-level fields are required. Root-level render order is defined implicitly: the root layers are those whose IDs do not appear in any `GroupLayerState.childIds`; their render order (bottom-to-top) equals their relative order in the flat `layers` array. This preserves full backward compatibility — existing reducer paths that accept `LayerState[]` need no payload changes.

---

## New Reducer Actions

```typescript
// src/store/AppContext.tsx — AppAction additions

| { type: 'ADD_LAYER_GROUP';       payload: { id: string; name: string; aboveLayerId?: string } }
| { type: 'GROUP_LAYERS';          payload: { groupId: string; groupName: string; layerIds: string[] } }
| { type: 'UNGROUP_LAYERS';        payload: { groupId: string } }
| { type: 'TOGGLE_GROUP_COLLAPSE'; payload: string }   // groupId
| { type: 'MOVE_LAYER_INTO_GROUP'; payload: { layerId: string; targetGroupId: string; insertIndex?: number } }
| { type: 'MOVE_LAYER_OUT_OF_GROUP'; payload: { layerId: string; targetParentGroupId: string | null; insertIndex: number } }
```

### `ADD_LAYER_GROUP`

Creates an empty group above `aboveLayerId` (or at the top if omitted). Inserts the new `GroupLayerState` into `state.layers` above the reference layer and sets it as `activeLayerId`.

### `GROUP_LAYERS`

Wraps an ordered set of existing layer IDs into a new group:
1. Determines each layer's current parent (group or root).
2. Removes the layer IDs from their current parent's `childIds` (or from their root positions).
3. Creates a new `GroupLayerState` with `childIds = layerIds` (in the caller's supplied order — bottom-to-top).
4. Inserts the group into the flat array at the position of the topmost moved layer.
5. Inserts the group's ID into the same parent context at the same position.

All supplied `layerIds` must share the same immediate parent (enforced by the UI — `GROUP_LAYERS` is only enabled when all selected layers are siblings).

### `UNGROUP_LAYERS`

Dissolves a group:
1. Removes the group's ID from its parent's `childIds` (or root position in the flat array).
2. Inserts all direct children into the parent context at the group's former position, in order.
3. Removes the `GroupLayerState` from `state.layers`. Children remain in `state.layers` unchanged.
4. Sets `activeLayerId` to the topmost child.

### `TOGGLE_GROUP_COLLAPSE`

Toggles `GroupLayerState.collapsed`. Pure UI state; no effect on compositing.

### `MOVE_LAYER_INTO_GROUP`

1. Removes `layerId` from its current parent's `childIds` (or from its root position in the flat array, i.e., by marking it as a non-root through the new childIds membership — the flat array position stays but is ignored for root ordering).
2. Splices `layerId` into `targetGroupId.childIds` at `insertIndex`.

Implementation note: the flat array is not reordered by this action. Root-layer order is re-derived dynamically by `buildRootLayerIds` in the tree utilities. Only `childIds` is mutated.

### `MOVE_LAYER_OUT_OF_GROUP`

Removes `layerId` from its current parent group's `childIds` and inserts it into `targetParentGroupId.childIds` at `insertIndex` (or into the root layer ordering at `insertIndex` if `targetParentGroupId === null`).

---

## Modified Existing Reducer Actions

### `REMOVE_LAYER`

Current behaviour: removes a single layer and any mask/adjustment children with `parentId === layerId`.

New behaviour for groups: when the target is a `GroupLayerState`, collect all descendant IDs via `getDescendantIds(layers, id)`, then filter them all out of `state.layers`. Also remove the group's ID from its parent group's `childIds` (if any), using `getParentGroup(layers, id)`.

When the target is a non-group layer, additionally remove it from its parent group's `childIds` if it has one.

```typescript
case 'REMOVE_LAYER': {
  const target = state.layers.find(l => l.id === action.payload)
  if (!target) return state
  const toRemove = new Set([action.payload, ...getDescendantIds(state.layers, action.payload)])
  const remaining = state.layers
    .filter(l => !toRemove.has(l.id))
    .map(l => isGroupLayer(l)
      ? { ...l, childIds: l.childIds.filter(id => !toRemove.has(id)) }
      : l
    )
  // ... rest of existing logic for activeLayerId, openAdjustmentLayerId
}
```

### `TOGGLE_LAYER_VISIBILITY`

When toggling a group: propagate to all descendants.

```typescript
case 'TOGGLE_LAYER_VISIBILITY': {
  const target = state.layers.find(l => l.id === action.payload)
  const newVisible = target ? !target.visible : false
  const affected = isGroupLayer(target)
    ? new Set([action.payload, ...getDescendantIds(state.layers, action.payload)])
    : new Set([action.payload])
  return {
    ...state,
    layers: state.layers.map(l =>
      affected.has(l.id) ? { ...l, visible: newVisible } : l
    )
  }
}
```

### `DUPLICATE_LAYER`

When duplicating a group, `useLayers.handleDuplicateLayer` calls a new `deepDuplicateGroup` tree utility (see below) which deep-copies all descendants with fresh IDs. The reducer receives multiple `ADD_LAYER` + `ADD_LAYER_GROUP` dispatches, or a new `BATCH_ADD_LAYERS` action (described under New Hooks).

### `SET_LAYER_BLEND` / `SET_LAYER_OPACITY`

No change needed — these operate on a single layer by ID.

### `REORDER_LAYERS`

No change needed. `REORDER_LAYERS` replaces the entire `state.layers` flat array. All merge operations in `useLayers` reconstruct the flat array and dispatch this. The group membership tree (`childIds`) embedded in the GroupLayerState entries within the new array is preserved because the merge operations preserve non-merged group layers verbatim.

For root-level drag-and-drop reordering in the LayerPanel, a new `MOVE_LAYER_OUT_OF_GROUP` or `MOVE_LAYER_INTO_GROUP` handles moving layers between contexts. Within-root reordering (swapping two root layers) continues to call `REORDER_LAYERS` with a rebuilt flat array, just as today. The LayerPanel's `handleDrop` builds the new flat array using `reorderRootLayers(layers, srcId, dstIndex)` from `layerTree.ts`.

---

## Layer Tree Utilities

**New file: `src/utils/layerTree.ts`**

All functions operate on `readonly LayerState[]`. They are pure functions with no side effects.

```typescript
/** All layer IDs not appearing in any group's childIds — in their flat-array order. */
export function buildRootLayerIds(layers: readonly LayerState[]): string[]

/** Direct parent group of a layer, or null if root. */
export function getParentGroup(
  layers: readonly LayerState[],
  layerId: string,
): GroupLayerState | null

/** All descendant IDs of a group (recursive, all depths). Includes direct children. */
export function getDescendantIds(
  layers: readonly LayerState[],
  groupId: string,
): string[]

/** True if candidateId is anywhere in the subtree rooted at ancestorId. */
export function isDescendantOf(
  layers: readonly LayerState[],
  candidateId: string,
  ancestorId: string,
): boolean

/** Nesting depth of a layer: 0 = root, 1 = inside one group, etc. */
export function getLayerDepth(
  layers: readonly LayerState[],
  layerId: string,
): number

/**
 * Walk the layer tree in bottom-to-top render order, yielding each layer with
 * its nesting depth. Used by LayerPanel to build the display list.
 */
export function* walkLayerTree(
  layers: readonly LayerState[],
): Generator<{ layer: LayerState; depth: number }>

/**
 * Reorder root layers by moving srcId to dstIndex among root layers,
 * returning a new full flat array with the non-root layers (group children)
 * unchanged in their positions relative to their parents.
 */
export function reorderRootLayers(
  layers: readonly LayerState[],
  srcId: string,
  dstIndex: number,
): LayerState[]

/**
 * Deep-duplicate a group and all its descendants, generating fresh IDs.
 * Returns new LayerState[] entries (not the full array) and a Map of old→new IDs.
 */
export function deepDuplicateGroup(
  layers: readonly LayerState[],
  groupId: string,
): { newLayers: LayerState[]; idMap: Map<string, string> }

/**
 * Return all layers in bottom-to-top compositing render order for the given
 * list of layer IDs (used by buildSubPlan to get children in order).
 * Respects childIds ordering for group children; flat-array order for roots.
 */
export function getOrderedLayers(
  layers: readonly LayerState[],
  layerIds: string[],
): LayerState[]
```

**Performance:** All walks are O(n) where n = total layer count. `getDescendantIds` is O(n). `isDescendantOf` short-circuits as soon as the ancestor is found.

---

## Compositing Changes

### New `RenderPlanEntry` kind

```typescript
// src/webgpu/WebGPURenderer.ts

export type RenderPlanEntry =
  | { kind: 'layer'; layer: GpuLayer; mask?: GpuLayer }
  | {
      kind: 'adjustment-group'
      parentLayerId: string
      baseLayer: GpuLayer
      baseMask?: GpuLayer
      adjustments: AdjustmentRenderOp[]
    }
  | {
      kind: 'layer-group'
      groupId:   string
      opacity:   number
      blendMode: string       // 'pass-through' or any BlendMode key
      visible:   boolean
      children:  RenderPlanEntry[]   // recursive
    }
  | AdjustmentRenderOp
```

### `canvasPlan.ts` — Recursive plan builder

`buildRenderPlan` is refactored to call a new internal helper `buildSubPlan`:

```typescript
// src/components/window/Canvas/canvasPlan.ts

export function buildRenderPlan(
  layers: readonly LayerState[],
  glLayers: Map<string, GpuLayer>,
  maskMap: Map<string, GpuLayer>,
  adjustmentMaskMap: Map<string, GpuLayer>,
  bypassedAdjustmentIds: ReadonlySet<string>,
  swatches: RGBAColor[],
): RenderPlanEntry[] {
  const rootIds = buildRootLayerIds(layers)
  return buildSubPlan(
    rootIds, layers, glLayers, maskMap, adjustmentMaskMap,
    bypassedAdjustmentIds, swatches,
  )
}

function buildSubPlan(
  orderedIds: string[],
  layers: readonly LayerState[],
  glLayers: Map<string, GpuLayer>,
  maskMap: Map<string, GpuLayer>,
  adjustmentMaskMap: Map<string, GpuLayer>,
  bypassedAdjustmentIds: ReadonlySet<string>,
  swatches: RGBAColor[],
): RenderPlanEntry[] {
  const layersById = new Map(layers.map(l => [l.id, l]))
  const plan: RenderPlanEntry[] = []

  for (const id of orderedIds) {
    const ls = layersById.get(id)
    if (!ls) continue

    // Group layer → recurse
    if (isGroupLayer(ls)) {
      plan.push({
        kind:      'layer-group',
        groupId:   ls.id,
        opacity:   ls.opacity,
        blendMode: ls.blendMode,
        visible:   ls.visible,
        children:  buildSubPlan(
          ls.childIds, layers, glLayers, maskMap,
          adjustmentMaskMap, bypassedAdjustmentIds, swatches,
        ),
      })
      continue
    }

    // Mask layers are handled via their parent
    if ('type' in ls && ls.type === 'mask') continue

    // Adjustment layer at group/root level (parentId points to a group or is absent)
    // These are group-scoped adjustments affecting everything below them in context
    if ('type' in ls && ls.type === 'adjustment') {
      if (bypassedAdjustmentIds.has(ls.id)) continue
      const entry = buildAdjustmentEntry(ls, adjustmentMaskMap.get(ls.id), swatches)
      if (entry) plan.push(entry)
      continue
    }

    // Pixel, text, or shape layer — collect attached adjustments (parentId === ls.id)
    const baseLayer = glLayers.get(ls.id)
    if (!baseLayer) continue

    const adjustments: AdjustmentRenderOp[] = []
    for (const adj of layers) {
      if (
        'type' in adj &&
        adj.type === 'adjustment' &&
        (adj as AdjustmentLayerState).parentId === ls.id &&
        !bypassedAdjustmentIds.has(adj.id)
      ) {
        const op = buildAdjustmentEntry(adj as AdjustmentLayerState, adjustmentMaskMap.get(adj.id), swatches)
        if (op) adjustments.push(op)
      }
    }

    if (adjustments.length > 0) {
      plan.push({
        kind: 'adjustment-group',
        parentLayerId: ls.id,
        baseLayer,
        baseMask: maskMap.get(ls.id),
        adjustments,
      })
    } else {
      plan.push({ kind: 'layer', layer: baseLayer, mask: maskMap.get(ls.id) })
    }
  }

  return plan
}
```

**Adjustment layer scoping rule for groups:**
- Adjustment layers in `childIds` with `parentId === groupId` (free-floating group-scoped adjustments) are processed as top-level entries in the group's sub-plan — they modify the composite of everything below them within the group's isolated buffer (or within the pass-through parent context).
- Adjustment layers with `parentId === somePixelLayerId` (per-layer attachments) remain bundled with their pixel layer in an `adjustment-group` entry as before, even when both layers are inside a group.

### `WebGPURenderer.ts` — Recursive compositor

`encodePlanToComposite` is refactored to delegate to a new `encodeSubPlan` method:

```typescript
// src/webgpu/WebGPURenderer.ts

private encodePlanToComposite(encoder: GPUCommandEncoder, plan: RenderPlanEntry[]): GPUTexture {
  this.encodeClearTexture(encoder, this.pingTex)
  this.encodeClearTexture(encoder, this.pongTex)
  const { src } = this.encodeSubPlan(encoder, plan, this.pongTex, this.pingTex)
  return src
}

private encodeSubPlan(
  encoder: GPUCommandEncoder,
  plan: RenderPlanEntry[],
  src: GPUTexture,
  dst: GPUTexture,
): { src: GPUTexture; dst: GPUTexture } {
  for (const entry of plan) {
    if (entry.kind === 'layer') {
      if (!entry.layer.visible || entry.layer.opacity === 0) continue
      this.encodeCompositeLayer(encoder, entry.layer, src, dst, entry.mask)
      ;[src, dst] = [dst, src]

    } else if (entry.kind === 'layer-group') {
      if (!entry.visible) continue
      if (entry.blendMode === 'pass-through') {
        // Inline: children composite directly into the parent ping-pong pair
        ;({ src, dst } = this.encodeSubPlan(encoder, entry.children, src, dst))
      } else {
        // Isolated: allocate a fresh pair, composite children into it
        const iso1 = this.allocateTempGroupTex()
        const iso2 = this.allocateTempGroupTex()
        this.encodeClearTexture(encoder, iso1)
        this.encodeClearTexture(encoder, iso2)
        const { src: isoResult } = this.encodeSubPlan(encoder, entry.children, iso2, iso1)
        // Composite the isolated result into the parent context
        this.encodeCompositeTexture(encoder, isoResult, src, dst, entry.opacity, entry.blendMode)
        ;[src, dst] = [dst, src]
      }

    } else if (entry.kind === 'adjustment-group') {
      if (!entry.baseLayer.visible || entry.baseLayer.opacity === 0) continue
      const groupResult = this.encodeAdjustmentGroup(encoder, entry)
      this.encodeCompositeTexture(encoder, groupResult, src, dst, entry.baseLayer.opacity, entry.baseLayer.blendMode)
      ;[src, dst] = [dst, src]

    } else {
      // AdjustmentRenderOp
      if (!entry.visible) continue
      this.encodeAdjustmentOp(encoder, entry, src, dst)
      ;[src, dst] = [dst, src]
    }
  }
  return { src, dst }
}
```

### Temporary texture allocation for isolated groups

Isolated groups require a fresh ping-pong pair per nesting level. The textures must remain alive until after `device.queue.submit()` completes. They are added to a `pendingDestroyTextures` list, destroyed in the existing `flushPendingDestroys` call.

```typescript
// WebGPURenderer additions

private pendingDestroyTextures: GPUTexture[] = []

private allocateTempGroupTex(): GPUTexture {
  const tex = this.createPingPongTex(this.pixelWidth, this.pixelHeight, /* same usage flags */)
  this.pendingDestroyTextures.push(tex)
  return tex
}

// In flushPendingDestroys():
//   this.pendingDestroyTextures.forEach(t => t.destroy())
//   this.pendingDestroyTextures = []
```

**Pass-through groups produce zero GPU overhead** — they don't allocate temp textures.

**Isolated group overhead:** 2 texture allocations per isolated group per frame. For typical documents with ≤8 groups, this is negligible. For deeply nested isolated groups, allocations are proportional to nesting depth, not total layer count.

**The existing `groupPingTex` / `groupPongTex` pair** continues to serve the existing `encodeAdjustmentGroup` path (pixel-layer-attached adjustment groups) and is not affected by this change.

### Nested groups

`encodeSubPlan` recurses naturally. Each isolated group level gets its own pair of temp textures. Pass-through groups at any depth simply thread the parent's ping-pong pair through the recursive call.

---

## Adjustment Layer Scoping Inside Groups

### Isolated groups

When a group's `blendMode !== 'pass-through'`, `encodeSubPlan` composites children into an isolated off-screen buffer (`iso1`/`iso2`) that starts fully transparent. Adjustment layers in the group's sub-plan modify only what has been composited into that buffer at the point they are processed — i.e., only layers below them within the group.

The isolated buffer is then composited into the parent context via `encodeCompositeTexture(encoder, isoResult, src, dst, group.opacity, group.blendMode)`. This means group-internal adjustments cannot "see" layers outside the group, matching FR-5.

### Pass-through groups

When `blendMode === 'pass-through'`, `encodeSubPlan` is called with the parent's `{src, dst}` pair. Adjustment layers inside the group operate on the accumulated composite of all layers below them in the FULL stack (including layers below the group itself), matching FR-6.

---

## Layer Panel UI Changes

### Tree rendering

Replace the current `displayLayers` flat computed array with a `treeRows` computed array:

```typescript
interface TreeRow {
  layer:     LayerState
  depth:     number        // 0 = root, 1 = inside one group, etc.
  hidden:    boolean       // true if inside a collapsed ancestor — skipped in render
}
```

Built by calling `walkLayerTree(layers)` from `layerTree.ts` and filtering out rows where any ancestor group is `collapsed`. The walk iterates the flat array in root-order, recursing into `childIds` for groups that are not collapsed.

Group rows render a **disclosure triangle** (▶ / ▼) button that dispatches `TOGGLE_GROUP_COLLAPSE`. Non-group, non-child rows render a `disclose-spacer` div of equal width to maintain alignment.

**Indentation**: `padding-left: calc(5px + depth × 16px)` applied inline to each row.

**Group row metadata**: A small `group-meta` container to the right of the group name shows `blend-mini` (abbreviated blend mode) and `group-opacity` (e.g. "75%"), matching the design mockup exactly.

**Active layer inside collapsed group**: If `activeLayerId` points to a layer inside a collapsed group, the group row itself receives the `itemActive` style.

### Drag-and-drop redesign

Current: `dragSrcIdx` (display index), `handleDrop(displayIdx)`.

New: drag source is the **layer ID** (`dragSrcLayerId: string | null`), and drop target is an ADT:

```typescript
type DropTarget =
  | { kind: 'before'; layerId: string }   // insert above this layer (drop indicator line)
  | { kind: 'after';  layerId: string }   // insert below this layer (drop indicator line)
  | { kind: 'into';   groupId: string }   // drop onto a group row (highlight the row, insert at top of group)
```

`onDragOver` computes the drop target from the pointer Y position within each row:
- Top 25%: `before`
- Bottom 25%: `after`
- Middle 50% (only if the row is a group): `into`

Drop indicator rendering: `treeRows.map` injects a 2px `drop-indicator` div between rows (or highlights the group row with `drop-target` class for `into`).

**Cycle prevention**: `isDescendantOf(layers, targetId, dragSrcLayerId)` checked in `onDragOver`. If true, `e.dataTransfer.dropEffect = 'none'` and the drop target is cleared.

**On drop**, the handler dispatches:
- `MOVE_LAYER_INTO_GROUP` if target is `into`
- `MOVE_LAYER_OUT_OF_GROUP` or a root-level `REORDER_LAYERS` (via `reorderRootLayers`) if target is `before`/`after` and the source and destination are both root-level
- `MOVE_LAYER_INTO_GROUP` with `insertIndex` if target is `before`/`after` inside a group

### Footer button

Add a "New Group" button (folder icon, same style as existing footer buttons) between the Add Layer and Delete Layer buttons:

```typescript
const onAddGroup = (): void => {
  const id = `group-${Date.now()}`
  const effective = [...selectedIds, ...(activeLayerId ? [activeLayerId] : [])]
  if (effective.length >= 2) {
    dispatch({ type: 'GROUP_LAYERS', payload: { groupId: id, groupName: 'Group', layerIds: effective } })
  } else {
    dispatch({ type: 'ADD_LAYER_GROUP', payload: { id, name: 'Group', aboveLayerId: activeLayerId ?? undefined } })
  }
}
```

### Context menu additions

Three new entries, positioned above the existing Merge section divider:

| Menu item | Enabled condition | Action |
|---|---|---|
| New Group from Selection | ≥ 2 layers selected (active + selected) and all are siblings | `GROUP_LAYERS` |
| Ungroup | Active layer is a group | `UNGROUP_LAYERS` |
| Merge Group | Active layer is a group | Calls `onMergeGroup(activeLayerId)` prop |

---

## New Hook: `useLayerGroups`

**File: `src/hooks/useLayerGroups.ts`**

Single concern: group-specific operations that involve both state dispatch AND canvas pixel data (merge group).

```typescript
interface UseLayerGroupsOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null }
  stateRef: MutableRefObject<AppState>
  captureHistory: (label: string) => void
  dispatch: Dispatch<AppAction>
}

export interface UseLayerGroupsReturn {
  handleMergeGroup:    (groupId: string) => Promise<void>
  handleGroupLayers:   (layerIds: string[]) => void
  handleUngroupLayers: (groupId: string) => void
}
```

`handleGroupLayers` and `handleUngroupLayers` are pure dispatch wrappers.

`handleMergeGroup` is async:
1. Build the render plan for the group's children only (call `buildSubPlan` with the group's `childIds`).
2. Rasterize via `rasterizeDocument({ plan, width, height, reason: 'merge', renderer })`.
3. Call `captureHistory('Merge Group')`.
4. Call `handle.prepareNewLayer(newId, group.name, mergedData)` to register pixel data.
5. Dispatch `REMOVE_LAYER` (which cascades to all descendants) then `ADD_LAYER` / `INSERT_LAYER_ABOVE` for the new pixel layer at the group's former position.

### `useLayers` changes

**`handleDuplicateLayer`**: If the active layer is a group, call `deepDuplicateGroup(layers, id)` from `layerTree.ts` to produce new `GroupLayerState` + descendant `LayerState[]` entries with fresh IDs, then dispatch a batch insert.

**`expandMergeLayerIds`**: Update to also expand group layers — when a group ID is in `rootIds`, add all its descendant IDs to `mergeIds`. This ensures merge operations that touch groups work correctly.

**`handleMergeDown`**: If the active layer is a group, `isPixelRootLayer` should return `false` for groups. Groups are not pixel roots, so Merge Down is disabled for group layers (they use Merge Group from the context menu instead).

---

## Rasterization Pipeline

### `handleMergeGroup` flow

```
GroupLayerState.childIds
    ↓
buildSubPlan(childIds, ...)      ← canvasPlan.ts helper, called directly
    ↓
RenderPlanEntry[] (group's children plan)
    ↓
rasterizeDocument({ plan, width: canvasW, height: canvasH, reason: 'merge', renderer })
    ↓
GpuRasterPipeline → renderer.readFlattenedPlan(plan)
    ↓
Uint8Array (canvas-sized flat raster)
    ↓
prepareNewLayer(newId, name, data)
    ↓
PixelLayerState inserted at group's former position
```

The group's isolated buffer composites ONLY the group's children (against a transparent background). This matches the non-pass-through group compositing behavior: the group's children are composited in isolation, so "Merge Group" output equals what `readFlattenedPlan` would produce for just those children.

For pass-through groups, Merge Group composites children against transparency, producing a pixel layer that captures their contribution. This may differ visually from the full-stack composite (since pass-through adjustments inside can no longer reach layers outside the group), but is the correct behavior for a destructive "bake" operation.

`rasterizeDocument` requires no changes — it already accepts any `RenderPlanEntry[]`.

---

## Keyboard Shortcuts

Wired in `App.tsx` via the existing keyboard event handler:

| Shortcut | Action |
|---|---|
| `Cmd+G` / `Ctrl+G` | `useLayerGroups.handleGroupLayers(effectiveSelectedIds)` |
| `Cmd+Shift+G` / `Ctrl+Shift+G` | `useLayerGroups.handleUngroupLayers(activeLayerId)` if active layer is a group |

---

## Migration

No migration is required. Existing documents serialise as `LayerState[]` without any `GroupLayerState` entries. When loaded via `OPEN_FILE`, `RESTORE_TAB`, or `RESTORE_LAYERS`:

- `buildRootLayerIds(layers)` returns all layer IDs (no groups → no `childIds` → all layers are root). 
- `buildSubPlan` processes root layers exactly as the old `buildRenderPlan` did.
- The `layer-group` entry kind never appears in the render plan.
- `encodePlanToComposite` receives only `layer`, `adjustment-group`, and `AdjustmentRenderOp` entries — the `encodeSubPlan` loop falls through all `layer-group` branches, behaving identically to the old code.

Stored `.verve` / JSON snapshots that contain no `GroupLayerState` entries are fully forward-compatible and require no upgrade script.

---

## Architectural Constraints

**Flat array + childIds (spec FR-2):** All tree structure lives in `childIds`. The flat `state.layers` array is never structurally nested. This keeps all existing `LayerState[]` reducer patterns intact and prevents deep serialisation nesting.

**App.tsx is a thin orchestrator:** Keyboard shortcuts for Group/Ungroup are wired in `App.tsx` but delegated immediately to `useLayerGroups`. No inline logic lives in `App.tsx`.

**Hooks own one cohesive concern:** `useLayerGroups` owns group lifecycle operations. `useLayers` retains ownership of merge/duplicate/flatten. These are not merged into one hook.

**Unified rasterization pipeline:** `handleMergeGroup` routes through `rasterizeDocument` from `src/rasterization/`. No separate compositing path is introduced for group rasterization.

**Module-level singletons unaffected:** `selectionStore`, `historyStore`, `clipboardStore`, etc. have no knowledge of group structure. They operate on individual layer IDs and pixel buffers, which remain unchanged.

**Pointer/tool events unaffected:** Tools operate on `GpuLayer` objects keyed by layer ID. Group layers have no `GpuLayer` (they have no pixel data); the `Move` tool's layer-picking logic continues to find the active `GpuLayer` by the `activeLayerId`, which is always a leaf layer (pixel/text/shape), never a group itself when drawing.

**CSS modules only:** All new LayerPanel styles go in `LayerPanel.module.scss` using `.module.scss` import.

---

## Open Questions

1. **Active layer = group:** When the active layer is a group, the blend mode selector and opacity slider in the panel header should show the group's blend mode (including Pass Through) and opacity. The existing `isChildActive` guard checks `type === 'mask' || type === 'adjustment'`; groups should NOT be treated as "child" layers for this guard — they should show their own blend/opacity controls.

2. **Selecting a group vs. selecting its contents:** Clicking a group row in the panel should select the group as the active layer. Clicking within a group's expanded children selects that child. This matches Photoshop behavior and requires no special handling beyond the existing `onActiveLayerChange` path — but the spec does not explicitly address whether Cmd+A ("select all") or marquee selection auto-selects layers inside groups or the group itself.

3. **Thumbnail for group rows:** The design shows a folder SVG icon in place of a pixel thumbnail. No GPU readback is required for group rows (there is no pixel data). Implementation is straightforward — render the folder icon SVG directly.

4. **History granularity for group operations:** `GROUP_LAYERS`, `UNGROUP_LAYERS`, and `MOVE_LAYER_INTO_GROUP` should each capture a single history entry. Confirm with the `historyStore` snapshot model that batching multiple layer mutations within one history entry is supported (current `captureHistory` takes a snapshot of all GPU layer data, so this needs to be called once per logical operation, after all dispatches complete).

5. **Multi-level pass-through adjustment scoping:** If an adjustment layer is inside a pass-through group that is itself inside an isolated group, the adjustment should affect layers below it within the isolated group's buffer (not the full root stack). The recursive `encodeSubPlan` handles this correctly because the isolated group's sub-plan receives a fresh `{src: iso2, dst: iso1}` pair — pass-through inside that context only propagates within the isolated buffer, not to the root.
