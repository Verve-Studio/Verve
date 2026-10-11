import {
  materializeSnapshot,
  snapshotFull,
  type TiledLayerSnapshot,
} from "@/core/store/tiledSnapshot";
import type { AppAction } from "@/core/store/AppContext";
import {
  SKIP_LAYER_HISTORY,
  type ClearHistoryOptions,
  type HistoryEntry,
} from "@/core/store/historyStore";

import {
  createLayerDataBundle,
  type LayerDataBundle,
} from "@/core/store/layerPayload";
import { preferencesStore } from "@/core/store/preferencesStore";
import { selectionRevision } from "@/core/store/selectionStore";
import type { TabRecord } from "@/core/store/tabTypes";
import { toolRegistry } from "@/core/tools/toolRegistry";
import type { AppState, RGBAColor, Tool } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { Dispatch, MutableRefObject } from "react";
import { useCallback, useEffect, useRef } from "react";
import { activeScope, type DocumentScope } from "@/core/store/scope";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseHistoryOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  dispatch: Dispatch<AppAction>;
  activeTabIdRef: MutableRefObject<string>;
  setTabsRef: MutableRefObject<Dispatch<React.SetStateAction<TabRecord[]>>>;
  setPendingLayerData: Dispatch<
    React.SetStateAction<LayerDataBundle | null>
  >;
  /** state.layers — dependency for the capture-on-layer-change effect. */
  layers: AppState["layers"];
  /** The app store's subscribe: watches for document edits nothing recorded. */
  subscribe: (listener: () => void) => () => void;
}

export interface UseHistoryReturn {
  /**
   * Record the document as it is now (after an action) under `label`. A
   * capture identical to the current entry is dropped, so a redundant call
   * never adds a no-op undo step.
   */
  captureHistory: (
    label: string,
    overrides?: { swatches?: RGBAColor[] },
  ) => void;
  /** Canvas mounted: records "Initial State" for a new document, or the
   *  operation that remounted it (see `pendingRemountLabelRef`). */
  captureReadyHistory: () => void;
  /**
   * Label for the next change of `state.layers`. Operations that add, remove
   * or replace layers set it right before dispatching; the entry is captured
   * after the commit, once the canvas has created / destroyed the GPU layers.
   */
  pendingLayerLabelRef: MutableRefObject<string | null>;
  /** Label for the capture after the next canvas remount (resize, crop,
   *  rotate, …: operations whose result only exists on the new canvas). */
  pendingRemountLabelRef: MutableRefObject<string | null>;
  /** Label for the next selection-change entry (menu commands set it; tools
   *  get their own name). */
  selectionLabelRef: MutableRefObject<string | null>;
}

const SELECTION_TOOLS: ReadonlySet<Tool> = new Set<Tool>([
  "select",
  "lasso",
  "polygonal-selection",
  "magic-wand",
  "quick-select",
  "auto-mask",
]);

// ─── Snapshot comparison ───────────────────────────────────────────────────────

function sameSnapshot(
  a: TiledLayerSnapshot | null | undefined,
  b: TiledLayerSnapshot | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.width !== b.width ||
    a.height !== b.height ||
    a.channels !== b.channels ||
    a.float !== b.float ||
    a.tiles.length !== b.tiles.length
  )
    return false;
  // Tiles are immutable and shared between entries whenever unchanged, so
  // identity is the content check.
  for (let i = 0; i < a.tiles.length; i++) {
    if (a.tiles[i] !== b.tiles[i]) return false;
  }
  return true;
}

function sameSnapshotMap(
  a: ReadonlyMap<string, TiledLayerSnapshot>,
  b: ReadonlyMap<string, TiledLayerSnapshot>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, snap] of a) {
    if (!sameSnapshot(snap, b.get(id))) return false;
  }
  return true;
}

