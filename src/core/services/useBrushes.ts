/**
 * Brush library hook — manages document-scope and user-scope paint brushes.
 *
 * Document brushes live on AppState.brushes (saved with the .verve file).
 * User brushes live in `brushStore` (saved to electron userData/paint-brushes.json).
 *
 * The active brush is identified by AppState.activeBrushId. Lookups check the
 * document list first, then the user store, so a document can override a user
 * brush of the same id (matters when a saved file is opened with custom brushes).
 *
 * Live edits go through a *per-document override layer*
 * (`activeScope().brushOverrides`), NOT directly to the canonical store.
 * That lets the artist tweak a brush while painting without mutating the
 * saved definition. The exposed `activeBrush` is the canonical brush
 * merged with the doc's override. Three explicit actions commit / discard
 * the overrides:
 *   * `saveActiveBrushOverrides` — copy effective → canonical, drop override.
 *   * `saveActiveBrushAsNew`     — create a new canonical from effective.
 *   * `revertActiveBrushOverrides` — drop override, canonical re-asserts.
 */
import { useCallback, useEffect, useState } from "react";
import { useAppContext } from "@/core/store/AppContext";
import { brushStore } from "@/core/store/brushStore";
import { activeScope } from "@/core/store/scope";
import type { Brush } from "@/types";
import { makeDefaultBrush } from "@/types";

export interface UseBrushesResult {
  /** All brushes, document first then user, deduplicated by id, with each
   *  one's per-doc override merged in. The "modified" indicator is what
   *  the UI compares against `isBrushModified(id)`. */
  allBrushes: Brush[];
  documentBrushes: Brush[];
  userBrushes: Brush[];
  activeBrush: Brush;
  selectBrush: (id: string) => void;
  /** Add a new brush; scope decides which store. Returns the brush. */
  createBrush: (
    init?: Partial<Brush> & { name?: string },
    scope?: "document" | "user",
  ) => Promise<Brush>;
  /** Patch the active doc's override for the given brush. Use this for
   *  live UI edits — it does NOT touch the on-disk / saved-with-file
   *  canonical definition. The runtime `activeBrush` reflects the change
   *  immediately. */
  updateBrush: (brush: Brush) => Promise<void>;
  deleteBrush: (id: string) => Promise<void>;
  /** Promote a user brush into the document, or vice versa. */
  duplicateBrush: (
    id: string,
    targetScope: "document" | "user",
  ) => Promise<Brush>;
  /** True when the active brush has unsaved overrides in this document. */
  isActiveBrushModified: boolean;
  /** Set of brush ids that have unsaved overrides in this doc. */
  modifiedBrushIds: ReadonlySet<string>;
  /** Commit the active doc's overrides for the active brush into the
   *  canonical store (user or document, whichever the brush's `scope`
   *  says) and drop the override. */
  saveActiveBrushOverrides: () => Promise<void>;
  /** Create a new user-scope brush from the active brush's effective
   *  state (canonical + override). Doesn't touch the original. Returns
   *  the new brush. */
  saveActiveBrushAsNew: (name?: string) => Promise<Brush>;
  /** Drop the active doc's override for the active brush; the canonical
   *  definition re-asserts immediately. */
  revertActiveBrushOverrides: () => void;
}

const FALLBACK_BRUSH = makeDefaultBrush("__fallback", "Default");

