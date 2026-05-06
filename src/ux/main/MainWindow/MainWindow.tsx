import React from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AppAction } from "@/core/store/AppContext";
import type { TabRecord } from "@/core/store/tabTypes";
import type { UseAdjustmentsReturn } from "@/core/services/useAdjustments";
import type { UseFiltersReturn } from "@/core/services/useFilters";
import type { UseColorModeReturn } from "@/core/services/useColorMode";
import type { Tool, PixelFormat, RGBAColor } from "@/types";
import type { FilterKey } from "@/types";
import type { GuidePreset } from "@/core/services/useViewActions";
import type {
  AlignEdge,
  DistributeAxis,
  OrderOp,
} from "@/core/services/useLayerArrange";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { TabInfo } from "@/ux/main/TabBar/TabBar";
import type { ExportSettings } from "@/ux/modals/ExportDialog/ExportDialog";
import { TopBar } from "@/ux/main/TopBar/TopBar";
import { ToolOptionsBar } from "@/ux/main/ToolOptionsBar/ToolOptionsBar";
import { TabBar } from "@/ux/main/TabBar/TabBar";
import { Toolbar } from "@/ux/main/Toolbar/Toolbar";
import { Canvas } from "@/ux/main/Canvas/Canvas";
import { RightPanel } from "@/ux/main/RightPanel/RightPanel";
import { StatusBar } from "@/ux/main/StatusBar/StatusBar";
import { PlaybackBar } from "@/ux/main/PlaybackBar/PlaybackBar";
import { AnimationPanel } from "@/ux/main/AnimationPanel/AnimationPanel";
import { AdjustmentPanel } from "@/ux/windows/ToolWindow";
import { BrushSettingsPanelMount } from "@/ux/windows/brush/BrushSettingsPanel/BrushSettingsPanel";
import { PaintBrushesModalMount } from "@/ux/modals/PaintBrushesModal/PaintBrushesModal";
import { NewImageDialog } from "@/ux/modals/NewImageDialog/NewImageDialog";
import { ExportDialog } from "@/ux/modals/ExportDialog/ExportDialog";
import { ResizeImageDialog } from "@/ux/modals/ResizeImageDialog/ResizeImageDialog";
import { ResizeCanvasDialog } from "@/ux/modals/ResizeCanvasDialog/ResizeCanvasDialog";
import { AboutDialog } from "@/ux/modals/AboutDialog/AboutDialog";
import { PreferencesDialog } from "@/ux/modals/PreferencesDialog/PreferencesDialog";
import { HdrLdrExportWarningDialog } from "@/ux/modals/HdrLdrExportWarningDialog/HdrLdrExportWarningDialog";
import { KeyboardShortcutsDialog } from "@/ux/modals/KeyboardShortcutsDialog/KeyboardShortcutsDialog";
import { SystemInfoDialog } from "@/ux/modals/SystemInfoDialog/SystemInfoDialog";
import { LensFlareDialog } from "@/ux/windows/filters/LensFlareDialog/LensFlareDialog";
import { GeneratePaletteDialog } from "@/ux/modals/GeneratePaletteDialog/GeneratePaletteDialog";
import { ColorDitheringSetupModal } from "@/ux/modals/ColorDitheringSetupModal/ColorDitheringSetupModal";
import { ContentAwareFillProgress } from "@/ux";
import { ContentAwareFillOptionsDialog } from "@/ux/modals/ContentAwareFillOptionsDialog/ContentAwareFillOptionsDialog";
import { ConvertColorModeDialog } from "@/ux/modals/ConvertColorModeDialog/ConvertColorModeDialog";
import { ModalDialog } from "@/ux/modals/ModalDialog/ModalDialog";
import { DialogButton } from "@/ux/widgets/DialogButton/DialogButton";
import { selectionStore } from "@/core/store/selectionStore";
import {
  ADJUSTMENT_MENU_ITEMS,
  EFFECTS_MENU_ITEMS,
  FILTER_MENU_ITEMS,
} from "@/core/menuConstants";
import type { NewImageSettings } from "@/ux/modals/NewImageDialog/NewImageDialog";
import type { ResizeImageSettings } from "@/ux/modals/ResizeImageDialog/ResizeImageDialog";
import type { ResizeCanvasSettings } from "@/ux/modals/ResizeCanvasDialog/ResizeCanvasDialog";
import styles from "./MainWindow.module.scss";

