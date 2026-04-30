# Technical Design: Palette File I/O

## Overview

The Palette File I/O feature adds **Save Palette**, **Save Palette As…**, and **Open Palette…** commands to the Swatches panel, accessed via a new ≡ hamburger button rendered inside `SwatchPanel`. Files are written and read as `.palette` JSON via Electron's native OS dialogs, keeping the renderer free of direct filesystem access. All I/O business logic is centralised in a new `usePaletteFileOps` hook in `src/hooks/`. The last-used file path is tracked session-only in a `useRef` inside the hook; no new persistent state is required. Palette data flows through the existing `SET_SWATCHES` action in `AppContext`.

---

## Affected Areas

| File | Change |
|---|---|
| `electron/main/ipc.ts` | Add 4 IPC handlers: `dialog:openPalette`, `dialog:savePaletteAs`, `file:readPalette`, `file:writePalette` |
| `electron/preload/index.ts` | Add 4 methods to the `api` object: `openPaletteDialog`, `savePaletteAsDialog`, `readPaletteFile`, `writePaletteFile` |
| `electron/preload/index.d.ts` | Add the 4 new method signatures to `Window['api']` |
| `src/utils/paletteFormat.ts` | **New file.** Pure TS: `serializePalette` and `parsePaletteFile` with full validation |
| `src/hooks/usePaletteFileOps.ts` | **New file.** Hook owning all palette I/O logic and session path tracking |
| `src/components/panels/Swatch/SwatchPanel.tsx` | Add ≡ button + context menu; accept 4 new optional props |
| `src/components/window/RightPanel/RightPanel.tsx` | Accept and pass 4 new props down to `SwatchPanel` |
| `src/App.tsx` | Call `usePaletteFileOps`; pass returned handlers + error to `RightPanel` |

---

## IPC Channel Design

### New handlers in `electron/main/ipc.ts`

```ts
ipcMain.handle('dialog:openPalette', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Palette', extensions: ['palette'] }],
  })
  return canceled ? null : filePaths[0]
})

ipcMain.handle('dialog:savePaletteAs', async (_event, defaultPath?: string) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath,
    filters: [{ name: 'Palette', extensions: ['palette'] }],
  })
  return canceled ? null : filePath
})

ipcMain.handle('file:readPalette', async (_event, path: string) => {
  return readFile(path, 'utf-8')
})

ipcMain.handle('file:writePalette', async (_event, path: string, data: string) => {
  await writeFile(path, data, 'utf-8')
})
```

### New methods in `electron/preload/index.ts`

```ts
openPaletteDialog: (): Promise<string | null> =>
  ipcRenderer.invoke('dialog:openPalette'),
savePaletteAsDialog: (defaultPath?: string): Promise<string | null> =>
  ipcRenderer.invoke('dialog:savePaletteAs', defaultPath),
readPaletteFile: (path: string): Promise<string> =>
  ipcRenderer.invoke('file:readPalette', path),
writePaletteFile: (path: string, data: string): Promise<void> =>
  ipcRenderer.invoke('file:writePalette', path, data),
```

### New type entries in `electron/preload/index.d.ts`

These four signatures are appended to the `api` property of `Window`:

```ts
openPaletteDialog: () => Promise<string | null>
savePaletteAsDialog: (defaultPath?: string) => Promise<string | null>
readPaletteFile: (path: string) => Promise<string>
writePaletteFile: (path: string, data: string) => Promise<void>
```

---

## Palette Format Utility — `src/utils/paletteFormat.ts`

A pure TypeScript utility with no React or Electron imports. This is the single source of truth for the `.palette` schema and the only place validation logic lives.

### Schema

```json
{ "version": 1, "swatches": [{ "r": 255, "g": 0, "b": 0, "a": 255 }, …] }
```

All four channels are integers in 0–255.

### API

