import { useEffect, type MutableRefObject } from "react";
import type { AppStore } from "@/core/store/AppContext";
import { activeScope } from "@/core/store/scope";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";

/**
 * Development builds only: exposes the live store, canvas handle, menu
 * handlers and active scope as `window.__verveTest`, so an end-to-end test
 * driver attached over the DevTools protocol can run real app operations and
 * inspect the document (e.g. undo/redo round-trip tests). Production builds
 * drop the hook entirely.
 */
export function useDevTestHook(deps: {
  store: AppStore;
  canvasHandleRef: { readonly current: CanvasHandle | null };
  menuHandlersRef: MutableRefObject<object>;
}): void {
  const { store, canvasHandleRef, menuHandlersRef } = deps;
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as Record<string, unknown>;
    w.__verveTest = {
      getState: store.getState,
      dispatch: store.dispatch,
      get canvas() {
        return canvasHandleRef.current;
      },
      get menu() {
        return menuHandlersRef.current;
      },
      scope: activeScope,
    };
    return () => {
      delete w.__verveTest;
    };
  }, [store, canvasHandleRef, menuHandlersRef]);
}
