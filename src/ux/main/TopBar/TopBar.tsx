import React, { useEffect, useMemo, useState } from "react";
import { lutStore, type LutTransform } from "@/core/lut";
import { displayStore } from "@/ux/main/Canvas/displayStore";
import { MenuBar } from "../MenuBar/MenuBar";
import {
  buildMenuTree,
  filterForTarget,
  type MenuDeps,
} from "../menu/menuTree";
import { dockStore } from "@/ux/main/RightPanel/Dock/dockStore";
import { ALL_PANEL_IDS, type PanelId } from "@/ux/main/RightPanel/Dock/types";
import styles from "./TopBar.module.scss";

interface TopBarProps {
  /** Canonical menu inputs. Built once in `App.tsx` via `buildMenuDeps`
   *  and reused on both this in-app menu AND the macOS native menu, so
   *  the two consumers can't drift in handler wiring. */
  deps: MenuDeps;
  isMac?: boolean;
  /** Top-right dev-only debug button. */
  onDebug?: () => void;
  /** Drives the centered TILED badge — not menu-related. */
  tiledMode?: boolean;
}

export function TopBar({
  deps,
  isMac,
  onDebug,
  tiledMode,
}: TopBarProps): React.JSX.Element {
  // Live LUT list + active view-transform — both update outside React
  // (lutStore + displayStore are module singletons). Subscribed locally
  // and merged into the deps before passing to `buildMenuTree`, so the
  // tree rebuilds when either changes. (The macOS bridge has its own
  // identical subscription; the two stay in lock-step because every
  // change broadcasts on the module-level listener list.)
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
  // Same story for the dock layout — drives the View → <panel> checkboxes.
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

  const menus = useMemo(
    () =>
      filterForTarget(
        buildMenuTree({
          ...deps,
          luts,
          activeViewLut,
          openPanelIds,
          hasDisplayProfile,
          hasProofProfile,
          proofColorsActive,
          gamutWarningActive,
          isProd: import.meta.env.PROD,
        }),
        "app",
      ),
    [
      deps,
      luts,
      activeViewLut,
      openPanelIds,
      hasDisplayProfile,
      hasProofProfile,
      proofColorsActive,
      gamutWarningActive,
    ],
  );

  // On macOS the native application menu replaces the entire custom top bar.
  if (isMac) return <></>;

  return (
    <div className={styles.topBar}>
      {/* Left: Logo + menus */}
      <div className={styles.left}>
        <button
          className={styles.logoBtn}
          aria-label="Verve home"
          title="Verve"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16">
            <rect x="1" y="1" width="6" height="6" rx="1" />
            <rect x="9" y="1" width="6" height="6" rx="1" />
            <rect x="1" y="9" width="6" height="6" rx="1" />
            <rect x="9" y="9" width="6" height="6" rx="1" />
          </svg>
        </button>

        <div className={styles.menuDivider} />

        <MenuBar menus={menus} />
      </div>

      {tiledMode && (
        <div className={styles.center}>
          <span className={styles.tiledBadge}>TILED</span>
        </div>
      )}

      {/* Right: debug button — development only. */}
      {!import.meta.env.PROD && (
        <div className={styles.right}>
          <button
            className={styles.debugBtn}
            onClick={onDebug}
            title="Open DevTools"
            aria-label="Open DevTools"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              width="14"
              height="14"
            >
              <polyline points="4,6 1,8 4,10" />
              <polyline points="12,6 15,8 12,10" />
              <line x1="9" y1="3" x2="7" y2="13" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
