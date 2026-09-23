# 038 · No crash handling and no unsaved-changes guard on close

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | High |
| Category | Stability / Data loss |
| Area | Electron main / App shell |
| Verified | No — reported by reviewer |

## Problem
No `render-process-gone`, `child-process-gone` (GPU process) or `unresponsive` handlers, and no `mainWindow.on('close')` guard. No dirty tracking or `beforeunload` in `src/`; `app:exit` (`ipc.ts:529`) just calls `app.quit()`. A renderer OOM leaves a blank white window with no message. Closing with X or File > Exit discards all unsaved tabs without asking.

## Where
- `electron/main/index.ts:84-127`
- `electron/main/ipc.ts:529`

## Suggested fix
- `render-process-gone` / `child-process-gone`: log `details.reason`, show a dialog, offer to reload.
- Track a per-tab dirty flag (set on history push, cleared on save).
- `close`: `preventDefault()`, ask the renderer via IPC whether any tab is dirty, show Save / Don't Save / Cancel.
- Later: periodic autosave to userData for crash recovery.

## Done when
- Closing with unsaved changes prompts; killing the renderer process shows a recoverable dialog instead of a white window.


## Resolution
Unsaved changes:
- `HistoryStore` tracks the entry that was last saved (`markSaved()` / `isDirty()`); a fresh or opened document is clean while it sits on its baseline entry.
- The new `useUnsavedDocumentsReporter` pushes the titles of unsaved documents to main whenever history or tabs change.
- The main window's `close` handler (X, File > Exit, Cmd+Q) shows "Quit Without Saving / Cancel" listing them.

Crashes:
- `render-process-gone` shows a dialog (Reload / Quit) instead of a white window.
- `unresponsive` offers Keep Waiting / Reload.
- `child-process-gone` is logged; GPU loss is recovered in the renderer (023).

Not done: periodic autosave for crash recovery.
