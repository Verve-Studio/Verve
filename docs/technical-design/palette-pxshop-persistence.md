# Technical Design: Palette Persistence in .verve Files

## Overview

When a user saves a `.verve` project file, the current swatch palette (`state.swatches`) is embedded in the JSON under a new top-level `swatches` key and the file format advances to version 2. On open, if the file declares `version: 2` the swatches array is validated and dispatched via the already-existing `SET_SWATCHES` action, replacing the in-memory palette. Version 1 files are silently ignored — swatches are left at the application default. All changes are confined to a single file: `src/hooks/useFileOps.ts`.

---

## Affected Areas

| File | Change |
|---|---|
| `src/hooks/useFileOps.ts` | Bump version to `2` on save; include `swatches` in the saved doc; validate and dispatch `SET_SWATCHES` on open of v2 files; add `isValidSwatchArray` guard; import `showOperationError` |

No other files require changes:

- `src/types/index.ts` — `AppState.swatches: RGBAColor[]` already exists. No new type fields.
- `src/store/AppContext.tsx` — `SET_SWATCHES` action and its reducer case already exist. Nothing to add.

---

## State Changes

None. `AppState`, `AppAction`, and the `SET_SWATCHES` reducer case are already in place and correct:

```ts
// AppContext.tsx — already present, no change needed
| { type: 'SET_SWATCHES'; payload: RGBAColor[] }

case 'SET_SWATCHES':
  return { ...state, swatches: action.payload }
```

---

## New Components / Hooks / Tools

None. This feature is a pure data-layer addition to an existing hook.

---

## Implementation Steps

### Step 1 — Add `showOperationError` import to `useFileOps.ts`

```ts
// At the top of useFileOps.ts, add:
import { showOperationError } from '@/utils/userFeedback'
```

`showOperationError(title, error)` accepts a plain string as the second argument (see `extractErrorMessage` in `userFeedback.ts`) and surfaces it via `window.alert`. This is the established pattern used in `useLayers.ts` and `useExportOps.ts`.

---

### Step 2 — Add `isValidSwatchArray` guard in `useFileOps.ts`

Place this module-level helper directly above the `useFileOps` function export:

```ts
function isValidSwatchArray(val: unknown): val is { r: number; g: number; b: number; a: number }[] {
  if (!Array.isArray(val)) return false
  for (const item of val) {
    if (typeof item !== 'object' || item === null) return false
    const { r, g, b, a } = item as Record<string, unknown>
    if (
      !Number.isInteger(r) || (r as number) < 0 || (r as number) > 255 ||
      !Number.isInteger(g) || (g as number) < 0 || (g as number) > 255 ||
      !Number.isInteger(b) || (b as number) < 0 || (b as number) > 255 ||
      !Number.isInteger(a) || (a as number) < 0 || (a as number) > 255
    ) return false
  }
  return true
}
```

The guard validates all four channels are present, are integers, and are in `[0, 255]`. An empty array (`[]`) passes — this is correct per the spec ("saving with no swatches is valid").

---

### Step 3 — Update `handleSave`: bump version and include swatches

In the `handleSave` callback, the current `doc` literal begins with `version: 1`. Change:

```ts
// BEFORE
const doc = {
  version: 1,
  canvas: { width: state.canvas.width, height: state.canvas.height, backgroundFill: state.canvas.backgroundFill },
  activeLayerId: state.activeLayerId,
  layers: state.layers.map(l => ({
    ...l,
    imageData: layerPngs[l.id] ?? null,
    layerGeo: layerGeos[l.id] ?? null,
    adjustmentMaskPng: adjustmentMaskPngs[l.id] ?? null,
  })),
}
```

```ts
// AFTER
const doc = {
  version: 2,
  canvas: { width: state.canvas.width, height: state.canvas.height, backgroundFill: state.canvas.backgroundFill },
  activeLayerId: state.activeLayerId,
  layers: state.layers.map(l => ({
    ...l,
    imageData: layerPngs[l.id] ?? null,
    layerGeo: layerGeos[l.id] ?? null,
    adjustmentMaskPng: adjustmentMaskPngs[l.id] ?? null,
  })),
  swatches: state.swatches,
}
```

`state.swatches` is `RGBAColor[]` — an array of plain `{r, g, b, a}` objects that serialize directly to the required JSON structure.

---

### Step 4 — Update the inline type cast in `handleOpen`

The `.verve` parse block casts `JSON.parse(json)` to an inline anonymous type. Extend it to include the new optional `swatches` field:

```ts
// BEFORE
const doc  = JSON.parse(json) as {
  version: number
  canvas: { width: number; height: number; backgroundFill?: BackgroundFill }
  activeLayerId: string | null
  layers: Array<LayerState & {
    imageData?: string | null
    layerGeo?: { layerWidth: number; layerHeight: number; offsetX: number; offsetY: number } | null
    adjustmentMaskPng?: string | null
  }>
}
```

