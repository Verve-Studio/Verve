/**
 * Brush library hook — manages document-scope and user-scope paint brushes.
 *
 * Document brushes live on AppState.brushes (saved with the .verve file).
 * User brushes live in `brushStore` (saved to electron userData/paint-brushes.json).
 *
 * The active brush is identified by AppState.activeBrushId. Lookups check the
 * document list first, then the user store, so a document can override a user
 * brush of the same id (matters when a saved file is opened with custom brushes).
 */
import { useCallback, useEffect, useState } from "react";
import { useAppContext } from "@/core/store/AppContext";
import { brushStore } from "@/core/store/brushStore";
import type { Brush } from "@/types";
import { makeDefaultBrush } from "@/types";

export interface UseBrushesResult {
  /** All brushes, document first then user, deduplicated by id. */
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
  updateBrush: (brush: Brush) => Promise<void>;
  deleteBrush: (id: string) => Promise<void>;
  /** Promote a user brush into the document, or vice versa. */
  duplicateBrush: (
    id: string,
    targetScope: "document" | "user",
  ) => Promise<Brush>;
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

  const documentBrushes = state.brushes;

  // Document brushes shadow user brushes with the same id.
  const allBrushes: Brush[] = (() => {
    const seen = new Set<string>();
    const out: Brush[] = [];
    for (const b of documentBrushes) {
      seen.add(b.id);
      out.push(b);
    }
    for (const b of userBrushes) {
      if (!seen.has(b.id)) out.push(b);
    }
    return out;
  })();

  const activeBrush =
    allBrushes.find((b) => b.id === state.activeBrushId) ?? FALLBACK_BRUSH;

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

  const updateBrush = useCallback(
    async (brush: Brush): Promise<void> => {
      if (brush.scope === "document") {
        dispatch({ type: "UPDATE_BRUSH", payload: brush });
      } else {
        await brushStore.updateUserBrush(brush);
      }
    },
    [dispatch],
  );

  const deleteBrush = useCallback(
    async (id: string): Promise<void> => {
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
  };
}
