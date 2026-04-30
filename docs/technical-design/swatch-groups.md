# Technical Design: Swatch Groups

## Overview

This feature extends the Swatches panel with two complementary capabilities: **multi-selection** and **named groups**. Multi-selection enables batch operations (group creation, future batch delete) via plain-click, Ctrl+click, and Shift+click. Named groups tag palette subsets with a user-defined label and highlight their members through a header dropdown, without hiding or reordering swatches. Group data is part of per-tab state, persists in `.verve` files (version 3), and is restored on file open. Selection state and the active group highlight are transient UI state that live exclusively in `SwatchPanel`.

---

## Affected Areas

| File | Change |
|---|---|
| `src/types/index.ts` | Add `SwatchGroup` interface; add `swatchGroups` to `AppState` |
| `src/store/tabTypes.ts` | Add `swatchGroups` to `TabSnapshot` and `INITIAL_SNAPSHOT` |
| `src/store/AppContext.tsx` | Add `AppAction` variants; add `swatchGroups` to `initialState`; add reducer cases; extend `REMOVE_SWATCH` |
| `src/hooks/useTabs.ts` | Include `swatchGroups` in `captureActiveSnapshot`; dispatch `SET_SWATCH_GROUPS` in `switchToTab` |
| `src/hooks/useFileOps.ts` | Bump version to 3; add `isValidSwatchGroupsArray`; read/write `swatchGroups` in both save and load paths; add `swatchGroups: []` to all newly constructed `TabSnapshot` objects |
| `src/utils/swatchSort.ts` | Change return type of `sortSwatchesByHue` to `Array<{ color: RGBAColor; canonicalIndex: number }>` |
| `src/components/dialogs/GeneratePaletteDialog/GeneratePaletteDialog.tsx` | Update two call sites of `sortSwatchesByHue` to append `.map(e => e.color)` (callers only need sorted colors, not indices) |
| `src/components/panels/Swatch/SwatchPanel.tsx` | Major rework: group dropdown, remove-group button, context menu, multi-selection, group-name prompt, group highlight |
| `src/components/panels/Swatch/SwatchPanel.module.scss` | New classes: selection ring, group-highlight ring, context menu, group dropdown |
| `src/components/window/RightPanel/RightPanel.tsx` | Add `activeTabId` to `RightPanelProps`; pass it through to `SwatchPanel` |
| `src/App.tsx` | Pass `activeTabId={activeTabId}` to `<RightPanel>` |

---

## State Changes

### 1. New type — `src/types/index.ts`

Add below the `RGBAColor` definitions:

```ts
export interface SwatchGroup {
  id: string            // stable UUID, not user-visible
  name: string          // user-assigned display name; unique and non-empty
  swatchIndices: number[] // canonical (insertion-order) indices into state.swatches
}
```

### 2. `AppState` — `src/types/index.ts`

Add one field to `AppState`:

```ts
export interface AppState {
  // ... existing fields ...
  swatchGroups: SwatchGroup[]
}
```

### 3. `TabSnapshot` — `src/store/tabTypes.ts`

```ts
export interface TabSnapshot {
  // ... existing fields ...
  swatchGroups: SwatchGroup[]
}
```

Update `INITIAL_SNAPSHOT` to include `swatchGroups: []`.

### 4. New reducer actions — `src/store/AppContext.tsx`

Add to the `AppAction` union:

```ts
| { type: 'SET_SWATCH_GROUPS';    payload: SwatchGroup[] }
| { type: 'ADD_SWATCH_GROUP';     payload: { name: string; swatchIndices: number[] } }
| { type: 'REMOVE_SWATCH_GROUP';  payload: string }          // group id
| { type: 'RENAME_SWATCH_GROUP';  payload: { id: string; name: string } }
```

Add `swatchGroups: []` to `initialState`.

Import `SwatchGroup` in `AppContext.tsx`.

---

## Reducer Cases

### `SET_SWATCH_GROUPS`
Replaces the entire groups array. Used by `useFileOps` on file load and `useTabs.switchToTab` on tab restore.

```ts
case 'SET_SWATCH_GROUPS':
  return { ...state, swatchGroups: action.payload }
```