// ─── Props ────────────────────────────────────────────────────────────────────

export interface MainWindowProps {
  // Platform
  isMac: boolean;

  // Canvas / document state (read-only slices)
  activeTool: Tool;
  pixelFormat: PixelFormat;
  activeLayerId: string | null;
  openAdjustmentLayerId: string | null;
  swatches: RGBAColor[];
  canvasWidth: number;
  canvasHeight: number;
  zoom: number;
  showGrid: boolean;
  tiledMode: boolean;
  showTileGrid: boolean;
  showRulers: boolean;
  showGuides: boolean;
  animationMode: boolean;

  // Tabs
  tabs: TabRecord[];
  tabInfos: TabInfo[];
  activeTabId: string;
  canvasHandleRef: { readonly current: CanvasHandle | null };
  pendingLayerData: Map<string, string> | null;
  setPendingLayerData: Dispatch<SetStateAction<Map<string, string> | null>>;
  tabCanvasRef: (id: string) => (h: CanvasHandle | null) => void;

  // History
  captureHistory: (
    label: string,
    overrides?: { swatches?: RGBAColor[] },
  ) => void;
  pendingLayerLabelRef: MutableRefObject<string | null>;
  dispatch: Dispatch<AppAction>;

  // Computed state
  hasActiveDocument: boolean;
  effectiveSelectedIds: Set<string>;
  isRasterizeLayerEnabled: boolean;
  isMergeSelectedEnabled: boolean;
  isFreeTransformEnabled: boolean;

  // Service hook results
  adjustments: UseAdjustmentsReturn;
  filters: UseFiltersReturn;
  colorMode: UseColorModeReturn;

  // Progress / notifications
  isContentAwareFilling: boolean;
  contentAwareFillLabel: string;
  cloneStampNotification: string | null;
  contentAwareFillError: string | null;
  memoryNotification: string | null;

  // Export
  handleExportConfirm: (settings: ExportSettings) => Promise<void>;
  pendingLdrExport: ExportSettings | null;
  clearPendingLdrExport: () => void;
  confirmLdrExport: () => Promise<void>;

  // Dialog state
  showNewImageDialog: boolean;
  setShowNewImageDialog: (v: boolean) => void;
  showExportDialog: boolean;
  setShowExportDialog: (v: boolean) => void;
  showResizeDialog: boolean;
  setShowResizeDialog: (v: boolean) => void;
  showResizeCanvasDialog: boolean;
  setShowResizeCanvasDialog: (v: boolean) => void;
  showAboutDialog: boolean;
  setShowAboutDialog: (v: boolean) => void;
  showPreferencesDialog: boolean;
  setShowPreferencesDialog: (v: boolean) => void;
  showShortcutsDialog: boolean;
  setShowShortcutsDialog: (v: boolean) => void;
  showSystemInfoDialog: boolean;
  setShowSystemInfoDialog: (v: boolean) => void;
  showLensFlareDialog: boolean;
  setShowLensFlareDialog: (v: boolean) => void;
  showGeneratePaletteDialog: boolean;
  setShowGeneratePaletteDialog: (v: boolean) => void;
  showColorDitheringSetup: boolean;
  setShowColorDitheringSetup: (v: boolean) => void;
  showContentAwareFillOptionsDialog: boolean;
  setShowContentAwareFillOptionsDialog: (v: boolean) => void;
  contentAwareFillOptionsMode: "fill" | "delete";
  pendingConversion: PixelFormat | null;
  setPendingConversion: (v: PixelFormat | null) => void;

  // Transform guard dialog
  pendingGuardedAction: (() => void) | null;
  setPendingGuardedAction: (v: (() => void) | null) => void;
  handleTransformGuardApply: () => void;
  handleTransformGuardDiscard: () => void;

  // File / session handlers
  handleNewConfirm: (s: NewImageSettings) => void;
  handleOpen: () => Promise<void>;
  handleOpenPath: (path: string) => Promise<void>;
  handleSave: (saveAs: boolean) => Promise<void>;
  handleSaveACopy: () => Promise<void>;
  handleClearRecentFiles: () => Promise<void>;
  recentFiles: string[];