```ts
import type { RGBAColor } from '@/types'

/** Serialise swatches to the canonical .palette JSON string. */
export function serializePalette(swatches: RGBAColor[]): string

/**
 * Parse and validate a .palette JSON string.
 * Returns the validated swatch array on success.
 * Throws a descriptive Error on any validation failure so callers can
 * surface the message directly.
 */
export function parsePaletteFile(json: string): RGBAColor[]
```

### Validation rules in `parsePaletteFile`

1. `JSON.parse` — throws `SyntaxError` on malformed JSON (propagated as-is with a wrapping message).
2. Root object must have a `version` key with a numeric value ≥ 1.
3. Root object must have a `swatches` key whose value is an `Array`.
4. Each element must be an object with `r`, `g`, `b`, `a` keys, all `number` values, all integers, all in `[0, 255]`.
5. Any violation throws `new Error('<human-readable description>')`. The caller displays `err.message` verbatim.

---

## New Hook — `src/hooks/usePaletteFileOps.ts`

Owns exactly one concern: palette file I/O for the current session. It reads the current swatches on demand, writes them to disk, reads palette files from disk and dispatches `SET_SWATCHES`, and tracks the last-used path across the session.

### Interface

```ts
import type { Dispatch } from 'react'
import type { RGBAColor } from '@/types'
import type { AppAction } from '@/store/AppContext'

interface UsePaletteFileOpsOptions {
  swatches: RGBAColor[]
  dispatch: Dispatch<AppAction>
}

export interface UsePaletteFileOpsReturn {
  handleSavePalette:   () => Promise<void>
  handleSavePaletteAs: () => Promise<void>
  handleOpenPalette:   () => Promise<void>
  paletteError:        string | null
  clearPaletteError:   () => void
}

export function usePaletteFileOps(opts: UsePaletteFileOpsOptions): UsePaletteFileOpsReturn
```

### Internal state

| Symbol | Type | Purpose |
|---|---|---|
| `lastUsedPathRef` | `useRef<string \| null>` | Session path — mutated directly, never causes re-renders |
| `paletteError` | `useState<string \| null>` | Surfaces parse/write errors to the UI |

### Handler logic

**`handleSavePalette`**
1. If `lastUsedPathRef.current` is non-null, call `writePaletteFile(path, serialize(swatches))`.
2. Otherwise, delegate to `handleSavePaletteAs`.
3. On `writeFile` failure, set `paletteError` to the error message.

**`handleSavePaletteAs`**
1. Call `savePaletteAsDialog(lastUsedPathRef.current ?? undefined)` to get a path.
2. If canceled (null returned), return — no state changes.
3. Call `writePaletteFile(path, serialize(swatches))`.
4. On success, set `lastUsedPathRef.current = path`.
5. On failure, set `paletteError`.

**`handleOpenPalette`**
1. Call `openPaletteDialog()` to get a path.
2. If canceled, return — no state changes.
3. Call `readPaletteFile(path)` to get the raw JSON string.
4. Call `parsePaletteFile(json)`:
   - On success, `dispatch({ type: 'SET_SWATCHES', payload: parsed })` and set `lastUsedPathRef.current = path`.
   - On failure, set `paletteError` to `err.message`. Swatches remain unchanged.

> **Note:** `swatches` is captured in each `useCallback` with `swatches` in the dep array — the standard React pattern. No ref wrapper is needed because `handleSavePalette` / `handleSavePaletteAs` read `swatches` only at the moment of invocation, not during async gaps that could race with state updates.

---

## Component Changes

### `SwatchPanel` (`src/components/panels/Swatch/SwatchPanel.tsx`)

Add four new optional props:

```ts
interface SwatchPanelProps {
  onGeneratePalette?:  () => void
  onSavePalette?:      () => void
  onSavePaletteAs?:    () => void
  onOpenPalette?:      () => void
  paletteError?:       string | null
}
```

Add local state for the context menu:

```ts
const [menuOpen, setMenuOpen] = useState(false)
```

