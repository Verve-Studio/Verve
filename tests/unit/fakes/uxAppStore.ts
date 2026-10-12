// Test helpers for components and hooks that read the real app store
// (AppProvider + appReducer). Written for the src/ux + src/core/services
// tests.
//
// The store is the production one: `renderWithAppStore` / `renderHookWithAppStore`
// mount the subject under <AppProvider> and hand back the store so a test can
// seed state with real actions and assert on the reduced result.

import { createElement, type ReactElement, type ReactNode } from "react";
import { render, renderHook, type RenderResult } from "@testing-library/react";
import { AppProvider, useAppStore, type AppAction, type AppStore } from "@/core/store/AppContext";
import type { AppState, LayerState, MaskLayerState, PixelLayerState, GroupLayerState } from "@/types";

function StoreProbe({ onStore }: { onStore: (s: AppStore) => void }): null {
  onStore(useAppStore());
  return null;
}

/** Render `ui` under a fresh AppProvider. `seed` actions run before `ui`
 *  mounts. */
export function renderWithAppStore(
  ui: ReactElement,
  seed: readonly AppAction[] = [],
): RenderResult & { store: AppStore } {
  let store: AppStore | null = null;
  // Mount the probe alone first so seed actions apply before `ui` renders.
  const result = render(
    createElement(AppProvider, null, createElement(StoreProbe, { onStore: (s) => (store = s) })),
  );
  const s = store as unknown as AppStore;
  for (const a of seed) s.dispatch(a);
  result.rerender(
    createElement(
      AppProvider,
      null,
      createElement(StoreProbe, { onStore: (x) => (store = x) }),
      ui,
    ),
  );
  return Object.assign(result, { store: s });
}

/** A ref whose `current` is always the store's live state, like the app
 *  shell's `stateRef`. */
export function liveStateRef(store: AppStore): { current: AppState } {
  return {
    get current() {
      return store.getState();
    },
    set current(_v: AppState) {
      /* the store owns the state */
    },
  };
}

/** renderHook under AppProvider; `hook` receives the store. */
export function renderHookWithAppStore<R>(
  hook: (store: AppStore) => R,
  seed: readonly AppAction[] = [],
): { result: { readonly current: R }; store: AppStore; rerender: () => void; unmount: () => void } {
  let seeded = false;
  const wrapper = ({ children }: { children: ReactNode }): ReactElement =>
    createElement(AppProvider, null, children);
  const r = renderHook(
    () => {
      const store = useAppStore();
      if (!seeded) {
        seeded = true;
        for (const a of seed) store.dispatch(a);
      }
      return { store, value: hook(store) };
    },
    { wrapper },
  );
  // `result.current` stays live even after the object is spread / destructured.
  const result = {
    get current(): R {
      return r.result.current.value;
    },
  };
  return {
    result,
    store: r.result.current.store,
    rerender: () => r.rerender(),
    unmount: () => r.unmount(),
  };
}

// ─── Layer fixtures ─────────────────────────────────────────────────────────

export const pixel = (id: string, extra: Partial<PixelLayerState> = {}): PixelLayerState => ({
  id,
  name: id,
  visible: true,
  opacity: 1,
  locked: false,
  blendMode: "normal",
  ...extra,
});

export const mask = (id: string, parentId: string): MaskLayerState => ({
  id,
  name: "Layer Mask",
  visible: true,
  type: "mask",
  parentId,
});

export const group = (id: string, childIds: string[], extra: Partial<GroupLayerState> = {}): GroupLayerState => ({
  id,
  name: id,
  visible: true,
  opacity: 1,
  locked: false,
  blendMode: "pass-through",
  type: "group",
  collapsed: false,
  childIds,
  ...extra,
});

/** Seed actions that replace the layer stack (bottom → top). */
export function seedLayers(layers: LayerState[], activeLayerId: string | null = null): AppAction[] {
  return [{ type: "RESTORE_LAYERS", payload: { layers, activeLayerId } } as AppAction];
}

export const ids = (layers: readonly LayerState[]): string[] => layers.map((l) => l.id);