  // Edit handlers
  handleUndo: () => void;
  handleRedo: () => void;
  handleCopy: () => void;
  handleCopyMerged: () => void;
  handleCut: () => void;
  handlePaste: () => void;
  handlePasteInto: () => void;
  handleDelete: () => void;

  // Layer handlers
  handleNewLayer: () => void;
  handleDuplicateLayer: () => void;
  handleDeleteActiveLayer: () => void;
  handleRasterizeLayer: (id: string) => void;
  handleMergeSelected: (ids: string[]) => void;
  handleMergeDown: () => void;
  handleMergeVisible: () => void;
  handleFlattenImage: () => void;
  handleMergeGroup: (groupId: string) => void;
  handleGroupLayers: (ids: string[]) => void;
  handleUngroupLayers: (id: string) => void;
  handleCreateCompositeLayer: () => void;
  handleAddMaskLayer: () => void;

  // Canvas transform handlers
  handleResizeImage: (s: ResizeImageSettings) => Promise<void>;
  handleResizeCanvas: (s: ResizeCanvasSettings) => void;
  handleRotate: (amount: "90cw" | "180" | "270cw") => Promise<void>;
  handleFlip: (axis: "horizontal" | "vertical") => Promise<void>;
  handleRotateSelectedLayers: (
    amount: "90cw" | "180" | "270cw",
  ) => Promise<void>;
  handleFlipSelectedLayers: (axis: "horizontal" | "vertical") => Promise<void>;
  layerArrange: {
    handleAlign: (e: AlignEdge) => void;
    handleDistribute: (a: DistributeAxis) => void;
    handleOrder: (o: OrderOp) => void;
  };

  // View handlers
  handleZoomIn: () => void;
  handleZoomOut: () => void;
  handleZoom100: () => void;
  handleFitToWindow: () => void;
  handleToggleGrid: () => void;
  handleSetNormalMode: () => void;
  handleSetTiledMode: () => void;
  handleToggleTileGrid: () => void;
  handleSetAnimationMode: (enabled: boolean) => void;
  handleToggleRulers: () => void;
  handleToggleGuides: () => void;
  handleApplyGuidePreset: (preset: GuidePreset) => void;
  handleSelectAll: () => void;
  handleDeselect: () => void;
  handleSelectAllLayers: () => void;
  handleDeselectLayers: () => void;
  handleFindLayers: () => void;
  findLayersCounter: number;

  // Tool / transform
  handleToolChange: (tool: Tool) => void;
  handleEnterTransform: () => void;

  // Tab guards
  guardedSwitchTab: (id: string) => void;
  guardedCloseTab: (id: string) => void;
  handleClose: () => void;
  handleCloseAll: () => void;

  // CAF
  handleOpenCafDialog: (mode: "fill" | "delete") => void;
  handleCafConfirm: (samplingRadius: number) => void;

  // Filter dialog
  handleOpenFilterDialog: (key: FilterKey) => void;

  // Adjustment + filter guards
  requireTransformDecision: (action: () => void) => void;

  // Playback
  isPlaying: boolean;
  isLooping: boolean;
  currentFrame: number;
  totalFrames: number;
  onPlayPause: () => void;
  onLoopToggle: () => void;
  onPrevFrame: () => void;
  onNextFrame: () => void;
  onPrevAnimation: () => void;
  onNextAnimation: () => void;

  // Animation panel
  onCopyPrevFrame: (animationId: string, frameId: string) => void;
  onCopyNextFrame: (animationId: string, frameId: string) => void;
}

// ─── MainWindow ───────────────────────────────────────────────────────────────