**Structural changes to the rendered output:**

1. Wrap the existing `panelBody` content in a fragment alongside a new **panel toolbar row** rendered above `panelBody`. The toolbar row contains:
   - The existing **Generate palette** button (moved from `actions` div inside panelBody into the toolbar row, so all panel-level actions share one header).
   - A **≡ hamburger button** (`aria-label="Palette menu"`) on the right edge of the toolbar row.

2. When `menuOpen` is true, render a **context menu** — an absolutely-positioned `<div>` containing three `<button>` elements:
   - **Save Palette** → `onSavePalette?.(); setMenuOpen(false)`
   - **Save Palette As…** → `onSavePaletteAs?.(); setMenuOpen(false)`
   - **Open Palette…** → `onOpenPalette?.(); setMenuOpen(false)`

3. Clicking outside the menu closes it: attach a `useEffect` that adds a `mousedown` listener on `document` when `menuOpen` is true and removes it on cleanup.

4. If `paletteError` is non-null, render an **error banner** below the toolbar row (above the swatch grid) displaying the message with a dismiss (×) button that calls `clearPaletteError` — but since the panel doesn't own `clearPaletteError` directly, the banner uses `onClearError?: () => void` added as a fifth prop. Alternatively, the ×  button triggers any swatch interaction and the error auto-dismisses on the next action; keep it simple — see Open Questions.

> The ≡ button should only render when at least one of `onSavePalette`, `onSavePaletteAs`, `onOpenPalette` is defined, to remain harmless when `SwatchPanel` is used without the file I/O hooks wired up.

### `RightPanel` (`src/components/window/RightPanel/RightPanel.tsx`)

Extend `RightPanelProps` with five new optional fields (the same ones `SwatchPanel` now accepts plus `onClearPaletteError`):

```ts
interface RightPanelProps {
  // ... existing ...
  onSavePalette?:      () => void
  onSavePaletteAs?:    () => void
  onOpenPalette?:      () => void
  paletteError?:       string | null
  onClearPaletteError?: () => void
}
```

Pass all five directly through to `<SwatchPanel>`. No logic is added to `RightPanel`.

### `App.tsx`

1. Call the new hook after the existing hook calls:
   ```ts
   const paletteFileOps = usePaletteFileOps({ swatches: state.swatches, dispatch })
   ```
2. Pass the returned values to `<RightPanel>`:
   ```tsx
   <RightPanel
     // ...existing props...
     onSavePalette={paletteFileOps.handleSavePalette}
     onSavePaletteAs={paletteFileOps.handleSavePaletteAs}
     onOpenPalette={paletteFileOps.handleOpenPalette}
     paletteError={paletteFileOps.paletteError}
     onClearPaletteError={paletteFileOps.clearPaletteError}
   />
   ```

---

## State Changes

No new fields are added to `AppState`. The feature reuses the existing `SET_SWATCHES` action (already present in `AppContext.tsx`) to replace the swatch list after **Open Palette…**.

The `lastUsedPath` is entirely session-local and lives in a `useRef` inside `usePaletteFileOps` — it is never serialised to disk and is reset on each application start.

---

## Implementation Steps

1. **`electron/main/ipc.ts`** — Add the four IPC handlers (`dialog:openPalette`, `dialog:savePaletteAs`, `file:readPalette`, `file:writePalette`) inside `registerIpcHandlers()`, following the exact style of the existing `dialog:saveverve` / `file:saveverve` pair.

2. **`electron/preload/index.ts`** — Add four entries to the `api` object (`openPaletteDialog`, `savePaletteAsDialog`, `readPaletteFile`, `writePaletteFile`), following the existing camelCase naming and `ipcRenderer.invoke` pattern.

3. **`electron/preload/index.d.ts`** — Add the four method signatures to `Window['api']` so the renderer has full TypeScript coverage.

