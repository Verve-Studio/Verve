/**
 * macOS native menu bridge.
 *
 * Receives the same `MenuDeps` blob the in-app menu uses, so both
 * consumers are guaranteed to invoke the same handlers — no chance for
 * `onSetColorMode` here to behave differently from `onSetColorMode`
 * there. The hook:
 *
 *   1. Subscribes locally to the outside-React stores (`lutStore`,
 *      `displayStore`, `dockStore`) that feed the dynamic menu bits
 *      (LUT list, active view transform, panel checkbox states).
 *   2. Calls `buildMenuTree(deps + those subscriptions)`, filters to
 *      mac-only nodes, and walks the result to build the action-id
 *      → action map.
 *   3. Sends a function-free copy of the tree to the main process
 *      (one `menu:rebuild` IPC channel) on every state change.
 *   4. Dispatches IPC menu-action events by looking up `actionId` in
 *      the map.
 *
 * No giant action-id switch, no parallel template in the main process,
 * no per-flag enable/check/visible IPCs.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildMenuTree,
  collectActions,
  filterForTarget,
  serializeTree,
  type MenuDeps,
} from "@/ux/main/menu/menuTree";
import { lutStore, type LutTransform } from "@/core/lut";
import { displayStore } from "@/ux/main/Canvas/displayStore";
import { dockStore } from "@/ux/main/RightPanel/Dock/dockStore";
import { ALL_PANEL_IDS, type PanelId } from "@/ux/main/RightPanel/Dock/types";

export interface MacNativeMenuParams {
  isMac: boolean;
  /** The unified MenuDeps built in `App.tsx`. The same object is also
   *  passed to `<TopBar deps={…} />` for the in-app menu — both menus
   *  share one set of handlers. */
  deps: MenuDeps;
}

export function useMacNativeMenu({ isMac, deps }: MacNativeMenuParams): void {
  // Outside-React subscriptions that the unified tree needs.
  const [luts, setLuts] = useState<LutTransform[]>(() => lutStore.all());
  useEffect(() => lutStore.subscribe(() => setLuts(lutStore.all())), []);
  const [activeViewLut, setActiveViewLut] = useState<string | null>(
    () => displayStore.viewTransformLutId,
  );
  const [hasDisplayProfile, setHasDisplayProfile] = useState<boolean>(
    () => displayStore.displayProfileLut !== null,
  );
  const [hasProofProfile, setHasProofProfile] = useState<boolean>(
    () => displayStore.proofProfile !== null,
  );
  const [proofColorsActive, setProofColorsActive] = useState<boolean>(
    () => displayStore.proofEnabled,
  );
  const [gamutWarningActive, setGamutWarningActive] = useState<boolean>(
    () => displayStore.gamutWarningEnabled,
  );
  useEffect(() => {
    const fn = (): void => {
      setActiveViewLut(displayStore.viewTransformLutId);
      setHasDisplayProfile(displayStore.displayProfileLut !== null);
      setHasProofProfile(displayStore.proofProfile !== null);
      setProofColorsActive(displayStore.proofEnabled);
      setGamutWarningActive(displayStore.gamutWarningEnabled);
    };
    displayStore.subscribe(fn);
    return () => displayStore.unsubscribe(fn);
  }, []);
  const [openPanelIds, setOpenPanelIds] = useState<ReadonlyArray<PanelId>>(
    () => dockStore.openPanelIds,
  );
  useEffect(() => {
    const sync = (): void =>
      setOpenPanelIds(
        [...dockStore.openPanelIds].filter((id): id is PanelId =>
          ALL_PANEL_IDS.includes(id),
        ),
      );
    sync();
    return dockStore.subscribe(sync);
  }, []);

  const tree = useMemo(() => {
    const t = buildMenuTree({
      ...deps,
      luts,
      activeViewLut,
      openPanelIds,
      hasDisplayProfile,
      hasProofProfile,
      proofColorsActive,
      gamutWarningActive,
      isProd: import.meta.env.PROD,
    });
    return filterForTarget(t, "mac");
  }, [
    deps,
    luts,
    activeViewLut,
    openPanelIds,
    hasDisplayProfile,
    hasProofProfile,
    proofColorsActive,
    gamutWarningActive,
  ]);

  // Build the actionId → action map used by the IPC dispatcher.
  // Refreshed alongside the tree so handler identity stays in sync.
  const actionsRef = useRef<Map<string, () => void>>(new Map());
  useEffect(() => {
    actionsRef.current = collectActions(tree);
  }, [tree]);

  // Ship the serialized (function-free) tree to the main process.
  useEffect(() => {
    if (!isMac) return;
    window.api.rebuildNativeMenu(serializeTree(tree));
  }, [isMac, tree]);

  // Register the IPC menu-action listener once. Lookup is always
  // against the freshest action map via the ref.
  useEffect(() => {
    if (!isMac) return;
    const cleanup = window.api.onMenuAction((actionId) => {
      const fn = actionsRef.current.get(actionId);
      if (fn) fn();
    });
    return cleanup;
  }, [isMac]);
}
