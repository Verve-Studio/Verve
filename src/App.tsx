import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppProvider, useAppContext } from "@/core/store/AppContext";
import { CanvasProvider } from "@/core/store/CanvasContext";
import { historyStore } from "@/core/store/historyStore";
import { MemoryLimitError } from "@/core/store/memoryStore";
import {
  notificationStore,
  useNotification,
} from "@/core/store/notificationStore";
import { useTabs } from "@/core/services/useTabs";
import { useHistory } from "@/core/services/useHistory";
import { useFileOps } from "@/core/services/useFileOps";
import { useExportOps } from "@/core/services/useExportOps";
import { useClipboard } from "@/core/services/useClipboard";
import { useLayers } from "@/core/services/useLayers";
import { useLayerGroups } from "@/core/services/useLayerGroups";
import { useCanvasTransforms } from "@/core/services/useCanvasTransforms";
import { useLayerArrange } from "@/core/services/useLayerArrange";
import { useKeyboardShortcuts } from "@/core/services/useKeyboardShortcuts";
import { useAdjustments } from "@/core/services/useAdjustments";
import { useFilters } from "@/core/services/useFilters";
import { useTransform } from "@/core/services/useTransform";
import { usePolygonalSelection } from "@/core/services/usePolygonalSelection";
import { useObjectSelection } from "@/core/services/useObjectSelection";
import { useContentAwareFill } from "@/core/services/useContentAwareFill";
import { useColorMode } from "@/core/services/useColorMode";
import { useDialogState } from "@/core/services/useDialogState";
import { useViewActions } from "@/core/services/useViewActions";
import { useTransformGuard } from "@/core/services/useTransformGuard";
import { useMacNativeMenu } from "@/core/services/useMacNativeMenu";
import { useAnimationPlayback } from "@/core/services/useAnimationPlayback";
import { cloneStampStore } from "@/core/store/cloneStampStore";
import { pixelBrushStore } from "@/core/store/pixelBrushStore";
import { brushStore } from "@/core/store/brushStore";
import { makeDefaultBrush } from "@/types";
import { MainWindow } from "@/ux/main/MainWindow/MainWindow";
import { SplashScreen } from "@/ux/modals/SplashScreen/SplashScreen";
import type { TabInfo } from "@/ux/main/TabBar/TabBar";
import type { Tool, LayerState, PixelFormat } from "@/types";
import type { EffectType } from "@/core/effects/effectTypes";
import type { FilterKey } from "@/types";
import { selectionStore } from "@/core/store/selectionStore";
import {
  f32TransferStore,
  u8TransferStore,
} from "@/core/store/layerDataTransfer";

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
  } = useDialogState();

  const [showPreferencesDialog, setShowPreferencesDialog] = useState(false);

  // ── Notification / progress state ────────────────────────────────
  const [cloneStampNotification, setCloneStampNotification] = useState<
    string | null
  >(null);
  const [isContentAwareFilling, setIsContentAwareFilling] = useState(false);
  const [contentAwareFillError, setContentAwareFillError] = useState<
    string | null
  >(null);
  const [contentAwareFillLabel, setContentAwareFillLabel] =
    useState("Filling…");
  const [hasSelection, setHasSelection] = useState(false);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);

  // ── Pixel brush store init ────────────────────────────────────────
  useEffect(() => {
    void pixelBrushStore.init();
  }, []);

  // ── Paint brush store init + bootstrap default brush ─────────────
  useEffect(() => {
    void (async () => {
      await brushStore.init();
      if (brushStore.getUserBrushes().length === 0) {
        await brushStore.addUserBrush(
          makeDefaultBrush(crypto.randomUUID(), "Default Round"),
        );
      }
      // If no active brush is set yet, pick the first available user brush.
      if (state.activeBrushId === null) {
        const first = brushStore.getUserBrushes()[0];
        if (first) {
          dispatch({ type: "SET_ACTIVE_BRUSH", payload: first.id });
        }
      }
    })();
    // Intentionally run once on mount; no dependency array changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Clone stamp source deletion notification ─────────────────────
  const cloneStampNotifTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const contentAwareFillErrorTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  useEffect(() => {
    cloneStampStore.onSourceDeleted = () => {
      setCloneStampNotification(
        "⚠ Source layer was deleted — Alt+click to set a new source",
      );
      if (cloneStampNotifTimerRef.current !== null)
        clearTimeout(cloneStampNotifTimerRef.current);
      cloneStampNotifTimerRef.current = setTimeout(
        () => setCloneStampNotification(null),
        4000,
      );
    };
    return () => {
      cloneStampStore.onSourceDeleted = null;
      if (cloneStampNotifTimerRef.current !== null)
        clearTimeout(cloneStampNotifTimerRef.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (contentAwareFillErrorTimerRef.current !== null)
        clearTimeout(contentAwareFillErrorTimerRef.current);
    };
  }, []);

  // ── Global memory-limit error capture ────────────────────────────
  // Memory-cap violations can bubble up from anywhere (layer creation,
  // brush growLayerToFit, history restore, GPU texture allocation, etc).
  // Listen at the window level so we never miss one, regardless of which
  // call site threw it.
  useEffect(() => {
    const onError = (e: ErrorEvent): void => {
      if (e.error instanceof MemoryLimitError) {
        notificationStore.error(e.error.message);
        e.preventDefault();
      }
    };
    const onRejection = (e: PromiseRejectionEvent): void => {
      if (e.reason instanceof MemoryLimitError) {
        notificationStore.error(e.reason.message);
        e.preventDefault();
      }
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  const memoryNotification = useNotification();

  // ── Selection state for menu enabled sync ────────────────────────
  useEffect(() => {
    const update = (): void => setHasSelection(selectionStore.hasSelection());
    selectionStore.subscribe(update);
    return () => selectionStore.unsubscribe(update);
  }, []);

  // ── Recent files ──────────────────────────────────────────────────
  useEffect(() => {
    window.api.getRecentFiles().then(setRecentFiles);
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
  const handleOpenPathRef = useRef(handleOpenPath);
  handleOpenPathRef.current = handleOpenPath;
  useEffect(() => {
    void window.api.getStartupFile().then((path) => {
      if (path) void handleOpenPathRef.current(path);
    });
    return window.api.onOpenFile((path) => {
      void handleOpenPathRef.current(path);
    });
  }, []); // mount-only

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
  const {
    handleResizeImage,
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
    return selectionStore.mask ? selectionStore.mask.slice() : null;
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
  const onCreateFilterAdjLayer = useCallback(
    (type: EffectType): void => {
      requireTransformDecision(() => {
        if (type === "clouds") {
          const { r: fgR, g: fgG, b: fgB } = state.primaryColor;
          const { r: bgR, g: bgG, b: bgB } = state.secondaryColor;
          adjustments.handleCreateAdjustmentLayer("clouds", {
            seed: (Math.random() * 0xffffffff) >>> 0,
            fgR,
            fgG,
            fgB,
            bgR,
            bgG,
            bgB,
          });
          return;
        }
        if (type === "add-noise" || type === "film-grain") {
          adjustments.handleCreateAdjustmentLayer(type, {
            seed: (Math.random() * 0xffffffff) >>> 0,
          });
          return;
        }
        adjustments.handleCreateAdjustmentLayer(type);
      });
    },
    [
      adjustments,
      requireTransformDecision,
      state.primaryColor,
      state.secondaryColor,
    ],
  );

  const handleOpenFilterDialog = useCallback(
    (key: FilterKey): void => {
      requireTransformDecision(() => {
        onCreateFilterAdjLayer(key as EffectType);
      });
    },
    [requireTransformDecision, onCreateFilterAdjLayer],
  );

  const filters = useFilters({ onCreateFilterAdjLayer });

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
    historyStore.undo();
  }, []);
  const handleRedo = useCallback(() => {
    historyStore.redo();
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

  // ── Playback state ────────────────────────────────────────────────
  const playback = useAnimationPlayback(state, dispatch);

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
  const handleFormatRemount = useCallback(
    (toFormat: PixelFormat): void => {
      const handle = canvasHandleRef.current;
      if (!handle) return;
      const layerGeo = handle.captureAllLayerGeometry();
      const encoded = new Map<string, string>();
      for (const ls of stateRef.current.layers) {
        if ("type" in ls) continue;
        const raw = handle.getLayerRawData(ls.id);
        if (!raw) continue;
        const geo = layerGeo.get(ls.id);
        if (geo) encoded.set(`${ls.id}:geo`, JSON.stringify(geo));
        const CHUNK = 65535;
        if (toFormat === "rgba32f") {
          // Store the typed array directly — avoids ~576 MB of base64/atob intermediaries for large images.
          f32TransferStore.set(ls.id, raw as Float32Array);
          encoded.set(ls.id, `data:raw/f32-ref;id=${ls.id}`);
        } else if (toFormat === "indexed8") {
          const u8 = raw as Uint8Array;
          let b64 = "";
          for (let i = 0; i < u8.length; i += CHUNK) {
            b64 += btoa(
              String.fromCharCode(...Array.from(u8.subarray(i, i + CHUNK))),
            );
          }
          encoded.set(ls.id, `data:raw/indexed8;base64,${b64}`);
        } else {
          u8TransferStore.set(ls.id, raw as Uint8Array);
          encoded.set(ls.id, `data:raw/rgba8-ref;id=${ls.id}`);
        }
      }
      setPendingLayerData(encoded);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId ? { ...t, canvasKey: t.canvasKey + 1 } : t,
        ),
      );
      captureHistory("Convert Color Mode");
    },
    [
      canvasHandleRef,
      stateRef,
      activeTabId,
      setTabs,
      setPendingLayerData,
      captureHistory,
    ],
  );

  const colorMode = useColorMode({
    canvasHandleRef,
    state,
    dispatch,
    captureHistory,
    onFormatChangeRequiresRemount: handleFormatRemount,
    onRequestConversionDialog: setPendingConversion,
  });

  // ── Polygonal selection keyboard handling ───────────────────────
  usePolygonalSelection();

  // ── Object Selection (SAM) ────────────────────────────────────────
  useObjectSelection({
    canvasHandleRef,
    stateRef,
    captureHistory,
    activeTabId,
    layers: state.layers,
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

  const handleClearRecentFiles = useCallback(async (): Promise<void> => {
    await window.api.clearRecentFiles();
    setRecentFiles([]);
  }, []);

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
    handleInvertSelection: useCallback(() => selectionStore.invert(), []),
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
      const current = stateRef.current.activeTool;
      const next =
        current === "polygonal-selection" ? "lasso" : "polygonal-selection";
      handleToolChange(next);
    }, [handleToolChange]),
    handleCycleWand: useCallback(() => {
      const current = stateRef.current.activeTool;
      const next = current === "magic-wand" ? "object-selection" : "magic-wand";
      handleToolChange(next);
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
    l.type === "frame";
  const isMergeSelectedEnabled =
    [...effectiveSelectedIds].filter((id) => {
      const l = state.layers.find((x) => x.id === id);
      return l !== undefined && isPixelRootLayer(l);
    }).length >= 2;

  // ── macOS native menu ─────────────────────────────────────────────
  const isMac = window.api.platform === "darwin";

  useMacNativeMenu({
    isMac,
    recentFiles,
    requireTransformDecision,
    adjustments,
    filters,
    handleOpenFilterDialog,
    handleOpen,
    handleOpenPath,
    handleClose,
    handleCloseAll,
    handleSave,
    handleSaveACopy,
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
    handleNewLayer,
    handleDuplicateLayer,
    handleDeleteActiveLayer,
    handleRasterizeLayer,
    handleGroupLayers,
    handleUngroupLayers,
    handleCreateCompositeLayer,
    handleAddMaskLayer,
    handleMergeSelected,
    handleMergeDown,
    handleMergeVisible,
    handleFlattenImage,
    handleEnterTransform,
    handleZoomIn,
    handleZoomOut,
    handleZoom100,
    handleFitToWindow,
    handleToggleGrid,
    handleSetNormalMode,
    handleSetTiledMode,
    handleToggleTileGrid,
    handleSetAnimationMode,
    handleToggleRulers,
    handleToggleGuides,
    handleApplyGuidePreset,
    handleSelectAll,
    handleDeselect,
    handleSelectAllLayers,
    handleDeselectLayers,
    handleFindLayers,
    colorMode,
    openNewImageDialog: () => setShowNewImageDialog(true),
    openExportDialog: () => setShowExportDialog(true),
    openResizeImageDialog: () => setShowResizeDialog(true),
    openResizeCanvasDialog: () => setShowResizeCanvasDialog(true),
    handleRotate,
    handleFlip,
    handleRotateSelectedLayers,
    handleFlipSelectedLayers,
    layerArrange,
    openAboutDialog: () => setShowAboutDialog(true),
    openShortcutsDialog: () => setShowShortcutsDialog(true),
    openSystemInfoDialog: () => setShowSystemInfoDialog(true),
    openColorDitheringSetup: () => setShowColorDitheringSetup(true),
    openPreferencesDialog: () => setShowPreferencesDialog(true),
    activeLayerId: state.activeLayerId,
    effectiveSelectedIds,
    isFreeTransformEnabled,
    isRasterizeLayerEnabled,
    isMergeSelectedEnabled,
    hasSelection,
    isContentAwareFilling,
    pixelFormat: state.pixelFormat,
    showGrid: state.canvas.showGrid,
    tiledMode: state.canvas.tiledMode,
    showTileGrid: state.canvas.showTileGrid,
    showRulers: state.canvas.showRulers,
    showGuides: state.canvas.showGuides,
    animationMode: state.animationMode,
  });

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
        activeTool={state.activeTool}
        pixelFormat={state.pixelFormat}
        activeLayerId={state.activeLayerId}
        openAdjustmentLayerId={state.openAdjustmentLayerId}
        swatches={state.swatches}
        canvasWidth={state.canvas.width}
        canvasHeight={state.canvas.height}
        zoom={state.canvas.zoom}
        showGrid={state.canvas.showGrid}
        showRulers={state.canvas.showRulers}
        showGuides={state.canvas.showGuides}
        tiledMode={state.canvas.tiledMode}
        showTileGrid={state.canvas.showTileGrid}
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
        effectiveSelectedIds={effectiveSelectedIds}
        isRasterizeLayerEnabled={isRasterizeLayerEnabled}
        isMergeSelectedEnabled={isMergeSelectedEnabled}
        isFreeTransformEnabled={isFreeTransformEnabled}
        adjustments={adjustments}
        filters={filters}
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
        showResizeDialog={showResizeDialog}
        setShowResizeDialog={setShowResizeDialog}
        showResizeCanvasDialog={showResizeCanvasDialog}
        setShowResizeCanvasDialog={setShowResizeCanvasDialog}
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
        handleOpen={handleOpen}
        handleOpenPath={handleOpenPath}
        handleSave={handleSave}
        handleSaveACopy={handleSaveACopy}
        handleClearRecentFiles={handleClearRecentFiles}
        recentFiles={recentFiles}
        handleUndo={handleUndo}
        handleRedo={handleRedo}
        handleCopy={handleCopy}
        handleCopyMerged={handleCopyMerged}
        handleCut={handleCut}
        handlePaste={handlePaste}
        handlePasteInto={handlePasteInto}
        handleDelete={handleDelete}
        handleNewLayer={handleNewLayer}
        handleDuplicateLayer={handleDuplicateLayer}
        handleDeleteActiveLayer={handleDeleteActiveLayer}
        handleRasterizeLayer={handleRasterizeLayer}
        handleMergeSelected={handleMergeSelected}
        handleMergeDown={handleMergeDown}
        handleMergeVisible={handleMergeVisible}
        handleFlattenImage={handleFlattenImage}
        handleMergeGroup={handleMergeGroup}
        handleGroupLayers={handleGroupLayers}
        handleUngroupLayers={handleUngroupLayers}
        handleCreateCompositeLayer={handleCreateCompositeLayer}
        handleAddMaskLayer={handleAddMaskLayer}
        handleResizeImage={handleResizeImage}
        handleResizeCanvas={handleResizeCanvas}
        handleRotate={handleRotate}
        handleFlip={handleFlip}
        handleRotateSelectedLayers={handleRotateSelectedLayers}
        handleFlipSelectedLayers={handleFlipSelectedLayers}
        layerArrange={layerArrange}
        handleZoomIn={handleZoomIn}
        handleZoomOut={handleZoomOut}
        handleZoom100={handleZoom100}
        handleFitToWindow={handleFitToWindow}
        handleToggleGrid={handleToggleGrid}
        handleToggleRulers={handleToggleRulers}
        handleToggleGuides={handleToggleGuides}
        handleApplyGuidePreset={handleApplyGuidePreset}
        handleSetNormalMode={handleSetNormalMode}
        handleSetTiledMode={handleSetTiledMode}
        handleToggleTileGrid={handleToggleTileGrid}
        handleSetAnimationMode={handleSetAnimationMode}
        isPlaying={playback.isPlaying}
        isLooping={playback.isLooping}
        currentFrame={playback.currentFrameIdx + 1}
        totalFrames={playback.selectedAnim?.frames.length ?? 0}
        onPlayPause={playback.onPlayPause}
        onLoopToggle={playback.onLoopToggle}
        onPrevFrame={playback.onPrevFrame}
        onNextFrame={playback.onNextFrame}
        onPrevAnimation={playback.onPrevAnimation}
        onNextAnimation={playback.onNextAnimation}
        onCopyPrevFrame={useCallback(
          (animationId: string, frameId: string) => {
            const ss = stateRef.current.spritesheet;
            const anim = ss.animations.find((a) => a.id === animationId);
            if (!anim) return;
            const fi = anim.frames.findIndex((f) => f.id === frameId);
            if (fi <= 0) return; // no previous frame
            const cellW = Math.max(1, ss.cellWidth);
            const cellH = Math.max(1, ss.cellHeight);
            const cols = Math.max(1, Math.floor(state.canvas.width / cellW));
            // compute global indices for prev and current frames
            let animStart = 0;
            for (const a of ss.animations) {
              if (a.id === animationId) break;
              animStart += a.frames.length;
            }
            const srcIdx = animStart + fi - 1;
            const dstIdx = animStart + fi;
            const srcX = (srcIdx % cols) * cellW,
              srcY = Math.floor(srcIdx / cols) * cellH;
            const dstX = (dstIdx % cols) * cellW,
              dstY = Math.floor(dstIdx / cols) * cellH;
            captureHistory("Copy From Previous Frame");
            canvasHandleRef.current?.copyCellRect(
              srcX,
              srcY,
              dstX,
              dstY,
              cellW,
              cellH,
            );
          },
          [stateRef, state.canvas.width, captureHistory, canvasHandleRef],
        )}
        onCopyNextFrame={useCallback(
          (animationId: string, frameId: string) => {
            const ss = stateRef.current.spritesheet;
            const anim = ss.animations.find((a) => a.id === animationId);
            if (!anim) return;
            const fi = anim.frames.findIndex((f) => f.id === frameId);
            if (fi < 0 || fi >= anim.frames.length - 1) return; // no next frame
            const cellW = Math.max(1, ss.cellWidth);
            const cellH = Math.max(1, ss.cellHeight);
            const cols = Math.max(1, Math.floor(state.canvas.width / cellW));
            let animStart = 0;
            for (const a of ss.animations) {
              if (a.id === animationId) break;
              animStart += a.frames.length;
            }
            const srcIdx = animStart + fi + 1;
            const dstIdx = animStart + fi;
            const srcX = (srcIdx % cols) * cellW,
              srcY = Math.floor(srcIdx / cols) * cellH;
            const dstX = (dstIdx % cols) * cellW,
              dstY = Math.floor(dstIdx / cols) * cellH;
            captureHistory("Copy From Next Frame");
            canvasHandleRef.current?.copyCellRect(
              srcX,
              srcY,
              dstX,
              dstY,
              cellW,
              cellH,
            );
          },
          [stateRef, state.canvas.width, captureHistory, canvasHandleRef],
        )}
        handleSelectAll={handleSelectAll}
        handleDeselect={handleDeselect}
        handleSelectAllLayers={handleSelectAllLayers}
        handleDeselectLayers={handleDeselectLayers}
        handleFindLayers={handleFindLayers}
        findLayersCounter={findLayersCounter}
        handleToolChange={handleToolChange}
        handleEnterTransform={handleEnterTransform}
        guardedSwitchTab={guardedSwitchTab}
        guardedCloseTab={guardedCloseTab}
        handleClose={handleClose}
        handleCloseAll={handleCloseAll}
        handleOpenCafDialog={handleOpenCafDialog}
        handleCafConfirm={handleCafConfirm}
        handleOpenFilterDialog={handleOpenFilterDialog}
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