### `ADD_SWATCH_GROUP`
Creates a new group, or merges indices into an existing group with the same name (case-sensitive). UUID generation via `crypto.randomUUID()` (available in Electron's Chromium renderer).

```ts
case 'ADD_SWATCH_GROUP': {
  const { name, swatchIndices } = action.payload
  const existing = state.swatchGroups.find(g => g.name === name)
  if (existing) {
    const merged = [...new Set([...existing.swatchIndices, ...swatchIndices])]
    return {
      ...state,
      swatchGroups: state.swatchGroups.map(g =>
        g.id === existing.id ? { ...g, swatchIndices: merged } : g
      ),
    }
  }
  return {
    ...state,
    swatchGroups: [
      ...state.swatchGroups,
      { id: crypto.randomUUID(), name, swatchIndices },
    ],
  }
}
```

### `REMOVE_SWATCH_GROUP`
Deletes the group record. Member swatches are unaffected.

```ts
case 'REMOVE_SWATCH_GROUP':
  return { ...state, swatchGroups: state.swatchGroups.filter(g => g.id !== action.payload) }
```

### `RENAME_SWATCH_GROUP`
Updates the name. Uniqueness validation is the responsibility of the caller (SwatchPanel) before dispatching.

```ts
case 'RENAME_SWATCH_GROUP':
  return {
    ...state,
    swatchGroups: state.swatchGroups.map(g =>
      g.id === action.payload.id ? { ...g, name: action.payload.name } : g
    ),
  }
```

### `REMOVE_SWATCH` — extended (index stability)

The existing case only filters the `swatches` array. It must now also atomically update all `swatchGroups` in the same return value to keep indices stable:

```ts
case 'REMOVE_SWATCH': {
  const idx = action.payload
  const nextSwatches = state.swatches.filter((_, i) => i !== idx)
  const nextGroups = state.swatchGroups.map(g => ({
    ...g,
    swatchIndices: g.swatchIndices
      .filter(i => i !== idx)           // remove the deleted swatch
      .map(i => (i > idx ? i - 1 : i)), // shift remaining indices down
  }))
  return { ...state, swatches: nextSwatches, swatchGroups: nextGroups }
}
```

---

## Persistence

### Version bump

`handleSave` in `src/hooks/useFileOps.ts` currently writes `version: 2`. Change to `version: 3` and add `swatchGroups: state.swatchGroups` to the serialized document object.

### Load path — `handleOpen`

Extend the `doc` type annotation to include `swatchGroups?: unknown`.

Add a validator (alongside the existing `isValidSwatchArray`):

```ts
function isValidSwatchGroupsArray(
  val: unknown,
  swatchCount: number,
): val is SwatchGroup[] {
  if (!Array.isArray(val)) return false
  const names = new Set<string>()
  for (const item of val) {
    if (typeof item !== 'object' || item === null) return false
    const { id, name, swatchIndices } = item as Record<string, unknown>
    if (typeof id !== 'string' || id === '') return false
    if (typeof name !== 'string' || name === '') return false
    if (names.has(name)) return false   // duplicate name → invalid
    names.add(name)
    if (!Array.isArray(swatchIndices)) return false
    for (const idx of swatchIndices) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= swatchCount) return false
    }
  }
  return true
}
```

The `swatchCount` argument is `docSwatches.length` at the call site — this validation must run **after** `docSwatches` is resolved.

Backward-compatibility matrix:

| File version | `swatches` field | `swatchGroups` field |
|---|---|---|
| 1 | falls back to `DEFAULT_SWATCHES` | defaults to `[]` |
| 2 | validated and used | defaults to `[]` (no error) |
| 3 | validated and used | validated; abort with error if invalid |

The load path currently dispatches `SET_SWATCHES` after `SWITCH_TAB`. Add a parallel `dispatch({ type: 'SET_SWATCH_GROUPS', payload: docSwatchGroups })` immediately after it.

The `newSnapshot` constructed during load must also include `swatchGroups: docSwatchGroups`.

### New-file and image-import paths

Both `handleNewConfirm` and the image-import branch of `handleOpen` construct a `newSnapshot`. Each must include `swatchGroups: []`.

---

## `sortSwatchesByHue` Return Type Change

`src/utils/swatchSort.ts` currently returns `RGBAColor[]`. With groups, `SwatchPanel` must map each displayed cell back to its canonical index to:
- Determine group membership for highlighting.
- Populate `swatchIndices` when creating a group from a selection.
- Identify the correct swatch on right-click for single-swatch delete and context actions.

The existing value-based `findIndex` workaround in `SwatchPanel` is also fragile if two swatches have identical RGBA values.

**Change** the return type to `Array<{ color: RGBAColor; canonicalIndex: number }>`:

```ts
export function sortSwatchesByHue(
  swatches: RGBAColor[],
): Array<{ color: RGBAColor; canonicalIndex: number }> {
  // Build indexed entries, sort by existing logic, return with preserved index.
}
```

Internally, build `Array<{ color: RGBAColor; canonicalIndex: number }>` at the start, apply the same sort comparators to objects rather than raw colors, and return the objects.

**`GeneratePaletteDialog.tsx`** has two call sites that pass the result to `onApply` (which expects `RGBAColor[]`) and to a preview memo. Both must append `.map(e => e.color)`:

```ts
// line ~146
return sortSwatchesByHue(raw).map(e => e.color)

// line ~152
onApply(sortSwatchesByHue(raw).map(e => e.color))
```

---

## `useTabs` Changes

### `captureActiveSnapshot`

Currently captures `state.swatches`. Add `swatchGroups: state.swatchGroups`:

```ts
const captureActiveSnapshot = useCallback((): TabSnapshot => ({
  // ... existing fields ...
  swatches:      state.swatches,
  swatchGroups:  state.swatchGroups,
}), [state])
```

### `switchToTab`

Currently dispatches `SET_SWATCHES` alongside `SWITCH_TAB`. Add a parallel dispatch:

```ts
dispatch({ type: 'SET_SWATCH_GROUPS', payload: toTab.snapshot.swatchGroups ?? [] })
```

---

## `SwatchPanel` Rework

### New local state

```ts
// Selection (transient, not persisted)
const [selectedIndices, setSelectedIndices] = useState<number[]>([])
const anchorIndexRef = useRef<number | null>(null)

// Active group highlight (transient, not persisted)
const [activeGroupId, setActiveGroupId] = useState<string | null>(null)

// Context menu
const [contextMenu, setContextMenu] = useState<{
  x: number
  y: number
  canonicalIndex: number
} | null>(null)
const contextMenuRef = useRef<HTMLDivElement>(null)

// Group name prompt
const [groupPromptOpen, setGroupPromptOpen] = useState(false)
const [groupPromptName, setGroupPromptName] = useState('')
const [groupPromptError, setGroupPromptError] = useState<string | null>(null)
```

### Reset on tab switch

Add `activeTabId: string` to `SwatchPanelProps`. Use a `useEffect` to clear transient state on tab changes:

```ts
useEffect(() => {
  setSelectedIndices([])
  anchorIndexRef.current = null
  setActiveGroupId(null)
  setContextMenu(null)
}, [activeTabId])
```

This requires passing `activeTabId` down from `RightPanel` (new prop) ← `App.tsx` (already has `activeTabId` from `useTabs`).

### Display list

```ts
const displayEntries = useMemo(
  () => sortSwatchesByHue(state.swatches),
  [state.swatches],
)
```

`displayEntries` is now `Array<{ color: RGBAColor; canonicalIndex: number }>`.

### Swatch cell click handlers

**Plain left-click** — sets foreground color, makes this swatch the sole selection, updates anchor:

```ts
onClick={(e) => {
  if (e.ctrlKey || e.metaKey) return  // handled by own handler
  dispatch({ type: 'SET_PRIMARY_COLOR', payload: entry.color })
  setSelectedIndices([entry.canonicalIndex])
  anchorIndexRef.current = entry.canonicalIndex
}}
```

**Ctrl+click** — toggles in/out of selection, does not update anchor, does not change foreground color:

```ts
onClick={(e) => {
  if (!(e.ctrlKey || e.metaKey)) return
  e.preventDefault()
  setSelectedIndices(prev =>
    prev.includes(entry.canonicalIndex)
      ? prev.filter(i => i !== entry.canonicalIndex)
      : [...prev, entry.canonicalIndex]
  )
}}
```

In practice, combine into a single `onClick` handler that branches on modifier keys.

**Shift+click** — selects the range between anchor and this cell in display order:

```ts
if (e.shiftKey && anchorIndexRef.current !== null) {
  const anchorDisplayIdx = displayEntries.findIndex(
    e => e.canonicalIndex === anchorIndexRef.current,
  )
  const thisDisplayIdx = displayEntries.findIndex(
    e => e.canonicalIndex === entry.canonicalIndex,
  )
  const [lo, hi] = [
    Math.min(anchorDisplayIdx, thisDisplayIdx),
    Math.max(anchorDisplayIdx, thisDisplayIdx),
  ]
  const rangeCanonical = displayEntries.slice(lo, hi + 1).map(e => e.canonicalIndex)
  setSelectedIndices(rangeCanonical)
  // anchor does not move on shift-click
  return
}
```

**Right-click** — opens context menu (replaces current immediate-delete behavior):

```ts
onContextMenu={(e) => {
  e.preventDefault()
  setContextMenu({ x: e.clientX, y: e.clientY, canonicalIndex: entry.canonicalIndex })
}}
```

**Click on empty panel area** — clears selection. Attach `onClick` on `panelBody` div that sets `selectedIndices([])` when `e.target === e.currentTarget`.

### Context menu

Portal-rendered (same pattern as the existing hamburger dropdown). Positioned at `{ top: contextMenu.y, left: contextMenu.x }` with `position: fixed`.

Dismiss on outside click: a `useEffect` that adds a `mousedown` listener when `contextMenu !== null`, same pattern as the existing `menuOpen` effect.

Items:

1. **Delete** — dispatches `REMOVE_SWATCH` with `contextMenu.canonicalIndex`. Applies only to the right-clicked swatch regardless of current selection.
2. **Group Selected Entries…** — determines the group candidates:
   - If `selectedIndices.length > 0` → use `selectedIndices`
   - Otherwise → use `[contextMenu.canonicalIndex]`
   
   Opens the group name prompt by setting `groupPromptOpen = true` and clearing `groupPromptName`.
3. **Rename Group…** — visible only when `activeGroupId !== null` AND the right-clicked swatch is a member of the active group. Opens a rename prompt using the same `ModalDialog` pattern with the current group name pre-filled.

### Group name prompt

Inline in `SwatchPanel.tsx` using `ModalDialog`. No separate dialog file — the prompt is three elements (text input, OK, Cancel) and is specific to this panel.

```tsx
<ModalDialog
  title="Create / Join Group"
  open={groupPromptOpen}
  onClose={() => setGroupPromptOpen(false)}
>
  <input
    type="text"
    value={groupPromptName}
    onChange={e => { setGroupPromptName(e.target.value); setGroupPromptError(null) }}
    onKeyDown={e => { if (e.key === 'Enter') handleGroupPromptConfirm() }}
    autoFocus
  />
  {groupPromptError && <p className={styles.promptError}>{groupPromptError}</p>}
  <DialogButton onClick={handleGroupPromptConfirm}>OK</DialogButton>
  <DialogButton onClick={() => setGroupPromptOpen(false)}>Cancel</DialogButton>
</ModalDialog>
```

`handleGroupPromptConfirm`:
1. Trim the name. If empty → set error, do not close.
2. If this is a rename and the name already exists on a *different* group → set error "A group with that name already exists."
3. For "create/join": dispatch `ADD_SWATCH_GROUP` (reducer handles both create and merge).
4. Close prompt. Clear `groupPromptName`.

### Panel header layout

The spec requires the group controls to appear **to the left** of the hamburger (≡) button. Update `.actions` / `.menuWrap` to lay out:

```
[ Group dropdown ][ × remove ]   [ ≡ hamburger ]
```

Group dropdown is a native `<select>`:

```tsx
<select
  value={activeGroupId ?? ''}
  onChange={e => setActiveGroupId(e.target.value || null)}
  className={styles.groupSelect}
  aria-label="Highlight group"
>
  <option value="">All swatches</option>
  {state.swatchGroups.map(g => (
    <option key={g.id} value={g.id}>{g.name}</option>
  ))}
</select>
<button
  type="button"
  className={styles.removeGroupBtn}
  disabled={activeGroupId === null}
  aria-label="Remove group"
  onClick={() => {
    if (activeGroupId === null) return
    dispatch({ type: 'REMOVE_SWATCH_GROUP', payload: activeGroupId })
    setActiveGroupId(null)
  }}
>
  ×
</button>
```

When `state.swatchGroups` changes and the current `activeGroupId` is no longer found (e.g., the group was just removed), reset `activeGroupId` to `null` via a render-time guard:

```ts
if (activeGroupId !== null && !state.swatchGroups.some(g => g.id === activeGroupId)) {
  setActiveGroupId(null)
}
```

### Swatch cell visual states

Each displayed cell needs up to three independent visual layers:

| Condition | CSS class | Visual |
|---|---|---|
| Active foreground color | `swatchActive` | existing indicator (unchanged) |
| In `selectedIndices` | `swatchSelected` | blue ring/border (selection highlight) |
| In active group's `swatchIndices` | `swatchGroupHighlight` | amber/orange ring per design (`rgba(255, 180, 0, 0.55)` fill + `#e8a000` border) |

A swatch that is both selected and group-highlighted stacks both classes; the styles must be distinct enough that the combination reads unambiguously. The recommended approach: `swatchSelected` uses an inset box-shadow ring; `swatchGroupHighlight` uses an inner background overlay tint. They compose visually without obscuring each other.

Computing the group-highlight set:

```ts
const highlightedCanonicalIndices = useMemo<Set<number>>(() => {
  if (activeGroupId === null) return new Set()
  const group = state.swatchGroups.find(g => g.id === activeGroupId)
  return new Set(group?.swatchIndices ?? [])
}, [activeGroupId, state.swatchGroups])
```

Per-cell class composition:

```ts
const isSelected   = selectedIndices.includes(entry.canonicalIndex)
const isHighlighted = highlightedCanonicalIndices.has(entry.canonicalIndex)
const cellClass = [
  styles.swatchCell,
  isActive      ? styles.swatchActive      : '',
  isSelected    ? styles.swatchSelected    : '',
  isHighlighted ? styles.swatchGroupHighlight : '',
].join(' ')
```

---

## State Accessibility

`swatchGroups` lives in `AppState` and flows through `AppContext`. Any panel can read it via `const { state } = useAppContext()` and access `state.swatchGroups`. No additional hook is needed. Other features that need to enumerate groups (e.g. a future palette export dialog) simply read `state.swatchGroups` from context.

---

## Selection State Placement

Selection (`selectedIndices`, `anchorIndexRef`) and the active group highlight (`activeGroupId`) are **transient UI state** — they are not serialized, not part of `AppState`, and not part of `TabSnapshot`. They live exclusively in `SwatchPanel` local state and are cleared on `activeTabId` change via `useEffect`.

Do not add these to `AppState` or `TabSnapshot`.

---

## Implementation Steps

1. **`src/types/index.ts`** — Add the `SwatchGroup` interface (below the `RGBAColor` block). Add `swatchGroups: SwatchGroup[]` to `AppState`.

2. **`src/store/tabTypes.ts`** — Import `SwatchGroup`. Add `swatchGroups: SwatchGroup[]` to `TabSnapshot`. Add `swatchGroups: []` to `INITIAL_SNAPSHOT`.

3. **`src/store/AppContext.tsx`** — Import `SwatchGroup`. Add the four new `AppAction` variants. Add `swatchGroups: []` to `initialState`. Add the four new reducer cases. Extend the `REMOVE_SWATCH` case to atomically update `swatchGroups`.

4. **`src/utils/swatchSort.ts`** — Change `sortSwatchesByHue` to return `Array<{ color: RGBAColor; canonicalIndex: number }>`. Internally wrap each swatch in `{ color, canonicalIndex: originalIndex }` before sorting and preserve the object through the sort.

5. **`src/components/dialogs/GeneratePaletteDialog/GeneratePaletteDialog.tsx`** — Append `.map(e => e.color)` at the two `sortSwatchesByHue(...)` call sites (lines ~146 and ~152).

6. **`src/hooks/useTabs.ts`** — Add `swatchGroups: state.swatchGroups` to `captureActiveSnapshot`. Add `dispatch({ type: 'SET_SWATCH_GROUPS', payload: toTab.snapshot.swatchGroups ?? [] })` in `switchToTab`.

7. **`src/hooks/useFileOps.ts`**:
   - Add `isValidSwatchGroupsArray` helper function.
   - In `handleOpen`: extend the `doc` type annotation with `swatchGroups?: unknown`; after resolving `docSwatches`, validate `doc.swatchGroups` when `doc.version >= 3` (abort with error on failure); set `docSwatchGroups` to `[]` for v1/v2; include `swatchGroups: docSwatchGroups` in `newSnapshot`; dispatch `SET_SWATCH_GROUPS` after `SET_SWATCHES`.
   - In `handleNewConfirm` and the image-import branch: add `swatchGroups: []` to each constructed `newSnapshot`.
   - In `handleSave`: change `version: 2` → `version: 3`; add `swatchGroups: state.swatchGroups` to the `doc` object.

8. **`src/components/window/RightPanel/RightPanel.tsx`** — Add `activeTabId: string` to `RightPanelProps`; pass `activeTabId={activeTabId}` to `<SwatchPanel>`.

9. **`src/App.tsx`** — Add `activeTabId={activeTabId}` to `<RightPanel>`.

10. **`src/components/panels/Swatch/SwatchPanel.tsx`** — Full rework as described: new local state, `displayEntries` from updated `sortSwatchesByHue`, updated click/context-menu handlers, group dropdown + remove button in header, context menu portal, group name prompt via `ModalDialog`, visual class composition for selection + group highlight.

11. **`src/components/panels/Swatch/SwatchPanel.module.scss`** — Add: `.swatchSelected` (blue inset ring), `.swatchGroupHighlight` (amber overlay), `.groupSelect`, `.removeGroupBtn`, `.contextMenu`, `.contextMenuItem`, `.promptError`.

---

## Architectural Constraints

- **`SwatchPanel` is a panel** — it may read from `AppContext` directly. It must not pass state management logic up to `RightPanel`.
- **`RightPanel` is a window component** — it only threads `activeTabId` through as a prop; it does not interpret or act on it.
- **No new global state for UI** — selection and active group highlight are local to `SwatchPanel`. They are never added to `AppState` or `TabSnapshot`.
- **Atomic reducer updates** — the `REMOVE_SWATCH` case must return both `swatches` and `swatchGroups` in a single state object. Two separate dispatches would expose a momentarily inconsistent state.
- **Portal-based context menu** — follows the established pattern of the hamburger dropdown (same `ReactDOM.createPortal` + `document.addEventListener('mousedown', ...)` dismiss approach).
- **`ModalDialog` for prompts** — follows the `GeneratePaletteDialog` pattern. No new dialog infrastructure is needed.

---

## Open Questions

1. **Group dropdown width overflow.** The spec requires long group names to be truncated with a tooltip on hover. A native `<select>` truncates automatically but does not show tooltips on `<option>` elements in all browsers. If a styled custom dropdown is preferred, that is a meaningful scope expansion. Recommended: ship with native `<select>` and revisit if truncation becomes a UX complaint.

2. **Rename via context menu vs. double-click in dropdown.** The spec accepts either. The design recommends context menu only (simpler). Double-click rename inside a native `<select>` is not achievable without replacing it with a custom control. If a custom dropdown is ever built (see question 1), double-click rename could be added at that point.

3. **Batch delete.** The spec does not include "Delete Selected" as a context menu item, but multi-selection is being implemented. A "Delete Selected" context item would be a natural follow-on. Out of scope for this ticket; the selection data structure (`number[]`) is ready for it.

4. **`crypto.randomUUID()` availability.** This API is available in Electron's renderer (Chromium-based) and in all modern browsers. No polyfill needed, but if the WASM build context or any Node.js path ever calls group creation, a `uuid` dependency would be needed there. This is not expected.

5. **Empty-group visual treatment.** The spec says empty groups (all member swatches deleted) remain in the dropdown. No special visual treatment is specified. No action needed; the existing implementation handles this naturally since `swatchIndices: []` produces zero highlights.