export function useBrushes(): UseBrushesResult {
  const { state, dispatch } = useAppContext();
  const [userBrushes, setUserBrushes] = useState<Brush[]>(
    brushStore.getUserBrushes(),
  );

  useEffect(() => {
    const sync = (): void => setUserBrushes([...brushStore.getUserBrushes()]);
    brushStore.subscribe(sync);
    void brushStore.init().then(sync);
    return () => brushStore.unsubscribe(sync);
  }, []);

  // Bump a counter every time the active doc's override store mutates or
  // the active scope itself switches. Re-runs the merge below so all
  // consumers see the effective brush. We read `activeScope()` lazily
  // inside callbacks/derivations so the always-current store instance is
  // used — `setActiveScope` notifies module-level listeners on switch,
  // which fires this subscription and re-renders.
  const [overridesEpoch, setOverridesEpoch] = useState(0);
  useEffect(() => {
    const bump = (): void => setOverridesEpoch((n) => n + 1);
    // Subscribe to whichever store instance is currently active. The
    // subscriber list is module-level, so it survives scope switches.
    activeScope().brushOverrides.subscribe(bump);
    return () => activeScope().brushOverrides.unsubscribe(bump);
  }, []);

  const documentBrushes = state.brushes;

  // Document brushes shadow user brushes with the same id; overrides
  // shadow either. The merge happens here so every consumer (the active
  // brush, the gallery list, the modified-indicator set) sees the same
  // effective view.
  const overrides = activeScope().brushOverrides;
  // overridesEpoch is read so the memoized derivation below depends on
  // the latest override state. Lint suppression is unnecessary because
  // the value flows through `allBrushes` / `modifiedBrushIds`.
  void overridesEpoch;
  const allBrushes: Brush[] = (() => {
    const seen = new Set<string>();
    const out: Brush[] = [];
    for (const b of documentBrushes) {
      seen.add(b.id);
      out.push(overrides.applyTo(b));
    }
    for (const b of userBrushes) {
      if (!seen.has(b.id)) out.push(overrides.applyTo(b));
    }
    return out;
  })();
  const modifiedBrushIds = overrides.modifiedIds();

  const activeBrush =
    allBrushes.find((b) => b.id === state.activeBrushId) ?? FALLBACK_BRUSH;
  const isActiveBrushModified = overrides.has(activeBrush.id);

  const selectBrush = useCallback(
    (id: string) => {
      dispatch({ type: "SET_ACTIVE_BRUSH", payload: id });
    },
    [dispatch],
  );

  const createBrush = useCallback(
    async (
      init: Partial<Brush> & { name?: string } = {},
      scope: "document" | "user" = "user",
    ): Promise<Brush> => {
      const id = crypto.randomUUID();
      const base = makeDefaultBrush(id, init.name ?? "New Brush");
      const brush: Brush = { ...base, ...init, id, scope };
      if (scope === "document") {
        dispatch({ type: "ADD_BRUSH", payload: brush });
      } else {
        await brushStore.addUserBrush(brush);
      }
      dispatch({ type: "SET_ACTIVE_BRUSH", payload: id });
      return brush;
    },
    [dispatch],
  );

  // Live edits go to the per-doc override layer. Disk / .verve canonical
  // is left untouched until the user explicitly saves. `Promise<void>` is
  // kept on the signature for API parity with the previous version.
  const updateBrush = useCallback(
    async (brush: Brush): Promise<void> => {
      activeScope().brushOverrides.patch(brush.id, brush);
    },
    [],
  );

  const deleteBrush = useCallback(
    async (id: string): Promise<void> => {
      // Deletion is a hard action on the canonical store. Drop any
      // override first so the in-memory state stays consistent.
      activeScope().brushOverrides.clear(id);
      const docBrush = documentBrushes.find((b) => b.id === id);
      if (docBrush) {
        dispatch({ type: "REMOVE_BRUSH", payload: id });
      } else {
        await brushStore.removeUserBrush(id);
      }
    },
    [dispatch, documentBrushes],
  );

  const duplicateBrush = useCallback(
    async (id: string, targetScope: "document" | "user"): Promise<Brush> => {
      const src = allBrushes.find((b) => b.id === id);
      if (!src) throw new Error(`Brush ${id} not found`);
      const copy: Brush = {
        ...src,
        id: crypto.randomUUID(),
        name: `${src.name} copy`,
        scope: targetScope,
        createdAt: Date.now(),
      };
      if (targetScope === "document") {
        dispatch({ type: "ADD_BRUSH", payload: copy });
      } else {
        await brushStore.addUserBrush(copy);
      }
      return copy;
    },
    [allBrushes, dispatch],
  );

  const saveActiveBrushOverrides = useCallback(async (): Promise<void> => {
    const id = activeBrush.id;
    const effective = activeBrush;
    // Effective brush is already the merged view (canonical + override).
    // Writing it back to the canonical store and clearing the override
    // is the "commit" path.
    if (effective.scope === "document") {
      dispatch({ type: "UPDATE_BRUSH", payload: effective });
    } else {
      await brushStore.updateUserBrush(effective);
    }
    activeScope().brushOverrides.clear(id);
  }, [activeBrush, dispatch]);

  const saveActiveBrushAsNew = useCallback(
    async (name?: string): Promise<Brush> => {
      const src = activeBrush;
      const copy: Brush = {
        ...src,
        id: crypto.randomUUID(),
        name: name ?? `${src.name} copy`,
        scope: "user",
        createdAt: Date.now(),
      };
      await brushStore.addUserBrush(copy);
      // Switch active to the new brush. The override on the original id
      // is left in place — the user can still revert to it on the
      // original brush if they want.
      dispatch({ type: "SET_ACTIVE_BRUSH", payload: copy.id });
      return copy;
    },
    [activeBrush, dispatch],
  );

  const revertActiveBrushOverrides = useCallback((): void => {
    activeScope().brushOverrides.clear(activeBrush.id);
  }, [activeBrush.id]);

  return {
    allBrushes,
    documentBrushes,
    userBrushes,
    activeBrush,
    selectBrush,
    createBrush,
    updateBrush,
    deleteBrush,
    duplicateBrush,
    isActiveBrushModified,
    modifiedBrushIds,
    saveActiveBrushOverrides,
    saveActiveBrushAsNew,
    revertActiveBrushOverrides,
  };
}