export function MainWindow(props: MainWindowProps): React.JSX.Element {
  const {
    isMac,
    activeTool,
    pixelFormat,
    activeLayerId,
    openAdjustmentLayerId,
    swatches,
    canvasWidth,
    canvasHeight,
    zoom,
    showGrid,
    tiledMode,
    showTileGrid,
    showRulers,
    showGuides,
    animationMode,
    tabs,
    tabInfos,
    activeTabId,
    canvasHandleRef,
    pendingLayerData,
    setPendingLayerData,
    tabCanvasRef,
    captureHistory,
    pendingLayerLabelRef,
    dispatch,
    hasActiveDocument,
    effectiveSelectedIds,
    isRasterizeLayerEnabled,
    isMergeSelectedEnabled,
    isFreeTransformEnabled,
    adjustments,
    filters,
    colorMode,
    isContentAwareFilling,
    contentAwareFillLabel,
    cloneStampNotification,
    contentAwareFillError,
    memoryNotification,
    handleExportConfirm,
    pendingLdrExport,
    clearPendingLdrExport,
    confirmLdrExport,
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
    showPreferencesDialog,
    setShowPreferencesDialog,
    showShortcutsDialog,
    setShowShortcutsDialog,
    showSystemInfoDialog,
    setShowSystemInfoDialog,
    showLensFlareDialog,
    setShowLensFlareDialog,
    showGeneratePaletteDialog,
    setShowGeneratePaletteDialog,
    showColorDitheringSetup,
    setShowColorDitheringSetup,
    showContentAwareFillOptionsDialog,
    setShowContentAwareFillOptionsDialog,
    contentAwareFillOptionsMode,
    pendingConversion,
    setPendingConversion,
    pendingGuardedAction,
    setPendingGuardedAction,
    handleTransformGuardApply,
    handleTransformGuardDiscard,
    handleNewConfirm,
    handleOpen,
    handleOpenPath,
    handleSave,
    handleSaveACopy,
    handleClearRecentFiles,
    recentFiles,
    handleUndo,
    handleRedo,
    handleCopy,
    handleCopyMerged,
    handleCut,
    handlePaste,
    handlePasteInto,
    handleDelete,
    handleNewLayer,
    handleDuplicateLayer,
    handleDeleteActiveLayer,
    handleRasterizeLayer,
    handleMergeSelected,
    handleMergeDown,
    handleMergeVisible,
    handleFlattenImage,
    handleMergeGroup,
    handleGroupLayers,
    handleUngroupLayers,
    handleCreateCompositeLayer,
    handleAddMaskLayer,
    handleResizeImage,
    handleResizeCanvas,
    handleRotate,
    handleFlip,
    handleRotateSelectedLayers,
    handleFlipSelectedLayers,
    layerArrange,
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
    findLayersCounter,
    handleToolChange,
    handleEnterTransform,
    guardedSwitchTab,
    guardedCloseTab,
    handleClose,
    handleCloseAll,
    handleOpenCafDialog,
    handleCafConfirm,
    handleOpenFilterDialog,
    requireTransformDecision,
    isPlaying,
    isLooping,
    currentFrame,
    totalFrames,
    onPlayPause,
    onLoopToggle,
    onPrevFrame,
    onNextFrame,
    onPrevAnimation,
    onNextAnimation,
    onCopyPrevFrame,
    onCopyNextFrame,
  } = props;

  return (
    <div className={styles.app}>
      <TopBar
        isMac={isMac}
        onDebug={() => window.api.openDevTools()}
        onNew={() => setShowNewImageDialog(true)}
        onOpen={handleOpen}
        onSave={() => void handleSave(false)}
        onSaveAs={() => void handleSave(true)}
        onSaveACopy={handleSaveACopy}
        onExport={() => setShowExportDialog(true)}
        onClose={handleClose}
        onCloseAll={handleCloseAll}
        recentFiles={recentFiles}
        onOpenRecent={handleOpenPath}
        onClearRecentFiles={handleClearRecentFiles}
        onExit={() => void window.api.exitApp()}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onCopy={handleCopy}
        onCopyMerged={handleCopyMerged}
        onCut={handleCut}
        onPaste={handlePaste}
        onPasteInto={handlePasteInto}
        onDelete={handleDelete}
        onResizeImage={() => setShowResizeDialog(true)}
        onResizeCanvas={() => setShowResizeCanvasDialog(true)}
        onRotate90CW={() => {
          void handleRotate("90cw");
        }}
        onRotate180={() => {
          void handleRotate("180");
        }}
        onRotate270CW={() => {
          void handleRotate("270cw");
        }}
        onFlipHorizontal={() => {
          void handleFlip("horizontal");
        }}
        onFlipVertical={() => {
          void handleFlip("vertical");
        }}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoom100={handleZoom100}
        onFitToWindow={handleFitToWindow}
        onToggleGrid={handleToggleGrid}
        showGrid={showGrid}
        onToggleRulers={handleToggleRulers}
        showRulers={showRulers}
        onToggleGuides={handleToggleGuides}
        onApplyGuidePreset={handleApplyGuidePreset}
        showGuides={showGuides}
        onSetNormalMode={handleSetNormalMode}
        onSetTiledMode={handleSetTiledMode}
        tiledMode={tiledMode}
        onToggleTileGrid={handleToggleTileGrid}
        showTileGrid={showTileGrid}
        onSetAnimationMode={handleSetAnimationMode}
        animationMode={animationMode}
        onNewLayer={handleNewLayer}
        onNewCompositeLayer={handleCreateCompositeLayer}
        onAddLayerMask={handleAddMaskLayer}
        onDuplicateLayer={handleDuplicateLayer}
        onDeleteLayer={handleDeleteActiveLayer}
        onMergeDown={handleMergeDown}
        onMergeVisible={handleMergeVisible}
        onFlattenImage={handleFlattenImage}
        onRasterizeLayer={
          activeLayerId ? () => handleRasterizeLayer(activeLayerId) : undefined
        }
        isRasterizeEnabled={isRasterizeLayerEnabled}
        onMergeSelected={() => handleMergeSelected([...effectiveSelectedIds])}
        isMergeSelectedEnabled={isMergeSelectedEnabled}
        onLayerRotate={(amount) => handleRotateSelectedLayers(amount)}
        onLayerFlip={(axis) => handleFlipSelectedLayers(axis)}
        onLayerAlign={(edge) => layerArrange.handleAlign(edge)}
        onLayerDistribute={(axis) => layerArrange.handleDistribute(axis)}
        onLayerOrder={(op) => layerArrange.handleOrder(op)}
        onAbout={() => setShowAboutDialog(true)}
        onPreferences={() => setShowPreferencesDialog(true)}
        onKeyboardShortcuts={() => setShowShortcutsDialog(true)}
        onSystemInfo={() => setShowSystemInfoDialog(true)}
        onCreateAdjustmentLayer={(type) =>
          requireTransformDecision(() => {
            if (type === "color-dithering") {
              setShowColorDitheringSetup(true);
            } else {
              adjustments.handleCreateAdjustmentLayer(type);
            }
          })
        }
        isAdjustmentMenuEnabled={adjustments.isAdjustmentMenuEnabled}
        adjustmentMenuItems={ADJUSTMENT_MENU_ITEMS}
        effectsMenuItems={EFFECTS_MENU_ITEMS}
        onOpenFilterDialog={handleOpenFilterDialog}
        onInstantFilter={(key) =>
          requireTransformDecision(() => filters.handleInstantFilter(key))
        }
        isFiltersMenuEnabled={adjustments.isAdjustmentMenuEnabled}
        filterMenuItems={FILTER_MENU_ITEMS}
        onContentAwareFill={() => handleOpenCafDialog("fill")}
        onContentAwareDelete={() => handleOpenCafDialog("delete")}
        onFreeTransform={handleEnterTransform}
        isFreeTransformEnabled={isFreeTransformEnabled}
        onInvertSelection={() => selectionStore.invert()}
        onSelectAll={handleSelectAll}
        onDeselect={handleDeselect}
        onSelectAllLayers={handleSelectAllLayers}
        onDeselectLayers={handleDeselectLayers}
        onFindLayers={handleFindLayers}
        pixelFormat={pixelFormat}
        onSetColorMode={(fmt) => colorMode.handleConvertColorMode(fmt)}
      />
      <ToolOptionsBar />
      <TabBar
        tabs={tabInfos}
        activeTabId={activeTabId}
        activeZoom={zoom}
        onSwitch={guardedSwitchTab}
        onClose={guardedCloseTab}
      />

      <div className={styles.workspace}>
        <Toolbar activeTool={activeTool} onToolChange={handleToolChange} />
        <main className={styles.canvasArea}>
          {tabs.map((tab) => {
            if (tab.id !== activeTabId) return null;
            return (
              <Canvas
                key={`${tab.id}-${tab.canvasKey}`}
                ref={tabCanvasRef(tab.id)}
                width={tab.snapshot.canvasWidth}
                height={tab.snapshot.canvasHeight}
                initialLayerData={
                  pendingLayerData ?? tab.savedLayerData ?? undefined
                }
                isActive={true}
                onStrokeEnd={captureHistory}
                onReady={() => {
                  setPendingLayerData(null);
                  captureHistory(
                    pendingLayerLabelRef.current ?? "Initial State",
                  );
                  pendingLayerLabelRef.current = null;
                  canvasHandleRef.current?.fitToWindow();
                }}
              />
            );
          })}
          <ContentAwareFillProgress
            visible={isContentAwareFilling}
            label={contentAwareFillLabel}
            sublabel="Analyzing image…"
          />
        </main>
        {animationMode && (
          <AnimationPanel
            onCopyPrevFrame={onCopyPrevFrame}
            onCopyNextFrame={onCopyNextFrame}
          />
        )}
        <RightPanel
          activeTabId={activeTabId}
          onMergeSelected={handleMergeSelected}
          onMergeVisible={handleMergeVisible}
          onMergeDown={handleMergeDown}
          onFlattenImage={handleFlattenImage}
          onRasterizeLayer={handleRasterizeLayer}
          onDuplicateLayer={handleDuplicateLayer}
          onOpenAdjustmentPanel={(id) =>
            requireTransformDecision(() =>
              adjustments.handleOpenAdjustmentPanel(id),
            )
          }
          onGeneratePalette={() => setShowGeneratePaletteDialog(true)}
          onMergeGroup={handleMergeGroup}
          onGroupSelected={handleGroupLayers}
          onUngroup={handleUngroupLayers}
          onCreateCompositeLayer={handleCreateCompositeLayer}
          findLayersTrigger={findLayersCounter}
        />
      </div>

      {animationMode && (
        <PlaybackBar
          isPlaying={isPlaying}
          isLooping={isLooping}
          currentFrame={currentFrame}
          totalFrames={totalFrames}
          onPrevAnimation={onPrevAnimation}
          onPrevFrame={onPrevFrame}
          onPlayPause={onPlayPause}
          onNextFrame={onNextFrame}
          onNextAnimation={onNextAnimation}
          onLoopToggle={onLoopToggle}
        />
      )}
      <StatusBar />

      {openAdjustmentLayerId !== null && (
        <AdjustmentPanel
          onClose={adjustments.handleCloseAdjustmentPanel}
          canvasHandleRef={canvasHandleRef}
        />
      )}

      <PaintBrushesModalMount />
      <BrushSettingsPanelMount
        onCaptureFromSelection={async () => {
          if (!activeLayerId) return;
          const layerPixels = canvasHandleRef.current?.getLayerPixels(
            activeLayerId,
          );
          const mask = selectionStore.mask;
          if (!layerPixels || !mask) return;
          const { captureBrushTipFromSelection } = await import(
            "@/core/services/captureBrush"
          );
          const tip = captureBrushTipFromSelection({
            canvasWidth,
            canvasHeight,
            layerPixels,
            selectionMask: mask,
          });
          if (!tip) return;
          const { brushStore } = await import("@/core/store/brushStore");
          const { makeDefaultBrush } = await import("@/types");
          const id = crypto.randomUUID();
          const brush = makeDefaultBrush(id, "Captured Brush");
          brush.shape = tip;
          await brushStore.addUserBrush(brush);
          // Make the freshly-captured brush active so the user sees it
          // immediately on the next stroke instead of having to find it
          // in the dropdown.
          dispatch({ type: "SET_ACTIVE_BRUSH", payload: id });
        }}
      />

      <NewImageDialog
        open={showNewImageDialog}
        onCancel={() => setShowNewImageDialog(false)}
        onConfirm={(s) => {
          handleNewConfirm(s);
          setShowNewImageDialog(false);
        }}
      />
      <ExportDialog
        open={showExportDialog}
        isHdrDocument={pixelFormat === "rgba32f"}
        documentWidth={canvasWidth}
        documentHeight={canvasHeight}
        onCancel={() => setShowExportDialog(false)}
        onConfirm={async (settings) => {
          setShowExportDialog(false);
          await handleExportConfirm(settings);
        }}
      />
      <ResizeImageDialog
        open={showResizeDialog}
        currentWidth={canvasWidth}
        currentHeight={canvasHeight}
        onCancel={() => setShowResizeDialog(false)}
        onConfirm={(s) => {
          void handleResizeImage(s);
          setShowResizeDialog(false);
        }}
      />
      <ResizeCanvasDialog
        open={showResizeCanvasDialog}
        currentWidth={canvasWidth}
        currentHeight={canvasHeight}
        onCancel={() => setShowResizeCanvasDialog(false)}
        onConfirm={(s) => {
          handleResizeCanvas(s);
          setShowResizeCanvasDialog(false);
        }}
      />
      <AboutDialog
        open={showAboutDialog}
        onClose={() => setShowAboutDialog(false)}
      />
      <PreferencesDialog
        open={showPreferencesDialog}
        onClose={() => setShowPreferencesDialog(false)}
      />
      <HdrLdrExportWarningDialog
        open={pendingLdrExport !== null}
        format={pendingLdrExport?.format ?? ""}
        onConfirm={() => {
          void confirmLdrExport();
        }}
        onCancel={clearPendingLdrExport}
      />
      <KeyboardShortcutsDialog
        open={showShortcutsDialog}
        onClose={() => setShowShortcutsDialog(false)}
      />
      <SystemInfoDialog
        open={showSystemInfoDialog}
        onClose={() => setShowSystemInfoDialog(false)}
      />
      {showLensFlareDialog && (
        <LensFlareDialog
          isOpen={showLensFlareDialog}
          canvasHandleRef={canvasHandleRef}
          activeLayerId={activeLayerId}
          onApply={(pixels, w, h) => {
            filters.handleApplyLensFlare(pixels, w, h);
            setShowLensFlareDialog(false);
          }}
          onCancel={() => setShowLensFlareDialog(false)}
          width={canvasWidth}
          height={canvasHeight}
        />
      )}
      <GeneratePaletteDialog
        open={showGeneratePaletteDialog}
        onClose={() => setShowGeneratePaletteDialog(false)}
        canvasHandleRef={canvasHandleRef}
        swatches={swatches}
        hasActiveDocument={hasActiveDocument}
        onApply={(palette) => {
          captureHistory("Generate Palette", { swatches: palette });
          dispatch({ type: "SET_SWATCHES", payload: palette });
        }}
      />

      <ColorDitheringSetupModal
        open={showColorDitheringSetup}
        onCancel={() => setShowColorDitheringSetup(false)}
        onOpenGeneratePalette={() => {
          setShowColorDitheringSetup(false);
          setShowGeneratePaletteDialog(true);
        }}
        onProceed={(addReduceColors) => {
          setShowColorDitheringSetup(false);
          adjustments.handleCreateColorDitheringWithSetup(addReduceColors);
        }}
      />

      <ContentAwareFillOptionsDialog
        open={showContentAwareFillOptionsDialog}
        mode={contentAwareFillOptionsMode}
        onConfirm={handleCafConfirm}
        onCancel={() => setShowContentAwareFillOptionsDialog(false)}
      />

      {cloneStampNotification && (
        <div className={styles.notification}>{cloneStampNotification}</div>
      )}

      {contentAwareFillError && (
        <div className={styles.notification}>{contentAwareFillError}</div>
      )}

      {memoryNotification && (
        <div className={styles.notification}>{memoryNotification}</div>
      )}

      <ModalDialog
        open={pendingGuardedAction !== null}
        title="Transform in Progress"
        width={360}
        onClose={() => setPendingGuardedAction(null)}
      >
        <div
          style={{
            padding: "16px 20px",
            fontSize: 13,
            color: "var(--color-text)",
          }}
        >
          You switched tools while a transform is active. Apply or discard it
          before continuing.
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "8px 16px 16px",
          }}
        >
          <DialogButton onClick={() => setPendingGuardedAction(null)}>
            Go Back
          </DialogButton>
          <DialogButton onClick={handleTransformGuardDiscard}>
            Discard
          </DialogButton>
          <DialogButton onClick={handleTransformGuardApply} primary>
            Apply
          </DialogButton>
        </div>
      </ModalDialog>

      {pendingConversion !== null && (
        <ConvertColorModeDialog
          open={true}
          fromFormat={pixelFormat}
          toFormat={pendingConversion}
          onConfirm={() => {
            void colorMode.executeConversion(pendingConversion);
            setPendingConversion(null);
          }}
          onCancel={() => setPendingConversion(null)}
        />
      )}
    </div>
  );
}