function sameGeometry(
  a: HistoryEntry["layerGeometry"],
  b: HistoryEntry["layerGeometry"],
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, g] of a) {
    const h = b.get(id);
    if (
      !h ||
      g.layerWidth !== h.layerWidth ||
      g.layerHeight !== h.layerHeight ||
      g.offsetX !== h.offsetX ||
      g.offsetY !== h.offsetY
    )
      return false;
  }
  return true;
}

// Typed arrays in state (a frame layer's image, LUT data) are immutable —
// replaced, never edited — so they compare by identity. Serialising them
// would write every byte as a JSON property (seconds, or a RangeError, for a
// placed photo).
const bufferIds = new WeakMap<object, number>();
let nextBufferId = 0;

function stableValue(_key: string, value: unknown): unknown {
  if (typeof value === "object" && value !== null && ArrayBuffer.isView(value)) {
    let id = bufferIds.get(value);
    if (id === undefined) {
      id = ++nextBufferId;
      bufferIds.set(value, id);
    }
    return `#buf${id}`;
  }
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return (
    a === b || JSON.stringify(a, stableValue) === JSON.stringify(b, stableValue)
  );
}

/** Like {@link stableValue}, also dropping layer-panel UI state stored on
 *  LayerState (group collapse isn't a document edit). */
function stableLayerValue(key: string, value: unknown): unknown {
  return key === "collapsed" ? undefined : stableValue(key, value);
}

function sameLayers(a: AppState["layers"], b: AppState["layers"]): boolean {
  return (
    a === b ||
    JSON.stringify(a, stableLayerValue) === JSON.stringify(b, stableLayerValue)
  );
}

/** The parts of AppState a history entry records (besides pixels). */
interface DocumentSlices {
  layers: AppState["layers"];
  swatches: AppState["swatches"];
  swatchGroups: AppState["swatchGroups"];
  spritesheet: AppState["spritesheet"];
  iccProfile: AppState["iccProfile"];
  pixelFormat: AppState["pixelFormat"];
}

function documentSlices(s: AppState): DocumentSlices {
  return {
    layers: s.layers,
    swatches: s.swatches,
    swatchGroups: s.swatchGroups,
    spritesheet: s.spritesheet,
    iccProfile: s.iccProfile,
    pixelFormat: s.pixelFormat,
  };
}

function flattenLayers(
  layers: AppState["layers"],
  out: Map<string, AppState["layers"][number]> = new Map(),
): Map<string, AppState["layers"][number]> {
  for (const l of layers) {
    out.set(l.id, l);
    const children = (l as { children?: AppState["layers"] }).children;
    if (children) flattenLayers(children, out);
  }
  return out;
}

/** Label for a document edit between two states, or null when nothing a
 *  history entry records changed (identity-only or UI-state changes). */
function describeEdit(a: DocumentSlices, b: DocumentSlices): string | null {
  if (a.pixelFormat !== b.pixelFormat) return "Convert Color Mode";
  if (a.layers !== b.layers && !sameLayers(a.layers, b.layers)) {
    const before = flattenLayers(a.layers);
    const after = flattenLayers(b.layers);
    if (before.size !== after.size) return "Edit Layers";
    for (const [id, l] of after) {
      const prev = before.get(id);
      if (!prev) return "Edit Layers";
      if (prev !== l && !sameLayers([prev], [l])) return `Edit ${l.name}`;
    }
    return "Edit Layers";
  }
  if (
    (a.swatches !== b.swatches && !sameValue(a.swatches, b.swatches)) ||
    (a.swatchGroups !== b.swatchGroups &&
      !sameValue(a.swatchGroups, b.swatchGroups))
  )
    return "Edit Palette";
  if (
    a.spritesheet !== b.spritesheet &&
    !sameValue(
      [a.spritesheet.enabled, a.spritesheet.cellWidth, a.spritesheet.cellHeight, a.spritesheet.animations],
      [b.spritesheet.enabled, b.spritesheet.cellWidth, b.spritesheet.cellHeight, b.spritesheet.animations],
    )
  )
    return "Edit Animation";
  if (a.iccProfile !== b.iccProfile && !sameBytes(a.iccProfile, b.iccProfile))
    return "Color Profile";
  return null;
}

