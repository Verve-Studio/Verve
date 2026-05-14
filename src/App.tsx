import { useAdjustments } from "@/core/services/useAdjustments";
import { useAnimationPlayback } from "@/core/services/useAnimationPlayback";
import {
  useBrushBootstrap,
  useCloneStampNotification,
  useMemoryErrorHandler,
  useRecentFiles,
  useStartupFile,
} from "@/core/services/useAppLifecycle";
import { useCanvasTransforms } from "@/core/services/useCanvasTransforms";
import { useClipboard } from "@/core/services/useClipboard";
import { useColorMode } from "@/core/services/useColorMode";
import { useColorProfile } from "@/core/services/useColorProfile";
import { useContentAwareFill } from "@/core/services/useContentAwareFill";
import { useDialogState } from "@/core/services/useDialogState";
import { useExportOps } from "@/core/services/useExportOps";
import { useFileOps } from "@/core/services/useFileOps";
import { useFilters } from "@/core/services/useFilters";
import { useFormatRemount } from "@/core/services/useFormatRemount";
import { useHistory } from "@/core/services/useHistory";
import { useKeyboardShortcuts } from "@/core/services/useKeyboardShortcuts";
import { useLayerArrange } from "@/core/services/useLayerArrange";
import { useLayerGroups } from "@/core/services/useLayerGroups";
import { useLayers } from "@/core/services/useLayers";
import { useMacNativeMenu } from "@/core/services/useMacNativeMenu";
import { useLutOps } from "@/core/services/useLutOps";
import { useAutoMask } from "@/core/services/useAutoMask";
import { useObjectRemoval } from "@/core/services/useObjectRemoval";
import { usePolygonalSelection } from "@/core/services/usePolygonalSelection";
import { useSpritesheetAnimationOps } from "@/core/services/useSpritesheetAnimationOps";
import { useTabs } from "@/core/services/useTabs";
import { useTransform } from "@/core/services/useTransform";
import { useTransformGuard } from "@/core/services/useTransformGuard";
import { useViewActions } from "@/core/services/useViewActions";
import { AppProvider, useAppContext } from "@/core/store/AppContext";
import { CanvasProvider } from "@/core/store/CanvasContext";

import { useNotification } from "@/core/store/notificationStore";
import { paletteCyclePeriod } from "@/core/store/paletteCycleStore";

import { viewportCommands } from "@/core/store/viewportCommands";
import { toolRegistry } from "@/core/tools/toolRegistry";
import { isGroupLayer } from "@/types";
import type { LayerState, Tool } from "@/types";
import { MainWindow } from "@/ux/main/MainWindow/MainWindow";
import type { TabInfo } from "@/ux/main/TabBar/TabBar";
import { SplashScreen } from "@/ux/modals/SplashScreen/SplashScreen";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MenuDeps } from "@/ux/main/menu/menuTree";
import {
  ADJUSTMENT_MENU_ITEMS,
  EFFECTS_MENU_ITEMS,
  FILTER_MENU_ITEMS,
} from "@/core/menuConstants";
import { activeScope } from "@/core/store/scope";

// ─── AppContent ───────────────────────────────────────────────────────────────

