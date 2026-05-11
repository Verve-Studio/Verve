import React, { useEffect, useMemo, useState } from "react";
import { lutStore, type LutTransform } from "@/core/lut";
import { displayStore } from "@/ux/main/Canvas/displayStore";
import { MenuBar } from "../MenuBar/MenuBar";
import { buildMenuTree, filterForTarget, type MenuDeps } from "../menu/menuTree";
import type { FilterKey, PixelFormat } from "@/types";
import type { EffectType } from "@/core/effects/effectTypes";
import type { GuidePreset } from "@/core/services/useViewActions";
import type {
  AlignEdge,
  DistributeAxis,
  OrderOp,
} from "@/core/services/useLayerArrange";
import { useDockLayout } from "@/ux/main/RightPanel/Dock/useDockLayout";
import { ALL_PANEL_IDS } from "@/ux/main/RightPanel/Dock/types";
import styles from "./TopBar.module.scss";

// ─── TopBar ───────────────────────────────────────────────────────────────────

interface TopBarProps {
  onDebug?: () => void;
  onNew?: () => void;
  onOpen?: () => void;
  onSave?: () => void;
  onSaveAs?: () => void;
  onExport?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onCut?: () => void;
  onCopy?: () => void;
  onCopyMerged?: () => void;
  onPaste?: () => void;
  onPasteInto?: () => void;
  onDelete?: () => void;
  onResizeImage?: () => void;
  onResizeCanvas?: () => void;
  onLoadLut?: () => void;
  onManageLuts?: () => void;
  onSetViewTransform?: (id: string | null) => void;
  onRotate90CW?: () => void;
  onRotate180?: () => void;
  onRotate270CW?: () => void;
  onFlipHorizontal?: () => void;
  onFlipVertical?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoom100?: () => void;
  onFitToWindow?: () => void;
  onToggleGrid?: () => void;
  showGrid?: boolean;
  onToggleRulers?: () => void;
  showRulers?: boolean;
  onToggleGuides?: () => void;
  showGuides?: boolean;
  onApplyGuidePreset?: (preset: GuidePreset) => void;
  onSetNormalMode?: () => void;
  onSetTiledMode?: () => void;
  tiledMode?: boolean;
  onToggleTileGrid?: () => void;
  showTileGrid?: boolean;
  onSetAnimationMode?: (enabled: boolean) => void;
  animationMode?: boolean;
  isPlaying?: boolean;
  onPlayPause?: () => void;
  onPrevFrame?: () => void;
  onNextFrame?: () => void;
  onPrevAnimation?: () => void;
  onNextAnimation?: () => void;
  paletteAnimationActive?: boolean;
  onImportSpritesheetFrames?: () => void;
  onExportSpritesheetJson?: () => void;
  onExportPaletteAnimationJson?: () => void;
  onExportAnimationFrames?: () => void;
  onNewLayer?: () => void;
  onNewLayerGroup?: () => void;
  onNewCompositeLayer?: () => void;
  onAddLayerMask?: () => void;
  onDuplicateLayer?: () => void;
  onDeleteLayer?: () => void;
  onGroupLayers?: () => void;
  isGroupLayersEnabled?: boolean;
  onUngroupLayers?: () => void;
  isUngroupLayersEnabled?: boolean;
  onMergeDown?: () => void;
  onMergeVisible?: () => void;
  onFlattenImage?: () => void;
  onRasterizeLayer?: () => void;
  isRasterizeEnabled?: boolean;
  onMergeSelected?: () => void;
  isMergeSelectedEnabled?: boolean;
  onLayerRotate?: (amount: "90cw" | "180" | "270cw") => void;
  onLayerFlip?: (axis: "horizontal" | "vertical") => void;
  onLayerAlign?: (edge: AlignEdge) => void;
  onLayerDistribute?: (axis: DistributeAxis) => void;
  onLayerOrder?: (op: OrderOp) => void;
  onAbout?: () => void;
  onKeyboardShortcuts?: () => void;
  onSystemInfo?: () => void;
  onCreateAdjustmentLayer?: (type: EffectType) => void;
  isAdjustmentMenuEnabled?: boolean;
  adjustmentMenuItems?: Array<{
    type: EffectType;
    label: string;
    group?: string;
  }>;
  effectsMenuItems?: Array<{
    type: EffectType;
    label: string;
    group?: string;
  }>;
  onOpenFilterDialog?: (key: FilterKey) => void;
  onInstantFilter?: (key: FilterKey) => void;
  isFiltersMenuEnabled?: boolean;
  filterMenuItems?: Array<{
    key: FilterKey;
    label: string;
    instant?: boolean;
    group?: string;
  }>;
  onContentAwareFill?: () => void;
  onContentAwareDelete?: () => void;
  onFreeTransform?: () => void;
  isFreeTransformEnabled?: boolean;
  onInvertSelection?: () => void;
  onSelectAll?: () => void;
  onDeselect?: () => void;
  onSelectAllLayers?: () => void;
  onDeselectLayers?: () => void;
  onFindLayers?: () => void;
  onClose?: () => void;
  onCloseAll?: () => void;
  onSaveACopy?: () => void;
  recentFiles?: string[];
  onOpenRecent?: (path: string) => void;
  onClearRecentFiles?: () => void;
  onExit?: () => void;
  onPreferences?: () => void;
  /** Current document pixel format — drives the Image → Color Mode checked states. */
  pixelFormat?: PixelFormat;
  /** Called when the user picks a color mode from Image → Color Mode. */
  onSetColorMode?: (format: PixelFormat) => void;
  /** When true, hides the custom menu bar (logo + menu) — used on macOS where the native app menu is shown instead. */
  isMac?: boolean;
}