/** Quiet time after the last unrecorded edit before the safety-net capture
 *  (so a burst — slider drag, typing in an options field — is one entry). */
const UNRECORDED_EDIT_DELAY_MS = 600;

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Whether two entries describe the same document (the active layer alone
 *  doesn't make an undo step). */
function sameDocument(a: HistoryEntry, b: HistoryEntry): boolean {
  return (
    a.canvasWidth === b.canvasWidth &&
    a.canvasHeight === b.canvasHeight &&
    a.pixelFormat === b.pixelFormat &&
    sameSnapshotMap(a.layerPixels, b.layerPixels) &&
    sameSnapshotMap(a.adjustmentMasks, b.adjustmentMasks) &&
    sameGeometry(a.layerGeometry, b.layerGeometry) &&
    sameSnapshot(a.selection ?? null, b.selection ?? null) &&
    sameBytes(a.iccProfile, b.iccProfile) &&
    sameLayers(a.layerState, b.layerState) &&
    sameValue(a.swatches, b.swatches) &&
    sameValue(a.swatchGroups, b.swatchGroups) &&
    sameValue(a.spritesheet, b.spritesheet)
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useHistory({
  canvasHandleRef,
  stateRef,
  dispatch,
  activeTabIdRef,
  setTabsRef,
  setPendingLayerData,
  layers,
  subscribe,
}: UseHistoryOptions): UseHistoryReturn {
  const pendingLayerLabelRef = useRef<string | null>(null);
  const pendingRemountLabelRef = useRef<string | null>(null);
  const selectionLabelRef = useRef<string | null>(null);
  const prevLayersRef = useRef(layers);
  const prevScopeRef = useRef<DocumentScope>(activeScope());
  // `state.layers` as set by the last history restore: that layer change is
  // the restore itself, not an edit to record.
  const restoredLayersRef = useRef<AppState["layers"] | null>(null);
  // Selection of an entry restored through a canvas remount, applied once
  // the new canvas (and its selection store dimensions) exist.
  const pendingSelectionRef = useRef<TiledLayerSnapshot | null | undefined>(
    undefined,
  );
  // True while onJumpTo runs: its dispatches restore state, they aren't
  // edits.
  const jumpingRef = useRef(false);
  // Record a deferred selection / safety-net capture right now (set by the
  // effects that own them; run before history navigation).
  const flushSelectionRef = useRef<(() => void) | null>(null);
  const flushEditsRef = useRef<(() => void) | null>(null);
  // True while a restore writes the selection (its notify isn't an edit).
  const restoringSelectionRef = useRef(false);
  // Snapshot of the selection at a given revision, shared by every capture
  // until the selection changes again.
  const selectionSnapRef = useRef<{
    scope: DocumentScope;
    revision: number;
    snap: TiledLayerSnapshot | null;
  } | null>(null);

  const captureSelection = useCallback(
    (prev: TiledLayerSnapshot | null | undefined): TiledLayerSnapshot | null => {
      const scope = activeScope();
      const cached = selectionSnapRef.current;
      if (
        cached &&
        cached.scope === scope &&
        cached.revision === selectionRevision
      )
        return cached.snap;
      const sel = scope.selection;
      const mask = sel.mask;
      const snap =
        mask && mask.length === sel.width * sel.height
          ? snapshotFull(mask, sel.width, sel.height, 1, prev ?? null)
          : null;
      selectionSnapRef.current = { scope, revision: selectionRevision, snap };
      return snap;
    },
    [],
  );

  const restoreSelection = useCallback(
    (snap: TiledLayerSnapshot | null | undefined): void => {
      const scope = activeScope();
      const sel = scope.selection;
      const target = snap ?? null;
      const cached = selectionSnapRef.current;
      if (
        cached &&
        cached.scope === scope &&
        cached.revision === selectionRevision &&
        sameSnapshot(cached.snap, target)
      )
        return;
      if (target && (target.width !== sel.width || target.height !== sel.height))
        return;
      restoringSelectionRef.current = true;
      try {
        sel.replaceMask(target ? (materializeSnapshot(target) as Uint8Array) : null);
      } finally {
        restoringSelectionRef.current = false;
      }
      selectionSnapRef.current = { scope, revision: selectionRevision, snap: target };
    },
    [],
  );

  const captureHistory = useCallback(
    (label: string, overrides?: { swatches?: RGBAColor[] }): void => {
      const handle = canvasHandleRef.current;
      if (!handle) return;
      if (handle.borrowAllLayerPixels().size === 0) return;
      const history = activeScope().history;
      // Each layer's snapshot shares every tile that is unchanged since the
      // layer's history base (the snapshot last captured or restored for it)
      // and copies only the tiles written since — see tiledSnapshot.ts. The
      // current entry is only a content de-dup fallback for layers without a
      // base (new, grown, remounted, converted).
      const prev = history.entries[history.currentIndex];
      const layerGeometry = handle.captureAllLayerGeometry();
      const adjustmentMasks = handle.captureAllAdjustmentMasks(
        prev?.adjustmentMasks,
      );
      const layerPixels = handle.captureAllLayerSnapshots(prev?.layerPixels);
      const selection = captureSelection(prev?.selection);

      const s = stateRef.current;
      const entry: HistoryEntry = {
        id: `hist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        label,
        timestamp: Date.now(),
        layerPixels,
        layerGeometry,
        adjustmentMasks,
        selection,
        layerState: s.layers,
        activeLayerId: s.activeLayerId,
        canvasWidth: s.canvas.width,
        canvasHeight: s.canvas.height,
        swatches: overrides?.swatches ?? s.swatches,
        swatchGroups: s.swatchGroups,
        spritesheet: {
          enabled: s.spritesheet.enabled,
          cellWidth: s.spritesheet.cellWidth,
          cellHeight: s.spritesheet.cellHeight,
          animations: s.spritesheet.animations,
        },
        iccProfile: s.iccProfile,
        pixelFormat: s.pixelFormat,
      };
      if (prev && sameDocument(prev, entry)) return;
      history.push(entry);
    },
    [canvasHandleRef, stateRef, captureSelection],
  );

  const captureReadyHistory = useCallback((): void => {
    const label = pendingRemountLabelRef.current;
    pendingRemountLabelRef.current = null;
    const history = activeScope().history;
    if (pendingSelectionRef.current !== undefined) {
      restoreSelection(pendingSelectionRef.current);
      pendingSelectionRef.current = undefined;
    } else if (label === null && history.entries.length > 0) {
      // Tab switch / GPU recovery: the new canvas starts with no selection,
      // but the document (its current entry) has one.
      restoreSelection(history.entries[history.currentIndex]?.selection);
    }
    // A remount of a document whose history already describes it (tab
    // switch or close, history jump, GPU recovery, format remount after its
    // own capture) records nothing.
    if (label === null && history.entries.length > 0) return;
    captureHistory(label ?? "Initial State");
  }, [captureHistory, restoreSelection]);

  const restoreSpritesheet = useCallback(
    (
      ss: HistoryEntry["spritesheet"],
      // View state (onion skin, selection) to keep: the current one, or the
      // one from before a remount's SWITCH_TAB reset it.
      cur: AppState["spritesheet"] = stateRef.current.spritesheet,
    ): void => {
      if (!ss) return;
      const anim =
        ss.animations.find((a) => a.id === cur.selectedAnimationId) ?? null;
      dispatch({
        type: "SET_SPRITESHEET",
        payload: {
          ...ss,
          onionSkin: cur.onionSkin,
          onionFrames: cur.onionFrames,
          selectedAnimationId: anim?.id ?? ss.animations[0]?.id ?? null,
          selectedFrameId:
            anim && anim.frames.some((f) => f.id === cur.selectedFrameId)
              ? cur.selectedFrameId
              : null,
        },
      });
    },
    [dispatch, stateRef],
  );

  // Jump-to: undo / redo / click in the History panel. May remount the
  // canvas when the entry has another size or pixel format.
  useEffect(() => {
    activeScope().history.onJumpTo = (index: number): void => {
      const history = activeScope().history;
      const entry = history.entries[index];
      if (!entry) return;
      jumpingRef.current = true;
      try {
        jumpTo(history, index, entry);
      } finally {
        jumpingRef.current = false;
      }
    };
    const jumpTo = (
      history: ReturnType<typeof activeScope>["history"],
      index: number,
      entry: HistoryEntry,
    ): void => {
      const currentW = stateRef.current.canvas.width;
      const currentH = stateRef.current.canvas.height;
      restoredLayersRef.current = entry.layerState;
      // Labels set for an operation that never committed must not label
      // whatever happens after the restore.
      pendingLayerLabelRef.current = null;

      const formatChanged =
        entry.pixelFormat !== undefined &&
        entry.pixelFormat !== stateRef.current.pixelFormat;
      if (
        entry.canvasWidth !== currentW ||
        entry.canvasHeight !== currentH ||
        formatChanged
      ) {
        // Hand the history buffers straight to the remounting canvas (the
        // init path copies them out, so sharing the history's buffers is
        // safe). Each entry records its own format: a jump across a colour-
        // mode conversion restores the pre-conversion format.
        const pending = createLayerDataBundle();
        for (const [id, snap] of entry.layerPixels) {
          pending.layers.set(id, {
            format: snap.float
              ? "rgba32f"
              : snap.channels === 1
                ? "indexed8"
                : "rgba8",
            data: materializeSnapshot(snap),
            geo: entry.layerGeometry?.get(id),
          });
        }
        for (const [layerId, maskSnap] of entry.adjustmentMasks) {
          pending.adjustmentMasks.set(
            layerId,
            materializeSnapshot(maskSnap) as Uint8Array,
          );
        }
        pendingRemountLabelRef.current = null;
        pendingSelectionRef.current = entry.selection ?? null;
        setPendingLayerData(pending);
        const viewSpritesheet = stateRef.current.spritesheet;
        const jumpTabId = activeTabIdRef.current;
        setTabsRef.current((prev) =>
          prev.map((t) =>
            t.id === jumpTabId
              ? {
                  ...t,
                  canvasKey: t.canvasKey + 1,
                  snapshot: {
                    ...t.snapshot,
                    canvasWidth: entry.canvasWidth,
                    canvasHeight: entry.canvasHeight,
                  },
                }
              : t,
          ),
        );
        dispatch({
          type: "SWITCH_TAB",
          payload: {
            width: entry.canvasWidth,
            height: entry.canvasHeight,
            backgroundFill: stateRef.current.canvas.backgroundFill,
            layers: entry.layerState,
            activeLayerId: entry.activeLayerId,
            zoom: stateRef.current.canvas.zoom,
            tiledMode: stateRef.current.canvas.tiledMode,
            showTileGrid: stateRef.current.canvas.showTileGrid,
            // Preserve current format when the entry predates pixel-format
            // capture; the SWITCH_TAB reducer would otherwise reset to rgba8.
            pixelFormat: entry.pixelFormat ?? stateRef.current.pixelFormat,
            iccProfile: entry.iccProfile,
          },
        });
        if (entry.swatches) {
          dispatch({ type: "SET_SWATCHES", payload: entry.swatches });
        }
        if (entry.swatchGroups) {
          dispatch({ type: "SET_SWATCH_GROUPS", payload: entry.swatchGroups });
        }
        restoreSpritesheet(entry.spritesheet, viewSpritesheet);
      } else {
        canvasHandleRef.current?.restoreAllLayerPixels(
          entry.layerPixels,
          entry.layerGeometry,
          entry.layerState,
        );
        canvasHandleRef.current?.restoreAllAdjustmentMasks(
          entry.adjustmentMasks,
        );
        restoreSelection(entry.selection);
        dispatch({
          type: "RESTORE_LAYERS",
          payload: {
            layers: entry.layerState,
            activeLayerId: entry.activeLayerId,
          },
        });
        if (entry.swatches) {
          dispatch({ type: "SET_SWATCHES", payload: entry.swatches });
        }
        if (entry.swatchGroups) {
          dispatch({ type: "SET_SWATCH_GROUPS", payload: entry.swatchGroups });
        }
        restoreSpritesheet(entry.spritesheet);
        dispatch({ type: "SET_ICC_PROFILE", payload: entry.iccProfile });
        if (entry.pixelFormat) {
          dispatch({ type: "SET_PIXEL_FORMAT", payload: entry.pixelFormat });
        }
      }

      history.setCurrent(index);
    };
    return () => {
      activeScope().history.onJumpTo = null;
    };
  }, [
    dispatch,
    canvasHandleRef,
    stateRef,
    activeTabIdRef,
    setTabsRef,
    setPendingLayerData,
    restoreSelection,
    restoreSpritesheet,
  ]);

  // Register onClear: capture current state as 'History Cleared' entry
  useEffect(() => {
    activeScope().history.onClear = (options?: ClearHistoryOptions): void => {
      if (options?.recaptureSnapshot === false) return;
      captureHistory("History Cleared");
    };
    return () => {
      activeScope().history.onClear = null;
    };
  }, [captureHistory]);

  // Sync history memory cap from preferences. Pushes the current value on
  // mount and re-pushes whenever the user changes it in Preferences →
  // Memory; the store immediately evicts oldest entries to fit.
  useEffect(() => {
    activeScope().history.setMemoryCapBytes(preferencesStore.get().historyMemoryBytes);
    return preferencesStore.subscribe(() => {
      activeScope().history.setMemoryCapBytes(preferencesStore.get().historyMemoryBytes);
    });
  }, []);

  // Capture after a committed layer change: layers added, removed or
  // replaced (labelled through pendingLayerLabelRef). Runs after the
  // canvas's own effects, so new layers' pixels exist by now.
  useEffect(() => {
    const prev = prevLayersRef.current;
    prevLayersRef.current = layers;
    const scope = activeScope();
    const scopeChanged = scope !== prevScopeRef.current;
    prevScopeRef.current = scope;
    if (prev === layers) return;
    const label = pendingLayerLabelRef.current;
    pendingLayerLabelRef.current = null;
    // Another document's layers (tab switch / close) or a history restore.
    if (scopeChanged) return;
    if (layers === restoredLayersRef.current) {
      restoredLayersRef.current = null;
      return;
    }
    if (label === SKIP_LAYER_HISTORY) return;
    if (label !== null) captureHistory(label);
    else if (layers.length > prev.length) captureHistory("New Layer");
    else if (layers.length < prev.length) captureHistory("Delete Layer");
  }, [layers, captureHistory]);

  // Selection changes are undo steps (Photoshop-style). Captured once the
  // gesture is over: a drag that edits the selection on every move (Move
  // tool, quick select) records one entry at pointer-up, after the tool's
  // own capture, which then usually already holds the selection.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pointerDown = false;
    let pending = false;
    const flush = (): void => {
      timer = null;
      if (!pending || pointerDown) return;
      pending = false;
      const scope = activeScope();
      // A floating transform owns the layer pixels and selection until it
      // is applied or cancelled; applying records the result.
      if (scope.transform.isActive) return;
      const label = selectionLabelRef.current;
      selectionLabelRef.current = null;
      if (!scope.selection.mask) {
        captureHistory(label ?? "Deselect");
        return;
      }
      const tool = stateRef.current.activeTool;
      captureHistory(
        label ??
          (SELECTION_TOOLS.has(tool)
            ? (toolRegistry.get(tool)?.label ?? "Selection")
            : "Selection"),
      );
    };
    const schedule = (): void => {
      if (timer === null) timer = setTimeout(flush, 0);
    };
    flushSelectionRef.current = (): void => {
      if (!pending) return;
      if (timer !== null) clearTimeout(timer);
      pointerDown = false;
      flush();
    };
    const onSelection = (): void => {
      if (restoringSelectionRef.current) return;
      pending = true;
      if (!pointerDown) schedule();
    };
    const onDown = (): void => {
      pointerDown = true;
    };
    const onUp = (): void => {
      pointerDown = false;
      if (pending) schedule();
    };
    const sel = activeScope().selection;
    sel.subscribe(onSelection);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    // A pointerup lost to a window switch mid-drag must not stall recording.
    window.addEventListener("blur", onUp);
    return () => {
      sel.unsubscribe(onSelection);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("blur", onUp);
      if (timer !== null) clearTimeout(timer);
      flushSelectionRef.current = null;
    };
  }, [captureHistory, stateRef]);

  // Safety net for document edits no explicit capture records (options-bar
  // edits of text / shape / frame layers, animation panel, any future
  // control that forgets to): once input settles, record them. Explicit
  // captures normally already hold the state, and then this one de-dups.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pointerDown = false;
    let label: string | null = null;
    let scope = activeScope();
    let last = documentSlices(stateRef.current);
    const busy = (): boolean =>
      pointerDown ||
      // A remount's result is recorded when the new canvas is ready.
      pendingRemountLabelRef.current !== null ||
      activeScope().transform.isActive ||
      // Typing (text editor, rename field): wait for the commit / blur.
      (document.activeElement instanceof HTMLElement &&
        (document.activeElement.tagName === "TEXTAREA" ||
          document.activeElement.isContentEditable));
    const flush = (): void => {
      timer = null;
      if (label === null) return;
      if (busy()) {
        timer = setTimeout(flush, UNRECORDED_EDIT_DELAY_MS);
        return;
      }
      if (activeScope() !== scope) {
        label = null;
        return;
      }
      const l = label;
      label = null;
      captureHistory(l);
    };
    const onStore = (): void => {
      const next = documentSlices(stateRef.current);
      const s = activeScope();
      if (s !== scope || jumpingRef.current) {
        // Another document, or a history restore: new baseline.
        scope = s;
        last = next;
        label = null;
        return;
      }
      const edit = describeEdit(last, next);
      last = next;
      if (edit === null) return;
      label = edit;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, UNRECORDED_EDIT_DELAY_MS);
    };
    flushEditsRef.current = (): void => {
      if (label === null || activeScope().transform.isActive) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (activeScope() !== scope) {
        label = null;
        return;
      }
      const l = label;
      label = null;
      captureHistory(l);
    };
    const onDown = (): void => {
      pointerDown = true;
    };
    const onUp = (): void => {
      pointerDown = false;
    };
    const unsubscribe = subscribe(onStore);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("blur", onUp);
    return () => {
      unsubscribe();
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("blur", onUp);
      if (timer !== null) clearTimeout(timer);
      flushEditsRef.current = null;
    };
  }, [subscribe, captureHistory, stateRef]);

  // Undo / redo / a jump first record whatever is still waiting.
  useEffect(() => {
    activeScope().history.onBeforeNavigate = (): void => {
      flushSelectionRef.current?.();
      flushEditsRef.current?.();
    };
    return () => {
      activeScope().history.onBeforeNavigate = null;
    };
  }, []);

  return {
    captureHistory,
    captureReadyHistory,
    pendingLayerLabelRef,
    pendingRemountLabelRef,
    selectionLabelRef,
  };
}