4. **`src/utils/paletteFormat.ts`** — Create the new utility file. Implement `serializePalette` (trivial `JSON.stringify`) and `parsePaletteFile` (parse + validate all four rules listed above). No imports beyond `@/types`.

5. **`src/hooks/usePaletteFileOps.ts`** — Create the new hook. Use `useRef<string | null>(null)` for `lastUsedPathRef` and `useState<string | null>(null)` for `paletteError`. Implement `handleSavePalette`, `handleSavePaletteAs`, `handleOpenPalette` as `useCallback`s. Export `UsePaletteFileOpsReturn`.

6. **`src/components/panels/Swatch/SwatchPanel.tsx`** — Extend props interface. Add `menuOpen` state. Add the panel toolbar row with the ≡ button and the popover menu. Add the `useEffect` click-outside dismissal. Add the optional error banner row.

7. **`src/components/panels/Swatch/SwatchPanel.module.scss`** — Add styles for: `.toolbar` (header row), `.menuBtn` (≡ button), `.contextMenu` (absolute-positioned dropdown), `.contextMenuItem` (individual menu button), `.errorBanner` (error message row).

8. **`src/components/window/RightPanel/RightPanel.tsx`** — Extend `RightPanelProps` with the five new optional fields; destructure and pass them directly to `<SwatchPanel>`.

9. **`src/App.tsx`** — Import and call `usePaletteFileOps`; pass the five values to `<RightPanel>`.

---

## Architectural Constraints

- **No direct filesystem access in the renderer.** All `readFile`/`writeFile` calls happen in the main process via IPC. The renderer only calls `window.api.*` methods. This is consistent with every other file operation in the codebase.
- **`usePaletteFileOps` owns exactly one concern.** It handles palette file I/O and nothing else — no swatch sorting, no UI state, no dialog visibility. This satisfies the single-concern hook rule in `AGENTS.md`.
- **`SwatchPanel` is a panel component** and is permitted to access `AppContext` directly and hold local UI state (`menuOpen`). The menu state is purely cosmetic and local — it belongs here, not in a parent.
- **`RightPanel` is a window component** and must not re-implement panel logic inline. It passes props through to `SwatchPanel` and adds no menu logic of its own.
- **`App.tsx` remains a thin orchestrator.** Calling `usePaletteFileOps` and threading its return values into `RightPanel` is the same pattern already used for `useFileOps`, `useAdjustments`, and all other hooks. No business logic should be inlined in `App.tsx`.
- **CSS Modules only.** All new styles go into `SwatchPanel.module.scss`. No plain `.scss` default imports.

---

## Open Questions

1. **Error dismissal UX.** The design proposes an error banner inside `SwatchPanel` dismissed by a `onClearPaletteError` prop. An alternative is a single `onClearPaletteError` callback that is automatically called the next time any palette operation is initiated (clear-on-next-action pattern). The simpler option (explicit ×  dismiss button via the prop) is recommended; decide before implementation.

2. **`SwatchPanel` toolbar layout.** The "Generate palette" button currently lives inside `panelBody > .actions`. Moving it into the new toolbar row keeps all panel actions in one header. If the designer prefers to keep "Generate palette" inside the panel body (above the grid), the toolbar row need only contain the ≡ button. Confirm with UX before implementation.

3. **IPC error paths.** `file:readPalette` and `file:writePalette` currently propagate raw Node.js errors (e.g. `EACCES`, `ENOENT`) to the renderer. Consider whether a human-readable wrapper message should be added in the main process or left to the hook's catch block. Recommended: catch in the hook and format as `"Could not read file: <err.message>"`.

4. **`.palette` extension enforcement on save.** Electron's `showSaveDialog` with a `filters` entry will suggest the extension but does not guarantee it on all platforms (e.g. Linux). Consider appending `.palette` to the returned path if it does not already end with it, inside `handleSavePaletteAs`, to ensure the file is always correctly named.