function AppContent(): React.JSX.Element {
  const { state, dispatch } = useAppContext();
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── Dialog state ──────────────────────────────────────────────────
  const {
    showNewImageDialog,
    setShowNewImageDialog,
    showExportDialog,
    setShowExportDialog,
    showResizeDialog,
    setShowResizeDialog,
    showResizeCanvasDialog,
    setShowResizeCanvasDialog,
    showRescaleDialog,
    setShowRescaleDialog,
    showRestoreDialog,
    setShowRestoreDialog,
    showLutManager,
    setShowLutManager,
    showColorSettings,
    setShowColorSettings,
    showProofSetup,
    setShowProofSetup,
    showProfileManager,
    setShowProfileManager,
    showAboutDialog,
    setShowAboutDialog,
    showShortcutsDialog,
    setShowShortcutsDialog,
    showSystemInfoDialog,
    setShowSystemInfoDialog,
    showGeneratePaletteDialog,
    setShowGeneratePaletteDialog,
    showColorDitheringSetup,
    setShowColorDitheringSetup,
    showContentAwareFillOptionsDialog,
    setShowContentAwareFillOptionsDialog,
    contentAwareFillOptionsMode,
    setContentAwareFillOptionsMode,
    pendingConversion,
    setPendingConversion,
    showImportSpritesheetFramesDialog,
    setShowImportSpritesheetFramesDialog,
    showExportAnimationFramesDialog,
    setShowExportAnimationFramesDialog,
  } = useDialogState();

  const [showPreferencesDialog, setShowPreferencesDialog] = useState(false);

  // ── Notification / progress state ────────────────────────────────
  const [isContentAwareFilling, setIsContentAwareFilling] = useState(false);
  const [contentAwareFillError, setContentAwareFillError] = useState<
    string | null
  >(null);
  const [contentAwareFillLabel, setContentAwareFillLabel] =
    useState("Filling…");

  // ── Mount-only lifecycle effects ──────────────────────────────────
  useBrushBootstrap(state.activeBrushId, dispatch);
  const cloneStampNotification = useCloneStampNotification();
  useMemoryErrorHandler();
  const memoryNotification = useNotification();
  const { recentFiles, setRecentFiles, clearRecentFiles } = useRecentFiles();

  // Cleanup timer for content-aware fill error toasts.
  const contentAwareFillErrorTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  useEffect(() => {
    return () => {
      if (contentAwareFillErrorTimerRef.current !== null)
        clearTimeout(contentAwareFillErrorTimerRef.current);
    };
  }, []);

  // ── Tab management ────────────────────────────────────────────────
  const {
    tabs,
    setTabs,
    activeTabId,
    setActiveTabId,
    activeTabIdRef,
    setTabsRef,
    canvasHandleRef,
    pendingLayerData,
    setPendingLayerData,
    tabCanvasRef,
    captureActiveSnapshot,
    serializeActiveTabPixels,
    handleSwitchTab,
    handleCloseTab,
  } = useTabs(state, dispatch);

  // ── History ───────────────────────────────────────────────────────
  const { captureHistory, pendingLayerLabelRef, suppressReadyCaptureRef } =
    useHistory({
      canvasHandleRef,
      stateRef,
      dispatch,
      activeTabIdRef,
      setTabsRef,
      setPendingLayerData,
      layers: state.layers,
    });

  // ── File operations ───────────────────────────────────────────────
  const {
    handleNewConfirm,
    handleOpen,
    handleOpenPath,
    handleSave,
    handleSaveACopy,
  } = useFileOps({
    canvasHandleRef,
    state,
    tabs,
    activeTabId,
    setTabs,
    setActiveTabId,
    setPendingLayerData,
    captureActiveSnapshot,
    serializeActiveTabPixels,
    handleSwitchTab: useCallback(
      (toId: string) => {
        suppressReadyCaptureRef.current = true;
        handleSwitchTab(toId);
      },
      [handleSwitchTab, suppressReadyCaptureRef],
    ),
    dispatch,
    onRecentFilesUpdated: setRecentFiles,
  });

  // ── Startup file (CLI arg or macOS open-with) ─────────────────────
  useStartupFile(handleOpenPath);

  // ── Export operations ────────────────────────────────────────────
  const {
    handleExportConfirm,
    pendingLdrExport,
    clearPendingLdrExport,
    confirmLdrExport,
  } = useExportOps({ canvasHandleRef, stateRef });

  // ── Clipboard ─────────────────────────────────────────────────────
  const {
    handleCopy,
    handleCopyMerged,
    handleCut,
    handlePaste,
    handlePasteInto,
    handleDelete,
  } = useClipboard({
    canvasHandleRef,
    state,
    dispatch,
    captureHistory,
    pendingLayerLabelRef,
  });

  // ── Layer operations ──────────────────────────────────────────────
  const {
    handleMergeSelected,
    handleMergeDown,
    handleMergeVisible,
    handleNewLayer,
    handleDuplicateLayer,
    handleDeleteActiveLayer,
    handleFlattenImage,
    handleRasterizeLayer,
    handleAddMaskLayer,
  } = useLayers({
    canvasHandleRef,
    stateRef,
    captureHistory,
    dispatch,
    pendingLayerLabelRef,
  });

  // ── Layer groups ──────────────────────────────────────────────────
  const {
    handleMergeGroup,
    handleGroupLayers,
    handleUngroupLayers,
    handleCreateCompositeLayer,
  } = useLayerGroups({ canvasHandleRef, stateRef, captureHistory, dispatch });

  // ── Canvas transforms ─────────────────────────────────────────────
  const [isRescaling, setIsRescaling] = useState(false);
  const [rescaleProgress, setRescaleProgress] = useState<
    import("@/core/services/useCanvasTransforms").RescaleProgress
  >({
    layerIdx: 0,
    layerCount: 0,
    tilesLoaded: 0,
    tilesTotal: 0,
    label: "Rescaling",
  });

  const {
    handleResizeImage,
    handleRescaleImage,
    handleRestoreImage,
    handleResizeCanvas,
    handleRotate,
    handleFlip,
    handleRotateSelectedLayers,
    handleFlipSelectedLayers,
  } = useCanvasTransforms({
    canvasHandleRef,
    stateRef,
    captureHistory,
    dispatch,
    activeTabId,
    setTabs,
    setPendingLayerData,
    pendingLayerLabelRef,
    canvasWidth: state.canvas.width,
    canvasHeight: state.canvas.height,
    setRescaling: setIsRescaling,
    setRescaleProgress,
  });

  // ── Layer arrange (align / distribute / order) ──────────────────────
  const layerArrange = useLayerArrange({
    canvasHandleRef,
    stateRef,
    captureHistory,
    dispatch,
  });

  // ── Adjustments ───────────────────────────────────────────────────
  const getSelectionPixels = useCallback((): Uint8Array | null => {
    const mask = activeScope().selection.mask;
    return mask ? mask.slice() : null;
  }, []);

  const registerAdjMask = useCallback(
    (layerId: string, pixels: Uint8Array): void => {
      canvasHandleRef.current?.registerAdjustmentSelectionMask(layerId, pixels);
    },
    [canvasHandleRef],
  );

  const adjustments = useAdjustments({
    stateRef,
    captureHistory,
    dispatch,
    layers: state.layers,
    activeLayerId: state.activeLayerId,
    getSelectionPixels,
    registerAdjMask,
  });

  // ── Transform guard ───────────────────────────────────────────────
  const {
    handleEnterTransform,
    handleApply: handleTransformApply,
    handleCancel: handleTransformCancel,
    isFreeTransformEnabled,
  } = useTransform({
    canvasHandleRef,
    stateRef,
    dispatch,
    captureHistory,
  });

  const {
    pendingGuardedAction,
    setPendingGuardedAction,
    requireTransformDecision,
    handleTransformGuardApply,
    handleTransformGuardDiscard,
  } = useTransformGuard({ handleTransformApply, handleTransformCancel });

  // ── Filters ───────────────────────────────────────────────────────
  const filters = useFilters({
    adjustments,
    primaryColor: state.primaryColor,
    secondaryColor: state.secondaryColor,
    requireTransformDecision,
  });
  const { handleOpenFilterDialog } = filters;

  // ── Content-Aware Fill / Delete ────────────────────────────────────
  const { runContentAwareFill, runContentAwareDelete } = useContentAwareFill({
    canvasHandleRef,
    stateRef,
    captureHistory,
    dispatch,
    pendingLayerLabelRef,
    setIsContentAwareFilling,
    setFillLabel: setContentAwareFillLabel,
    onError: (msg) => {
      setContentAwareFillError(msg);
      if (contentAwareFillErrorTimerRef.current !== null)
        clearTimeout(contentAwareFillErrorTimerRef.current);
      contentAwareFillErrorTimerRef.current = setTimeout(
        () => setContentAwareFillError(null),
        4000,
      );
    },
  });

  const handleOpenCafDialog = useCallback((mode: "fill" | "delete"): void => {
    setContentAwareFillOptionsMode(mode);
    setShowContentAwareFillOptionsDialog(true);
  }, []);

  const handleCafConfirm = useCallback(
    (samplingRadius: number): void => {
      setShowContentAwareFillOptionsDialog(false);
      if (contentAwareFillOptionsMode === "fill") {
        void runContentAwareFill(samplingRadius);
      } else {
        void runContentAwareDelete(samplingRadius);
      }
    },
    [contentAwareFillOptionsMode, runContentAwareFill, runContentAwareDelete],
  );

  // ── View actions ──────────────────────────────────────────────────
  const handleUndo = useCallback(() => {
    activeScope().history.undo();
  }, []);
  const handleRedo = useCallback(() => {
    activeScope().history.redo();
  }, []);

  const {
    findLayersCounter,
    handleZoomIn,
    handleZoomOut,
    handleZoom100,
    handleFitToWindow,
    handleToggleGrid,
    handleToggleRulers,
    handleToggleGuides,
    handleApplyGuidePreset,
    handleSetNormalMode,
    handleSetTiledMode,
    handleToggleTileGrid,
    handleSetAnimationMode,
    handleSelectAll,
    handleDeselect,
    handleSelectAllLayers,
    handleDeselectLayers,
    handleFindLayers,
  } = useViewActions({ dispatch, stateRef, canvasHandleRef });

  // Expose Fit-to-Window to the global viewport command bus so non-prop-drilled
  // surfaces (e.g. the zoom tool's options bar) can trigger it.
  useEffect(() => {
    viewportCommands.fitToWindow = handleFitToWindow;
    return () => {
      viewportCommands.fitToWindow = null;
    };
  }, [handleFitToWindow]);

  // ── Playback state ────────────────────────────────────────────────
  const playback = useAnimationPlayback(state, dispatch, canvasHandleRef);

  // ── Spritesheet / animation import & export ──────────────────────
  const {
    handleImportSpritesheetFrames,
    handleExportSpritesheetJson,
    handleExportPaletteAnimationJson,
    handleExportAnimationFrames,
    handleCopyPrevFrame,
    handleCopyNextFrame,
  } = useSpritesheetAnimationOps({
    canvasHandleRef,
    stateRef,
    captureHistory,
    dispatch,
  });

  // ── Sync state.pixelFormat → active TabRecord.pixelFormat ────────
  // SET_PIXEL_FORMAT updates state but not the tabs array; keep them in sync.
  useEffect(() => {
    setTabs((prev) => {
      const active = prev.find((t) => t.id === activeTabId);
      if (!active || active.pixelFormat === state.pixelFormat) return prev;
      return prev.map((t) =>
        t.id === activeTabId ? { ...t, pixelFormat: state.pixelFormat } : t,
      );
    });
  }, [state.pixelFormat, activeTabId, setTabs]);

  // ── Color mode ────────────────────────────────────────────────────
  const handleFormatRemount = useFormatRemount({
    canvasHandleRef,
    stateRef,
    activeTabId,
    setTabs,
    setPendingLayerData,
    captureHistory,
  });

  const colorMode = useColorMode({
    canvasHandleRef,
    state,
    dispatch,
    captureHistory,
    onFormatChangeRequiresRemount: handleFormatRemount,
    onRequestConversionDialog: setPendingConversion,
  });

  const colorProfile = useColorProfile({
    canvasHandleRef,
    state,
    dispatch,
    captureHistory,
  });

  // ── Polygonal selection keyboard handling ───────────────────────
  usePolygonalSelection();

  // ── Auto-Mask (ISNet) ─────────────────────────────────────────────
  const [isAutoMasking, setIsAutoMasking] = useState(false);
  useAutoMask({
    canvasHandleRef,
    stateRef,
    captureHistory,
    dispatch,
    setBusy: setIsAutoMasking,
  });

  // ── Object Removal (LaMa) ─────────────────────────────────────────
  const [isInpainting, setIsInpainting] = useState(false);
  useObjectRemoval({
    canvasHandleRef,
    stateRef,
    captureHistory,
    dispatch,
    pendingLayerLabelRef,
    setBusy: setIsInpainting,
  });

  // ── Tab / window guards ───────────────────────────────────────────
  const handleToolChange = useCallback(
    (tool: Tool): void => {
      requireTransformDecision(() =>
        dispatch({ type: "SET_TOOL", payload: tool }),
      );
    },
    [requireTransformDecision, dispatch],
  );

  const guardedSwitchTab = useCallback(
    (toId: string): void => {
      requireTransformDecision(() => {
        suppressReadyCaptureRef.current = true;
        handleSwitchTab(toId);
      });
    },
    [requireTransformDecision, handleSwitchTab, suppressReadyCaptureRef],
  );

  const guardedCloseTab = useCallback(
    (toId: string): void => {
      requireTransformDecision(() => handleCloseTab(toId));
    },
    [requireTransformDecision, handleCloseTab],
  );

  const handleClose = useCallback((): void => {
    guardedCloseTab(activeTabId);
  }, [guardedCloseTab, activeTabId]);

  const handleCloseAll = useCallback((): void => {
    const ids = tabs.filter((t) => t.id !== activeTabId).map((t) => t.id);
    for (const id of ids) handleCloseTab(id);
  }, [tabs, activeTabId, handleCloseTab]);

  const handleClearRecentFiles = clearRecentFiles;

  // ── Keyboard shortcuts ────────────────────────────────────────────
  useKeyboardShortcuts({
    handleUndo,
    handleRedo,
    handleCopy,
    handleCopyMerged,
    handleCut,
    handlePaste,
    handlePasteInto,
    handleDelete,
    handleZoomIn,
    handleZoomOut,
    handleFitToWindow,
    handleToggleGrid,
    handleKeyboardShortcuts: useCallback(
      () => setShowShortcutsDialog(true),
      [],
    ),
    handleFreeTransform: handleEnterTransform,
    handleInvertSelection: useCallback(() => activeScope().selection.invert(), []),
    handleSelectAll,
    handleDeselect,
    handleSelectAllLayers,
    handleCloneStamp: useCallback(
      () => handleToolChange("clone-stamp"),
      [handleToolChange],
    ),
    handleContentAwareDelete: useCallback(
      () => handleOpenCafDialog("delete"),
      [handleOpenCafDialog],
    ),
    handleFindLayers,
    handleCycleLasso: useCallback(() => {
      const next = toolRegistry.resolveShortcutCycle(
        "L",
        stateRef.current.activeTool,
      );
      if (next) handleToolChange(next);
    }, [handleToolChange]),
    handleCycleWand: useCallback(() => {
      const next = toolRegistry.resolveShortcutCycle(
        "W",
        stateRef.current.activeTool,
      );
      if (next) handleToolChange(next);
    }, [handleToolChange]),
    handleNew: useCallback(() => setShowNewImageDialog(true), []),
    handleOpen: useCallback(() => {
      void handleOpen();
    }, [handleOpen]),
    handleSave: useCallback(() => {
      void handleSave(false);
    }, [handleSave]),
    handleSaveAs: useCallback(() => {
      void handleSave(true);
    }, [handleSave]),
    handleExport: useCallback(() => setShowExportDialog(true), []),
    handleNewLayer,
    handleGroupLayers: useCallback(() => {
      const s = stateRef.current;
      const ids = new Set(s.selectedLayerIds);
      if (s.activeLayerId) ids.add(s.activeLayerId);
      handleGroupLayers([...ids]);
    }, [handleGroupLayers]),
    handleUngroupLayers: useCallback(() => {
      const id = stateRef.current.activeLayerId;
      if (id) handleUngroupLayers(id);
    }, [handleUngroupLayers]),
  });

  // ── Computed render values ────────────────────────────────────────
  const hasActiveDocument = tabs.length > 0;
  const tabInfos: TabInfo[] = tabs.map((t) => ({
    id: t.id,
    title: t.title,
    pixelFormat: t.pixelFormat,
  }));

  const activeLayer =
    state.layers.find((l) => l.id === state.activeLayerId) ?? null;
  const isRasterizeLayerEnabled =
    activeLayer !== null &&
    !(
      "type" in activeLayer &&
      (activeLayer.type === "mask" || activeLayer.type === "adjustment")
    );
  const effectiveSelectedIds = new Set(state.selectedLayerIds);
  if (state.activeLayerId) effectiveSelectedIds.add(state.activeLayerId);
  const isPixelRootLayer = (l: LayerState): boolean =>
    !("type" in l) ||
    l.type === "text" ||
    l.type === "shape" ||
    l.type === "path" ||
    l.type === "frame";
  const isMergeSelectedEnabled =
    [...effectiveSelectedIds].filter((id) => {
      const l = state.layers.find((x) => x.id === id);
      return l !== undefined && isPixelRootLayer(l);
    }).length >= 2;
  // Group needs ≥2 layers selected (matches `handleGroupLayers`'s own guard).
  // Ungroup needs the active layer to actually be a group.
  const isGroupLayersEnabled = effectiveSelectedIds.size >= 2;
  const isUngroupLayersEnabled =
    activeLayer !== null && isGroupLayer(activeLayer);

  // ── Unified menu deps ─────────────────────────────────────────────
  //
  // ONE `MenuDeps` object feeds BOTH the in-app menu (`<TopBar deps={…}/>`
  // in MainWindow) AND the macOS native menu (`useMacNativeMenu({ deps })`
  // below). All handler wrapping happens here, so the two consumers
  // can't drift — adding `requireTransformDecision` to one but not the
  // other (the kind of bug we hit with `colorMode:indexed8`) is now
  // structurally impossible.
  const isMac = window.api.platform === "darwin";
  const lutOps = useLutOps();

  const menuDeps: MenuDeps = useMemo(
    () => ({
      // ── File ────────────────────────────────────────────────────
      onNew: () => setShowNewImageDialog(true),
      onOpen: () => void handleOpen(),
      onSave: () => void handleSave(false),
      onSaveAs: () => void handleSave(true),
      onSaveACopy: () => void handleSaveACopy(),
      onExport: () => setShowExportDialog(true),
      onClose: handleClose,
      onCloseAll: handleCloseAll,
      recentFiles,
      onOpenRecent: (path) => void handleOpenPath(path),
      onClearRecentFiles: () => void handleClearRecentFiles(),
      onPreferences: () => setShowPreferencesDialog(true),
      onExit: () => void window.api.exitApp(),

      // ── Edit ────────────────────────────────────────────────────
      onUndo: handleUndo,
      onRedo: handleRedo,
      onCut: handleCut,
      onCopy: handleCopy,
      onCopyMerged: handleCopyMerged,
      onPaste: handlePaste,
      onPasteInto: handlePasteInto,
      onDelete: handleDelete,
      onContentAwareFill: () => handleOpenCafDialog("fill"),
      onContentAwareDelete: () => handleOpenCafDialog("delete"),
      // Free Transform passes through the transform-decision guard so
      // we don't blindly stack a new transform on top of an unfinished
      // one. Both menus go through this same wrapper now.
      onFreeTransform: () => requireTransformDecision(handleEnterTransform),
      isFreeTransformEnabled,

      // ── Select ──────────────────────────────────────────────────
      onSelectAll: handleSelectAll,
      onDeselect: handleDeselect,
      onSelectAllLayers: handleSelectAllLayers,
      onDeselectLayers: handleDeselectLayers,
      onFindLayers: handleFindLayers,
      onInvertSelection: () => activeScope().selection.invert(),

      // ── Layer ───────────────────────────────────────────────────
      onNewLayer: handleNewLayer,
      onNewLayerGroup: () => handleGroupLayers([]),
      onNewCompositeLayer: handleCreateCompositeLayer,
      onAddLayerMask: handleAddMaskLayer,
      onDuplicateLayer: handleDuplicateLayer,
      onDeleteLayer: handleDeleteActiveLayer,
      onRasterizeLayer: state.activeLayerId
        ? () => handleRasterizeLayer(state.activeLayerId!)
        : undefined,
      isRasterizeEnabled: isRasterizeLayerEnabled,
      onGroupLayers: () => handleGroupLayers([...effectiveSelectedIds]),
      isGroupLayersEnabled,
      onUngroupLayers: state.activeLayerId
        ? () => handleUngroupLayers(state.activeLayerId!)
        : undefined,
      isUngroupLayersEnabled,
      onMergeSelected: () =>
        handleMergeSelected([...effectiveSelectedIds]),
      isMergeSelectedEnabled,
      onMergeDown: handleMergeDown,
      onMergeVisible: handleMergeVisible,
      onFlattenImage: handleFlattenImage,
      onLayerRotate: (amount) => void handleRotateSelectedLayers(amount),
      onLayerFlip: (axis) => void handleFlipSelectedLayers(axis),
      onLayerAlign: (edge) => layerArrange.handleAlign(edge),
      onLayerDistribute: (axis) => layerArrange.handleDistribute(axis),
      onLayerOrder: (op) => layerArrange.handleOrder(op),

      // ── Image ───────────────────────────────────────────────────
      pixelFormat: state.pixelFormat,
      onSetColorMode: (fmt) => colorMode.handleConvertColorMode(fmt),
      hasIccProfile: !!state.iccProfile,
      onAssignProfile: () => void colorProfile.assignProfile(),
      onConvertToProfile: () => void colorProfile.convertToProfile(),
      onRemoveProfile: () => colorProfile.removeProfile(),
      // hasDisplayProfile is filled in by TopBar/useMacNativeMenu from
      // displayStore subscription; the menu rebuilds when it flips.
      onSetDisplayProfile: () => void colorProfile.setDisplayProfile(),
      onClearDisplayProfile: () => colorProfile.clearDisplayProfile(),
      onOpenColorSettings: () => setShowColorSettings(true),
      onOpenProfileManager: () => setShowProfileManager(true),
      onResizeImage: () => setShowResizeDialog(true),
      onResizeCanvas: () => setShowResizeCanvasDialog(true),
      onRescaleImage: () => setShowRescaleDialog(true),
      // AI rescale runs RGB pixels through Real-ESRGAN. Indexed8/float32
      // documents need a different path; gate them out of the menu rather
      // than silently failing.
      isRescaleEnabled: state.pixelFormat === "rgba8",
      onRestoreImage: () => setShowRestoreDialog(true),
      // Restore uses the same model pipeline, so the same format gate
      // applies.
      isRestoreEnabled: state.pixelFormat === "rgba8",
      onRotate90CW: () => void handleRotate("90cw"),
      onRotate180: () => void handleRotate("180"),
      onRotate270CW: () => void handleRotate("270cw"),
      onFlipHorizontal: () => void handleFlip("horizontal"),
      onFlipVertical: () => void handleFlip("vertical"),
      onLoadLut: () => void lutOps.loadCubeLut(),
      onManageLuts: () => setShowLutManager(true),
      onSetViewTransform: lutOps.setViewTransform,

      // ── Adjustments / Effects / Filters ─────────────────────────
      onCreateAdjustmentLayer: (type) =>
        requireTransformDecision(() => {
          if (type === "color-dithering") {
            setShowColorDitheringSetup(true);
          } else {
            adjustments.handleCreateAdjustmentLayer(type);
          }
        }),
      isAdjustmentMenuEnabled: adjustments.isAdjustmentMenuEnabled,
      adjustmentMenuItems: ADJUSTMENT_MENU_ITEMS,
      effectsMenuItems: EFFECTS_MENU_ITEMS,
      onOpenFilterDialog: handleOpenFilterDialog,
      onInstantFilter: (key) =>
        requireTransformDecision(() => filters.handleInstantFilter(key)),
      isFiltersMenuEnabled: adjustments.isAdjustmentMenuEnabled,
      filterMenuItems: FILTER_MENU_ITEMS,

      // ── Animation ───────────────────────────────────────────────
      animationMode: state.animationMode,
      isPlaying: playback.isPlaying,
      paletteAnimationActive: state.paletteAnimation.enabled,
      onPlayPause: playback.onPlayPause,
      onPrevFrame: playback.onPrevFrame,
      onNextFrame: playback.onNextFrame,
      onPrevAnimation: playback.onPrevAnimation,
      onNextAnimation: playback.onNextAnimation,
      onImportSpritesheetFrames: () =>
        setShowImportSpritesheetFramesDialog(true),
      onExportSpritesheetJson: () => void handleExportSpritesheetJson(),
      onExportPaletteAnimationJson: () =>
        void handleExportPaletteAnimationJson(),
      onExportAnimationFrames: () =>
        setShowExportAnimationFramesDialog(true),

      // ── View ────────────────────────────────────────────────────
      onZoomIn: handleZoomIn,
      onZoomOut: handleZoomOut,
      onZoom100: handleZoom100,
      onFitToWindow: handleFitToWindow,
      onToggleGrid: handleToggleGrid,
      showGrid: state.canvas.showGrid,
      onToggleRulers: handleToggleRulers,
      showRulers: state.canvas.showRulers,
      onToggleGuides: handleToggleGuides,
      showGuides: state.canvas.showGuides,
      onApplyGuidePreset: handleApplyGuidePreset,
      onSetNormalMode: handleSetNormalMode,
      onSetTiledMode: handleSetTiledMode,
      tiledMode: state.canvas.tiledMode,
      onToggleTileGrid: handleToggleTileGrid,
      showTileGrid: state.canvas.showTileGrid,
      onSetAnimationMode: handleSetAnimationMode,
      // hasProofProfile / proofColorsActive / gamutWarningActive are
      // filled in by TopBar/useMacNativeMenu from a displayStore
      // subscription — the menu rebuilds when they flip.
      onOpenProofSetup: () => setShowProofSetup(true),
      onToggleProofColors: () => colorProfile.toggleProofColors(),
      onToggleGamutWarning: () => void colorProfile.toggleGamutWarning(),

      // ── Help ────────────────────────────────────────────────────
      onAbout: () => setShowAboutDialog(true),
      onKeyboardShortcuts: () => setShowShortcutsDialog(true),
      onSystemInfo: () => setShowSystemInfoDialog(true),
      onDebug: () => void window.api.openDevTools(),
    }),
    // Every input that any handler closes over. The list is long but
    // necessary — drop one and a menu action gets stuck on a stale
    // closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      recentFiles,
      handleOpen,
      handleSave,
      handleSaveACopy,
      handleClose,
      handleCloseAll,
      handleOpenPath,
      handleClearRecentFiles,
      handleUndo,
      handleRedo,
      handleCut,
      handleCopy,
      handleCopyMerged,
      handlePaste,
      handlePasteInto,
      handleDelete,
      handleOpenCafDialog,
      handleEnterTransform,
      requireTransformDecision,
      isFreeTransformEnabled,
      handleSelectAll,
      handleDeselect,
      handleSelectAllLayers,
      handleDeselectLayers,
      handleFindLayers,
      handleNewLayer,
      handleGroupLayers,
      handleCreateCompositeLayer,
      handleAddMaskLayer,
      handleDuplicateLayer,
      handleDeleteActiveLayer,
      handleRasterizeLayer,
      state.activeLayerId,
      isRasterizeLayerEnabled,
      effectiveSelectedIds,
      isGroupLayersEnabled,
      handleUngroupLayers,
      isUngroupLayersEnabled,
      handleMergeSelected,
      isMergeSelectedEnabled,
      handleMergeDown,
      handleMergeVisible,
      handleFlattenImage,
      handleRotateSelectedLayers,
      handleFlipSelectedLayers,
      layerArrange,
      state.pixelFormat,
      colorMode,
      handleRotate,
      handleFlip,
      lutOps,
      adjustments,
      handleOpenFilterDialog,
      filters,
      state.animationMode,
      playback.isPlaying,
      state.paletteAnimation.enabled,
      playback,
      handleExportSpritesheetJson,
      handleExportPaletteAnimationJson,
      handleZoomIn,
      handleZoomOut,
      handleZoom100,
      handleFitToWindow,
      handleToggleGrid,
      state.canvas.showGrid,
      handleToggleRulers,
      state.canvas.showRulers,
      handleToggleGuides,
      state.canvas.showGuides,
      handleApplyGuidePreset,
      handleSetNormalMode,
      handleSetTiledMode,
      state.canvas.tiledMode,
      handleToggleTileGrid,
      state.canvas.showTileGrid,
      handleSetAnimationMode,
    ],
  );

  useMacNativeMenu({ isMac, deps: menuDeps });

  return (
    <>
      <SplashScreen
        open={!hasActiveDocument}
        onNew={() => setShowNewImageDialog(true)}
        onOpen={() => {
          void handleOpen();
        }}
      />
      <MainWindow
        isMac={isMac}
        menuDeps={menuDeps}
        activeTool={state.activeTool}
        pixelFormat={state.pixelFormat}
        activeLayerId={state.activeLayerId}
        openAdjustmentLayerId={state.openAdjustmentLayerId}
        swatches={state.swatches}
        canvasWidth={state.canvas.width}
        canvasHeight={state.canvas.height}
        zoom={state.canvas.zoom}
        tiledMode={state.canvas.tiledMode}
        animationMode={state.animationMode}
        tabs={tabs}
        tabInfos={tabInfos}
        activeTabId={activeTabId}
        canvasHandleRef={canvasHandleRef}
        pendingLayerData={pendingLayerData}
        setPendingLayerData={setPendingLayerData}
        tabCanvasRef={tabCanvasRef}
        captureHistory={captureHistory}
        pendingLayerLabelRef={pendingLayerLabelRef}
        dispatch={dispatch}
        hasActiveDocument={hasActiveDocument}
        adjustments={adjustments}
        colorMode={colorMode}
        isContentAwareFilling={isContentAwareFilling}
        contentAwareFillLabel={contentAwareFillLabel}
        cloneStampNotification={cloneStampNotification}
        contentAwareFillError={contentAwareFillError}
        memoryNotification={memoryNotification}
        handleExportConfirm={handleExportConfirm}
        pendingLdrExport={pendingLdrExport}
        clearPendingLdrExport={clearPendingLdrExport}
        confirmLdrExport={confirmLdrExport}
        showNewImageDialog={showNewImageDialog}
        setShowNewImageDialog={setShowNewImageDialog}
        showExportDialog={showExportDialog}
        setShowExportDialog={setShowExportDialog}
        exportableLayers={state.layers
          .filter((l) => {
            if (!("type" in l)) return true; // pixel
            const t = (l as { type: string }).type;
            // Only pixel-bearing leaves; group containers and parametric
            // helpers (mask, adjustment) aren't directly exportable.
            return (
              t === "text" ||
              t === "shape" ||
              t === "path" ||
              t === "frame" ||
              t === "composite"
            );
          })
          .map((l) => ({ id: l.id, name: l.name }))}
        showResizeDialog={showResizeDialog}
        setShowResizeDialog={setShowResizeDialog}
        showResizeCanvasDialog={showResizeCanvasDialog}
        setShowResizeCanvasDialog={setShowResizeCanvasDialog}
        showRescaleDialog={showRescaleDialog}
        setShowRescaleDialog={setShowRescaleDialog}
        showRestoreDialog={showRestoreDialog}
        setShowRestoreDialog={setShowRestoreDialog}
        isRescaling={isRescaling}
        rescaleProgress={rescaleProgress}
        isAutoMasking={isAutoMasking}
        isInpainting={isInpainting}
        showLutManager={showLutManager}
        setShowLutManager={setShowLutManager}
        showColorSettings={showColorSettings}
        setShowColorSettings={setShowColorSettings}
        showProofSetup={showProofSetup}
        setShowProofSetup={setShowProofSetup}
        showProfileManager={showProfileManager}
        setShowProfileManager={setShowProfileManager}
        onPickProofProfile={() => colorProfile.setProofProfile()}
        onClearProofProfile={() => colorProfile.clearProofProfile()}
        onToggleSimulatePaperColor={() =>
          colorProfile.toggleSimulatePaperColor()
        }
        onToggleGamutWarning={() => colorProfile.toggleGamutWarning()}
        showImportSpritesheetFramesDialog={showImportSpritesheetFramesDialog}
        setShowImportSpritesheetFramesDialog={
          setShowImportSpritesheetFramesDialog
        }
        handleImportSpritesheetFrames={handleImportSpritesheetFrames}
        showExportAnimationFramesDialog={showExportAnimationFramesDialog}
        setShowExportAnimationFramesDialog={
          setShowExportAnimationFramesDialog
        }
        handleExportAnimationFrames={(s, onProgress) =>
          handleExportAnimationFrames(s, onProgress)
        }
        exportAnimationName={
          state.paletteAnimation.enabled
            ? "palette cycle"
            : playback.selectedAnim?.name
        }
        exportPaletteGroups={
          state.paletteAnimation.enabled
            ? state.swatchGroups
                .filter((g) => g.cycle?.enabled)
                .map((g) => ({ id: g.id, name: g.name }))
            : undefined
        }
        exportComputeFrameCount={(selectedIds, evaluation) => {
          if (state.paletteAnimation.enabled) {
            const set = new Set(selectedIds);
            if (evaluation === "sequential") {
              // Sum of per-group periods (each group plays its own range,
              // others stay static).
              let total = 0;
              for (const g of state.swatchGroups) {
                if (!g.cycle?.enabled || !set.has(g.id)) continue;
                total += paletteCyclePeriod([g]);
              }
              return total;
            }
            // Parallel: LCM of selected periods.
            const groups = state.swatchGroups.map((g) =>
              !g.cycle?.enabled || set.has(g.id)
                ? g
                : { ...g, cycle: { ...g.cycle, enabled: false } },
            );
            return paletteCyclePeriod(groups);
          }
          return playback.selectedAnim?.frames.length ?? 0;
        }}
        exportDefaultGifFps={
          state.paletteAnimation.enabled
            ? state.paletteAnimation.fps
            : (playback.selectedAnim?.fps ?? 12)
        }
        showAboutDialog={showAboutDialog}
        setShowAboutDialog={setShowAboutDialog}
        showPreferencesDialog={showPreferencesDialog}
        setShowPreferencesDialog={setShowPreferencesDialog}
        showShortcutsDialog={showShortcutsDialog}
        setShowShortcutsDialog={setShowShortcutsDialog}
        showSystemInfoDialog={showSystemInfoDialog}
        setShowSystemInfoDialog={setShowSystemInfoDialog}
        showGeneratePaletteDialog={showGeneratePaletteDialog}
        setShowGeneratePaletteDialog={setShowGeneratePaletteDialog}
        showColorDitheringSetup={showColorDitheringSetup}
        setShowColorDitheringSetup={setShowColorDitheringSetup}
        showContentAwareFillOptionsDialog={showContentAwareFillOptionsDialog}
        setShowContentAwareFillOptionsDialog={
          setShowContentAwareFillOptionsDialog
        }
        contentAwareFillOptionsMode={contentAwareFillOptionsMode}
        pendingConversion={pendingConversion}
        setPendingConversion={setPendingConversion}
        pendingGuardedAction={pendingGuardedAction}
        setPendingGuardedAction={setPendingGuardedAction}
        handleTransformGuardApply={handleTransformGuardApply}
        handleTransformGuardDiscard={handleTransformGuardDiscard}
        handleNewConfirm={handleNewConfirm}
        handleDuplicateLayer={handleDuplicateLayer}
        handleRasterizeLayer={handleRasterizeLayer}
        handleMergeSelected={handleMergeSelected}
        handleMergeDown={handleMergeDown}
        handleMergeVisible={handleMergeVisible}
        handleFlattenImage={handleFlattenImage}
        handleMergeGroup={handleMergeGroup}
        handleGroupLayers={handleGroupLayers}
        handleUngroupLayers={handleUngroupLayers}
        handleCreateCompositeLayer={handleCreateCompositeLayer}
        handleResizeImage={handleResizeImage}
        handleRescaleImage={handleRescaleImage}
        handleRestoreImage={handleRestoreImage}
        handleResizeCanvas={handleResizeCanvas}
        isPlaying={playback.isPlaying}
        isLooping={playback.isLooping}
        currentFrame={
          state.paletteAnimation.enabled
            ? playback.paletteFrameIdx + 1
            : playback.currentFrameIdx + 1
        }
        totalFrames={
          state.paletteAnimation.enabled
            ? playback.paletteTotalFrames
            : (playback.selectedAnim?.frames.length ?? 0)
        }
        onPlayPause={playback.onPlayPause}
        onLoopToggle={playback.onLoopToggle}
        onPrevFrame={playback.onPrevFrame}
        onNextFrame={playback.onNextFrame}
        onPrevAnimation={playback.onPrevAnimation}
        onNextAnimation={playback.onNextAnimation}
        paletteAnimationActive={state.paletteAnimation.enabled}
        onCopyPrevFrame={handleCopyPrevFrame}
        onCopyNextFrame={handleCopyNextFrame}
        findLayersCounter={findLayersCounter}
        handleToolChange={handleToolChange}
        guardedSwitchTab={guardedSwitchTab}
        guardedCloseTab={guardedCloseTab}
        handleCafConfirm={handleCafConfirm}
        requireTransformDecision={requireTransformDecision}
      />
    </>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

function App(): React.JSX.Element {
  return (
    <AppProvider>
      <CanvasProvider>
        <AppContent />
      </CanvasProvider>
    </AppProvider>
  );
}

export default App;
