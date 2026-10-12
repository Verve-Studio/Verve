import { useEffect, type MutableRefObject } from "react";
import type { AppStore } from "@/core/store/AppContext";
import { activeScope } from "@/core/store/scope";
import { automationHostProvider } from "@/core/nodes/automationHostProvider";
import { parseAutomation } from "@/core/nodes/automationFile";
import { effectRegistry } from "@/core/effects/effectRegistry";
import { workflowRunStore } from "@/ux/main/NodeEditor/workflowRunStore";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";

/**
 * Development and end-to-end test builds only: exposes the live store, canvas
 * handle, menu handlers, cell animation commands, active scope and automation
 * host as `window.__verveTest`, so a test driver (Playwright, see `e2e/`, or a
 * DevTools-protocol script) can run real app operations and inspect the
 * document (e.g. undo/redo round-trip tests). Release builds drop the hook
 * entirely: `VITE_VERVE_E2E` is only set by `npm run build:e2e`.
 */
export function useDevTestHook(deps: {
  store: AppStore;
  canvasHandleRef: { readonly current: CanvasHandle | null };
  menuHandlersRef: MutableRefObject<object>;
  /** Cell animation commands and playback (latest render). */
  cellRef?: MutableRefObject<object>;
}): void {
  const { store, canvasHandleRef, menuHandlersRef, cellRef } = deps;
  useEffect(() => {
    if (!import.meta.env.DEV && import.meta.env.VITE_VERVE_E2E !== "1") return;
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
      get cell() {
        return cellRef?.current;
      },
      scope: activeScope,
      get automation() {
        return automationHostProvider.get();
      },
      /** Registered effects (the bundle can't be imported from a test). */
      effects: () =>
        effectRegistry.all().map((e) => ({
          id: e.id,
          label: e.label,
          root: e.menu.root,
          submenu: e.menu.submenu ?? null,
          fields: (e.paramFields ?? []).map((f) => ({ id: f.id, label: f.label, spec: f.spec })),
        })),
      /** Automation workflows: parse `.automation` text and run graphs the
       *  way the Automation tab does. */
      workflows: {
        parse: parseAutomation,
        run: (graph: Parameters<typeof workflowRunStore.run>[0]) => workflowRunStore.run(graph),
        state: () => workflowRunStore.getSnapshot(),
        clearLog: () => workflowRunStore.clearLog(),
      },
    };
    return () => {
      delete w.__verveTest;
    };
  }, [store, canvasHandleRef, menuHandlersRef, cellRef]);
}
