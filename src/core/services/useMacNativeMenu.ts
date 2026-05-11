/**
 * macOS native menu bridge.
 *
 * Builds the unified menu tree from `src/ux/main/menu/menuTree.ts`,
 * filters out in-app-only nodes, serializes a function-free copy to
 * the main process (which installs it via Electron's
 * `Menu.setApplicationMenu`), and dispatches IPC menu-action events
 * back to renderer-side handlers via an `actionId → action` map
 * extracted from the same tree.
 *
 * One tree → two consumers. No more giant action-id switch and no
 * more separate enable/check/visible IPC channels — every state
 * change just rebuilds and re-sends the tree (~1 ms round-trip).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { FilterKey, PixelFormat } from "@/types";
import type { EffectType } from "@/core/effects/effectTypes";
import type { GuidePreset } from "./useViewActions";
import type {
  AlignEdge,
  DistributeAxis,
  OrderOp,
} from "./useLayerArrange";
import type { RotateAmount, FlipAxis } from "./useCanvasTransforms";
import type { UseLayerArrangeReturn } from "./useLayerArrange";
import {
  buildMenuTree,
  collectActions,
  filterForTarget,
  serializeTree,
} from "@/ux/main/menu/menuTree";
import {
  ADJUSTMENT_MENU_ITEMS,
  EFFECTS_MENU_ITEMS,
  FILTER_MENU_ITEMS,
} from "@/core/menuConstants";
import { lutStore, type LutTransform } from "@/core/lut";
import { displayStore } from "@/ux/main/Canvas/displayStore";
import { dockStore } from "@/ux/main/RightPanel/Dock/dockStore";
import { ALL_PANEL_IDS, type PanelId } from "@/ux/main/RightPanel/Dock/types";
import { activeScope } from "@/core/store/scope";

// ─── Params ───────────────────────────────────────────────────────────────────

export interface MacNativeMenuParams {
  isMac: boolean;
  recentFiles: string[];

  // Transform guard — wraps actions that need a transform-decision before firing.
  requireTransformDecision: (action: () => void) => void;

  // Adjustment / effect / filter actions
  adjustments: {
    handleCreateAdjustmentLayer: (
      type: EffectType,
      params?: Record<string, unknown>,
    ) => void;
    isAdjustmentMenuEnabled: boolean;
  };
  filters: {
    handleInstantFilter: (key: FilterKey) => void;
  };
  handleOpenFilterDialog: (key: FilterKey) => void;

  // File
  handleOpen: () => Promise<void>;
  handleOpenPath: (path: string) => Promise<void>;
  handleClose: () => void;
  handleCloseAll: () => void;
  handleSave: (saveAs: boolean) => Promise<void>;
  handleSaveACopy: () => Promise<void>;
  handleClearRecentFiles: () => Promise<void>;

  // Edit
  handleUndo: () => void;
  handleRedo: () => void;
  handleCut: () => void;
  handleCopy: () => void;
  handleCopyMerged: () => void;
  handlePaste: () => void;
  handlePasteInto: () => void;
  handleDelete: () => void;

  // Content-aware
  handleOpenCafDialog: (mode: "fill" | "delete") => void;

  // Layer
  handleNewLayer: () => void;
  handleDuplicateLayer: () => void;
  handleDeleteActiveLayer: () => void;
  handleRasterizeLayer: (id: string) => void;
  handleGroupLayers: (ids: string[]) => void;
  handleUngroupLayers: (id: string) => void;
  handleCreateCompositeLayer: () => void;
  handleAddMaskLayer: () => void;
  handleMergeSelected: (ids: string[]) => void;
  handleMergeDown: () => void;
  handleMergeVisible: () => void;
  handleFlattenImage: () => void;

  // Canvas transforms
  handleEnterTransform: () => void;

  // View
  handleZoomIn: () => void;
  handleZoomOut: () => void;
  handleZoom100: () => void;
  handleFitToWindow: () => void;
  handleToggleGrid: () => void;
  handleToggleRulers: () => void;
  handleToggleGuides: () => void;
  handleApplyGuidePreset: (preset: GuidePreset) => void;
  handleSetNormalMode: () => void;
  handleSetTiledMode: () => void;
  handleToggleTileGrid: () => void;
  handleSetAnimationMode: (enabled: boolean) => void;
  handleSelectAll: () => void;
  handleDeselect: () => void;
  handleSelectAllLayers: () => void;
  handleDeselectLayers: () => void;
  handleFindLayers: () => void;

  // Color mode
  colorMode: { handleConvertColorMode: (fmt: PixelFormat) => void };

  // Dialogs
  openNewImageDialog: () => void;
  openExportDialog: () => void;
  openResizeImageDialog: () => void;
  openResizeCanvasDialog: () => void;
  handleRotate: (amount: RotateAmount) => Promise<void>;
  handleFlip: (axis: FlipAxis) => Promise<void>;
  handleRotateSelectedLayers: (amount: RotateAmount) => Promise<void>;
  handleFlipSelectedLayers: (axis: FlipAxis) => Promise<void>;
  layerArrange: UseLayerArrangeReturn;
  openAboutDialog: () => void;
  openShortcutsDialog: () => void;
  openSystemInfoDialog: () => void;
  openColorDitheringSetup: () => void;
  openPreferencesDialog: () => void;
  openLutManagerDialog: () => void;
  loadCubeLut: () => Promise<void>;
  setViewTransform: (id: string | null) => void;

  // State
  activeLayerId: string | null;
  effectiveSelectedIds: Set<string>;
  isFreeTransformEnabled: boolean;
  isRasterizeLayerEnabled: boolean;
  isMergeSelectedEnabled: boolean;
  hasSelection: boolean;
  isContentAwareFilling: boolean;
  pixelFormat: PixelFormat;
  showGrid: boolean;
  showRulers: boolean;
  showGuides: boolean;
  tiledMode: boolean;
  showTileGrid: boolean;
  animationMode: boolean;
  paletteAnimationActive: boolean;

  // Animation playback
  onPlayPause: () => void;
  onPrevFrame: () => void;
  onNextFrame: () => void;
  onPrevAnimation: () => void;
  onNextAnimation: () => void;
  openImportSpritesheetFramesDialog: () => void;
  handleExportSpritesheetJson: () => void;
  handleExportPaletteAnimationJson: () => void;
  openExportAnimationFramesDialog: () => void;

}

export function useMacNativeMenu(params: MacNativeMenuParams): void {
  const { isMac } = params;

  // Subscribe to outside-React stores so the menu rebuilds when LUTs,
  // the active view transform, or the dock layout change.
  const [luts, setLuts] = useState<LutTransform[]>(() => lutStore.all());
  useEffect(() => lutStore.subscribe(() => setLuts(lutStore.all())), []);
  const [activeViewLut, setActiveViewLut] = useState<string | null>(
    () => displayStore.viewTransformLutId,
  );
  useEffect(() => {
    const fn = (): void =>
      setActiveViewLut(displayStore.viewTransformLutId);
    displayStore.subscribe(fn);
    return () => displayStore.unsubscribe(fn);
  }, []);
  const [openPanelIds, setOpenPanelIds] = useState<ReadonlyArray<PanelId>>(
    () => dockStore.openPanelIds,
  );
  useEffect(() => {
    const sync = (): void => setOpenPanelIds([...dockStore.openPanelIds]);
    sync();
    return dockStore.subscribe(sync);
  }, []);

  // Build the unified tree from a single deps blob. Memoized on every
  // input — same approach as TopBar's in-app menu — so we only re-run
  // build/serialize/IPC when something actually changed.
  const tree = useMemo(() => {
    const t = buildMenuTree({
      // File
      onNew: params.openNewImageDialog,
      onOpen: () => void params.handleOpen(),
      onSave: () => void params.handleSave(false),
      onSaveAs: () => void params.handleSave(true),
      onSaveACopy: () => void params.handleSaveACopy(),
      onExport: params.openExportDialog,
      onClose: params.handleClose,
      onCloseAll: params.handleCloseAll,
      recentFiles: params.recentFiles,
      onOpenRecent: (p) => void params.handleOpenPath(p),
      onClearRecentFiles: () => void params.handleClearRecentFiles(),
      onPreferences: params.openPreferencesDialog,
      // Exit lives in the macOS app menu via `role: "quit"`; the regular
      // Exit entry in the File submenu is `targets: "app"` so it doesn't
      // appear in the native menu. No-op here.

      // Edit
      onUndo: params.handleUndo,
      onRedo: params.handleRedo,
      onCut: params.handleCut,
      onCopy: params.handleCopy,
      onCopyMerged: params.handleCopyMerged,
      onPaste: params.handlePaste,
      onPasteInto: params.handlePasteInto,
      onDelete: params.handleDelete,
      onContentAwareFill: () => params.handleOpenCafDialog("fill"),
      onContentAwareDelete: () => params.handleOpenCafDialog("delete"),
      onFreeTransform: () =>
        params.requireTransformDecision(params.handleEnterTransform),
      isFreeTransformEnabled: params.isFreeTransformEnabled,

      // Select
      onSelectAll: params.handleSelectAll,
      onDeselect: params.handleDeselect,
      onSelectAllLayers: params.handleSelectAllLayers,
      onDeselectLayers: params.handleDeselectLayers,
      onFindLayers: params.handleFindLayers,
      onInvertSelection: () => activeScope().selection.invert(),

      // Layer
      onNewLayer: params.handleNewLayer,
      onNewLayerGroup: () => params.handleGroupLayers([]),
      onNewCompositeLayer: params.handleCreateCompositeLayer,
      onAddLayerMask: params.handleAddMaskLayer,
      onDuplicateLayer: params.handleDuplicateLayer,
      onDeleteLayer: params.handleDeleteActiveLayer,
      onRasterizeLayer: () => {
        if (params.activeLayerId) params.handleRasterizeLayer(params.activeLayerId);
      },
      isRasterizeEnabled: params.isRasterizeLayerEnabled,
      onGroupLayers: () =>
        params.handleGroupLayers([...params.effectiveSelectedIds]),
      // Mac side has no explicit isGroupLayers / isUngroupLayers — it
      // relies on the same fallback `disabled: !on...` semantics the
      // shared builder uses.
      onUngroupLayers: () => {
        if (params.activeLayerId)
          params.handleUngroupLayers(params.activeLayerId);
      },
      onMergeSelected: () =>
        params.handleMergeSelected([...params.effectiveSelectedIds]),
      isMergeSelectedEnabled: params.isMergeSelectedEnabled,
      onMergeDown: params.handleMergeDown,
      onMergeVisible: params.handleMergeVisible,
      onFlattenImage: params.handleFlattenImage,
      onLayerRotate: (amount) =>
        void params.handleRotateSelectedLayers(
          amount === "90cw" ? "90cw" : amount === "180" ? "180" : "270cw",
        ),
      onLayerFlip: (axis) =>
        void params.handleFlipSelectedLayers(
          axis === "horizontal" ? "horizontal" : "vertical",
        ),
      onLayerAlign: (edge: AlignEdge) => params.layerArrange.handleAlign(edge),
      onLayerDistribute: (axis: DistributeAxis) =>
        params.layerArrange.handleDistribute(axis),
      onLayerOrder: (op: OrderOp) => params.layerArrange.handleOrder(op),

      // Image
      pixelFormat: params.pixelFormat,
      onSetColorMode: (fmt) => {
        if (fmt === "indexed8") {
          params.requireTransformDecision(() =>
            params.openColorDitheringSetup(),
          );
        } else {
          params.colorMode.handleConvertColorMode(fmt);
        }
      },
      onResizeImage: params.openResizeImageDialog,
      onResizeCanvas: params.openResizeCanvasDialog,
      onRotate90CW: () => void params.handleRotate("90cw"),
      onRotate180: () => void params.handleRotate("180"),
      onRotate270CW: () => void params.handleRotate("270cw"),
      onFlipHorizontal: () => void params.handleFlip("horizontal"),
      onFlipVertical: () => void params.handleFlip("vertical"),
      onLoadLut: () => void params.loadCubeLut(),
      onManageLuts: params.openLutManagerDialog,
      onSetViewTransform: params.setViewTransform,
      luts,
      activeViewLut,

      // Adjustments / Effects / Filters
      onCreateAdjustmentLayer: (type) => {
        if (type === "color-dithering") {
          params.requireTransformDecision(() =>
            params.openColorDitheringSetup(),
          );
        } else {
          params.requireTransformDecision(() =>
            params.adjustments.handleCreateAdjustmentLayer(type),
          );
        }
      },
      isAdjustmentMenuEnabled: params.adjustments.isAdjustmentMenuEnabled,
      adjustmentMenuItems: ADJUSTMENT_MENU_ITEMS.map((i) => ({
        type: i.type,
        label: i.label,
        group: i.group,
      })),
      effectsMenuItems: EFFECTS_MENU_ITEMS.map((i) => ({
        type: i.type,
        label: i.label,
        group: i.group,
      })),
      onOpenFilterDialog: params.handleOpenFilterDialog,
      onInstantFilter: (key) => {
        params.requireTransformDecision(() =>
          params.filters.handleInstantFilter(key),
        );
      },
      isFiltersMenuEnabled: params.adjustments.isAdjustmentMenuEnabled,
      filterMenuItems: FILTER_MENU_ITEMS.map((i) => ({
        key: i.key,
        label: i.label,
        instant: i.instant,
        group: i.group,
      })),

      // Animation
      animationMode: params.animationMode,
      isPlaying: false, // macOS menu didn't expose a play/pause label toggle previously; keep label stable
      paletteAnimationActive: params.paletteAnimationActive,
      onPlayPause: params.onPlayPause,
      onPrevFrame: params.onPrevFrame,
      onNextFrame: params.onNextFrame,
      onPrevAnimation: params.onPrevAnimation,
      onNextAnimation: params.onNextAnimation,
      onImportSpritesheetFrames: params.openImportSpritesheetFramesDialog,
      onExportSpritesheetJson: params.handleExportSpritesheetJson,
      onExportPaletteAnimationJson: params.handleExportPaletteAnimationJson,
      onExportAnimationFrames: params.openExportAnimationFramesDialog,

      // View
      onZoomIn: params.handleZoomIn,
      onZoomOut: params.handleZoomOut,
      onZoom100: params.handleZoom100,
      onFitToWindow: params.handleFitToWindow,
      onToggleGrid: params.handleToggleGrid,
      showGrid: params.showGrid,
      onToggleRulers: params.handleToggleRulers,
      showRulers: params.showRulers,
      onToggleGuides: params.handleToggleGuides,
      showGuides: params.showGuides,
      onApplyGuidePreset: params.handleApplyGuidePreset,
      onSetNormalMode: params.handleSetNormalMode,
      onSetTiledMode: params.handleSetTiledMode,
      tiledMode: params.tiledMode,
      onToggleTileGrid: params.handleToggleTileGrid,
      showTileGrid: params.showTileGrid,
      onSetAnimationMode: params.handleSetAnimationMode,
      openPanelIds: openPanelIds.filter((id): id is PanelId =>
        ALL_PANEL_IDS.includes(id),
      ),

      // Help
      onAbout: params.openAboutDialog,
      onKeyboardShortcuts: params.openShortcutsDialog,
      onSystemInfo: params.openSystemInfoDialog,
      onDebug: () => window.api.openDevTools(),
      isProd: import.meta.env.PROD,
    });
    return filterForTarget(t, "mac");
  }, [
    params,
    luts,
    activeViewLut,
    openPanelIds,
  ]);

  // Build the actionId → action map used by the IPC dispatcher.
  // Refreshed alongside the tree so handler identity stays in sync.
  const actionsRef = useRef<Map<string, () => void>>(new Map());
  useEffect(() => {
    actionsRef.current = collectActions(tree);
  }, [tree]);

  // Send the serialized (function-free) tree to the main process.
  // One IPC channel replaces the previous build/set-enabled/set-checked
  // /set-visible quartet — see `electron/main/menu.ts`.
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