export function TopBar(props: TopBarProps): React.JSX.Element {
  const { tiledMode, isMac, onDebug } = props;
  const dockLayout = useDockLayout();
  // Live LUT list + active view-transform — both update outside React
  // (lutStore + displayStore are module singletons), so subscribe and
  // mirror into local state to drive menu rebuilds.
  const [luts, setLuts] = useState<LutTransform[]>(() => lutStore.all());
  useEffect(() => lutStore.subscribe(() => setLuts(lutStore.all())), []);
  const [activeViewLut, setActiveViewLut] = useState<string | null>(
    () => displayStore.viewTransformLutId,
  );
  useEffect(() => {
    const fn = (): void => setActiveViewLut(displayStore.viewTransformLutId);
    displayStore.subscribe(fn);
    return () => displayStore.unsubscribe(fn);
  }, []);

  // Build the unified menu tree and filter to the in-app consumer. The
  // exact same tree (with macOS-only nodes filtered the other way) is
  // serialized to the main process by `useMacNativeMenu` on macOS —
  // there's a single source of truth in `menuTree.ts`.
  const menus = useMemo(() => {
    const openPanelIds = [
      ...new Set([
        ...dockLayout.rows.flatMap((r) => r.panels),
        ...dockLayout.floatingWindows.map((w) => w.panelId),
      ]),
    ].filter((id): id is (typeof ALL_PANEL_IDS)[number] =>
      ALL_PANEL_IDS.includes(id as never),
    );
    const deps: MenuDeps = {
      ...(props as MenuDeps),
      luts,
      activeViewLut,
      openPanelIds,
      isProd: import.meta.env.PROD,
    };
    return filterForTarget(buildMenuTree(deps), "app");
  }, [props, dockLayout, luts, activeViewLut]);

  // On macOS the native application menu replaces the entire custom top bar.
  if (isMac) return <></>;

  return (
    <div className={styles.topBar}>
      {/* Left: Logo + menus */}
      <div className={styles.left}>
        {/* PS-style home/logo icon */}
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