```ts
// AFTER
const doc  = JSON.parse(json) as {
  version: number
  canvas: { width: number; height: number; backgroundFill?: BackgroundFill }
  activeLayerId: string | null
  layers: Array<LayerState & {
    imageData?: string | null
    layerGeo?: { layerWidth: number; layerHeight: number; offsetX: number; offsetY: number } | null
    adjustmentMaskPng?: string | null
  }>
  swatches?: unknown
}
```

Using `unknown` (not `RGBAColor[]`) is intentional — the field comes from untrusted JSON and must be validated before use.

---

### Step 5 — Dispatch `SET_SWATCHES` on open (v2 only)

After the existing layer/tab setup code and immediately before the final `dispatch({ type: 'SWITCH_TAB', ... })` call, add:

```ts
if (doc.version >= 2) {
  if (!isValidSwatchArray(doc.swatches)) {
    showOperationError('Could not open file.', 'The file contains invalid swatch data.')
    return
  }
  dispatch({ type: 'SET_SWATCHES', payload: doc.swatches })
}
```

**Order is important:** `SET_SWATCHES` must be dispatched _after_ the tab switch logic has updated `tabs`/`setActiveTabId` but _before_ control returns — this ensures the swatches panel updates in the same React render cycle as the canvas. Because `dispatch` is synchronous (via `useReducer`), a single render pass will reflect both the new canvas state from `SWITCH_TAB` and the restored palette from `SET_SWATCHES`.

> **Abort on invalid v2 file:** the `return` after `showOperationError` leaves the current document and swatches untouched. Tabs are not mutated. The `setTabs` / `setActiveTabId` calls above this block have already been made at that point in the current code, so we must insert the validation block _before_ `setTabs` and `setActiveTabId` are called — see the exact insertion point below.

#### Exact insertion point in `handleOpen`

The current flow for `.verve` files is:

```
JSON.parse → extract layers → build newSnapshot → setTabs → setActiveTabId
→ historyStore.clear → setPendingLayerData → dispatch SWITCH_TAB
```

The validation and `SET_SWATCHES` dispatch must be inserted _between_ the `JSON.parse` block and the `setTabs` call, so that an invalid file aborts before mutating tab state:

```ts
// After layer extraction, before setTabs:
if (doc.version >= 2) {
  if (!isValidSwatchArray(doc.swatches)) {
    showOperationError('Could not open file.', 'The file contains invalid swatch data.')
    return
  }
}

// ... existing setTabs, setActiveTabId, historyStore.clear, setPendingLayerData ...

dispatch({ type: 'SWITCH_TAB', payload: { ... } })
if (doc.version >= 2) {
  dispatch({ type: 'SET_SWATCHES', payload: doc.swatches as { r: number; g: number; b: number; a: number }[] })
}
```

The type assertion `as { r: number; g: number; b: number; a: number }[]` is safe here because `isValidSwatchArray` already narrowed the type.

---

## Architectural Constraints

- **`SET_SWATCHES` already exists.** Do not add a new action or reducer case. Use what is there.
- **No WASM, no WebGL.** Swatches are plain JS data; no pixel operations are involved.
- **Error surfacing follows the established pattern.** Use `showOperationError` from `@/utils/userFeedback`; do not introduce `window.alert` calls directly. This is the same pattern used in `useLayers.ts` and `useExportOps.ts`.
- **Version 1 backward compatibility is silent.** If `doc.version < 2`, do nothing with swatches — no dispatch, no error. The spec is explicit that legacy files preserve the application default palette.
- **Swatch ordering.** `state.swatches` holds swatches in logical application order (insertion order). The display-time hue sorting in the Swatches panel is a rendering concern only and must not influence what is serialized or deserialized.
- **The swatch round-trip is lossless by construction.** `JSON.stringify({r:255,g:0,b:0,a:128})` → `JSON.parse` → `{r:255,g:0,b:0,a:128}`. No floating-point or precision issues.

---

## Open Questions

1. **What happens to the swatches of the _previously active_ tab when a v2 file is opened in a new tab?** The current `SWITCH_TAB` action does not snapshot/restore swatches alongside other tab-scoped state. If swatches are meant to be per-document (as this spec implies), switching back to the old tab will not restore its palette. This is a scoping decision that falls outside the current spec, but should be noted as a follow-up: the `TabSnapshot` / `TabRecord` types may need a `swatches` field so each tab carries its own palette. The current implementation does not address this — it simply replaces the global palette on open, which matches the spec's stated requirements.

2. **Swatches in `SWITCH_TAB` / `RESTORE_TAB`.** Once per-tab swatch persistence is desired (see above), `SWITCH_TAB` and `RESTORE_TAB` actions will need `swatches` payload fields and `TabSnapshot` will need a `swatches` field. That is out of scope for this spec but is the natural next step.
