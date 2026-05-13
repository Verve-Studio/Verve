// ─── Document scope ──────────────────────────────────────────────────────────
//
// A `DocumentScope` is the bundle of stateful stores that belong to **one
// document/tab**. Each tab owns its own instance, so switching tabs is just
// `setActiveScope(tab.scope)` — no copying, no snapshot/restore dance.
//
// Cross-document stores (clipboard, brushes, preferences, notifications)
// stay as plain module-level singletons; they're not in here.
//
// Subscribers are kept at module scope inside each store file (not on the
// instance), so a component that subscribed to `selection` while Tab 1 was
// active will still wake up when Tab 2's selection mutates after a switch.
// `setActiveScope` fires every store's `notify()` so subscribers re-read
// from the new active instance.

import { SelectionStore } from "./selectionStore";
import { HistoryStore } from "./historyStore";
import { CropStore } from "./cropStore";
import { TransformStore } from "./transformStore";
import { PolygonalSelectionStore } from "./polygonalSelectionStore";
import { InpaintMaskStore } from "./inpaintMaskStore";
import { CloneStampStore } from "./cloneStampStore";
import { AdjustmentPreviewStore } from "./adjustmentPreviewStore";
import { PaletteCycleStore } from "./paletteCycleStore";
import { BrushOverridesStore } from "./brushOverridesStore";

export interface DocumentScope {
  selection: SelectionStore;
  history: HistoryStore;
  crop: CropStore;
  transform: TransformStore;
  polygonalSelection: PolygonalSelectionStore;
  inpaintMask: InpaintMaskStore;
  cloneStamp: CloneStampStore;
  adjustmentPreview: AdjustmentPreviewStore;
  paletteCycle: PaletteCycleStore;
  brushOverrides: BrushOverridesStore;
}

export function createDocumentScope(): DocumentScope {
  return {
    selection: new SelectionStore(),
    history: new HistoryStore(),
    crop: new CropStore(),
    transform: new TransformStore(),
    polygonalSelection: new PolygonalSelectionStore(),
    inpaintMask: new InpaintMaskStore(),
    cloneStamp: new CloneStampStore(),
    adjustmentPreview: new AdjustmentPreviewStore(),
    paletteCycle: new PaletteCycleStore(),
    brushOverrides: new BrushOverridesStore(),
  };
}

// A bootstrap scope is created at module load so any code path (subscribers
// in `useEffect`, early-mount hooks like `useSelectionFlag`) can safely call
// `activeScope()` before the first tab exists. `useTabs` swaps in a real
// per-tab scope as soon as a document is opened/created.
let _active: DocumentScope = createDocumentScope();

/**
 * Returns the currently-active document scope. Always defined — a bootstrap
 * scope is provisioned at module load. Most callers should use this; tool
 * handlers receive the scope through `ToolContext.scope` instead.
 */
export function activeScope(): DocumentScope {
  return _active;
}

/**
 * Switch the active scope. Fires every store's notify() so module-level
 * subscribers (registered via `instance.subscribe(fn)`) re-read from the
 * new active instance — that's how Canvas's marquee renderer, panel
 * subscriptions, etc. survive tab switches.
 */
export function setActiveScope(scope: DocumentScope): void {
  if (scope === _active) return;
  _active = scope;
  scope.selection.notify();
  scope.history.notify();
  scope.crop.notify();
  scope.transform.notify();
  scope.polygonalSelection.notify();
  scope.inpaintMask.notify();
  scope.cloneStamp.notify();
  scope.adjustmentPreview.notify();
  scope.paletteCycle.notify();
  scope.brushOverrides.notify();
}
