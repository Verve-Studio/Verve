import React from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AppAction } from "@/core/store/AppContext";
import type { TabRecord } from "@/core/store/tabTypes";
import type { UseAdjustmentsReturn } from "@/core/services/useAdjustments";
import type { UseColorModeReturn } from "@/core/services/useColorMode";
import type { Tool, PixelFormat, RGBAColor } from "@/types";
import { makeDefaultBrush } from "@/types";
import { brushStore } from "@/core/store/brushStore";
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
import { RescaleImageDialog } from "@/ux/modals/RescaleImageDialog/RescaleImageDialog";
import { RestoreImageDialog } from "@/ux/modals/RestoreImageDialog/RestoreImageDialog";
import { ImportSpritesheetFramesDialog } from "@/ux/modals/ImportSpritesheetFramesDialog/ImportSpritesheetFramesDialog";
import { ExportAnimationFramesDialog } from "@/ux/modals/ExportAnimationFramesDialog/ExportAnimationFramesDialog";
import { AboutDialog } from "@/ux/modals/AboutDialog/AboutDialog";
import { LutManagerDialog } from "@/ux/modals/LutManagerDialog/LutManagerDialog";
import { ColorSettingsDialog } from "@/ux/modals/ColorSettingsDialog/ColorSettingsDialog";
import { ProofSetupDialog } from "@/ux/modals/ProofSetupDialog/ProofSetupDialog";
import { ProfileManagerDialog } from "@/ux/modals/ProfileManagerDialog/ProfileManagerDialog";
import { ProfilePickerDialog } from "@/ux/modals/ProfilePickerDialog/ProfilePickerDialog";
import { PreferencesDialog } from "@/ux/modals/PreferencesDialog/PreferencesDialog";
import { HdrLdrExportWarningDialog } from "@/ux/modals/HdrLdrExportWarningDialog/HdrLdrExportWarningDialog";
import { KeyboardShortcutsDialog } from "@/ux/modals/KeyboardShortcutsDialog/KeyboardShortcutsDialog";
import { SystemInfoDialog } from "@/ux/modals/SystemInfoDialog/SystemInfoDialog";
import { GeneratePaletteDialog } from "@/ux/modals/GeneratePaletteDialog/GeneratePaletteDialog";
import { ColorDitheringSetupModal } from "@/ux/modals/ColorDitheringSetupModal/ColorDitheringSetupModal";
import { ProgressOverlay } from "@/ux";
import { ContentAwareFillOptionsDialog } from "@/ux/modals/ContentAwareFillOptionsDialog/ContentAwareFillOptionsDialog";
import { ConvertColorModeDialog } from "@/ux/modals/ConvertColorModeDialog/ConvertColorModeDialog";
import { ModalDialog } from "@/ux/modals/ModalDialog/ModalDialog";
import { DialogButton } from "@/ux/widgets/DialogButton/DialogButton";

import type { NewImageSettings } from "@/ux/modals/NewImageDialog/NewImageDialog";
import type { ResizeImageSettings } from "@/ux/modals/ResizeImageDialog/ResizeImageDialog";
import type { ResizeCanvasSettings } from "@/ux/modals/ResizeCanvasDialog/ResizeCanvasDialog";
import type { RescaleImageSettings } from "@/ux/modals/RescaleImageDialog/RescaleImageDialog";
import type { RestoreImageSettings } from "@/ux/modals/RestoreImageDialog/RestoreImageDialog";
import styles from "./MainWindow.module.scss";
import { activeScope } from "@/core/store/scope";

// ─── Props ────────────────────────────────────────────────────────────────────

export interface MainWindowProps {
  // Platform
  isMac: boolean;

  /** Unified menu deps. Both the in-app top-bar menu (rendered here)
   *  AND the macOS native menu (`useMacNativeMenu` in App.tsx) consume
   *  the same object. See `src/ux/main/menu/menuTree.ts`. Once handlers
   *  flow through this object, they're invisible to MainWindow itself
   *  — only TopBar reads from it. */
  menuDeps: import("@/ux/main/menu/menuTree").MenuDeps;

  // Canvas / document state (read-only slices)
  activeTool: Tool;
  pixelFormat: PixelFormat;
  activeLayerId: string | null;
  openAdjustmentLayerId: string | null;
  swatches: RGBAColor[];
  canvasWidth: number;
  canvasHeight: number;
  zoom: number;
  tiledMode: boolean;
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

  // Service hook results
  adjustments: UseAdjustmentsReturn;
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
  exportableLayers: import(
    "@/ux/modals/ExportDialog/ExportDialog"
  ).ExportableLayerOption[];
  showResizeDialog: boolean;
  setShowResizeDialog: (v: boolean) => void;
  showResizeCanvasDialog: boolean;
  setShowResizeCanvasDialog: (v: boolean) => void;
  showRescaleDialog: boolean;
  setShowRescaleDialog: (v: boolean) => void;
  showRestoreDialog: boolean;
  setShowRestoreDialog: (v: boolean) => void;
  isRescaling: boolean;
  rescaleProgress: import(
    "@/core/services/useCanvasTransforms"
  ).RescaleProgress;
  isAutoMasking: boolean;
  isInpainting: boolean;
  showLutManager: boolean;
  setShowLutManager: (v: boolean) => void;
  showColorSettings: boolean;
  setShowColorSettings: (v: boolean) => void;
  showProofSetup: boolean;
  setShowProofSetup: (v: boolean) => void;
  onPickProofProfile: () => Promise<void>;
  onClearProofProfile: () => void;
  onToggleSimulatePaperColor: () => Promise<void>;
  onToggleGamutWarning: () => Promise<void>;
  showProfileManager: boolean;
  setShowProfileManager: (v: boolean) => void;
  showImportSpritesheetFramesDialog: boolean;
  setShowImportSpritesheetFramesDialog: (v: boolean) => void;
  handleImportSpritesheetFrames: (
    result: import(
      "@/ux/modals/ImportSpritesheetFramesDialog/ImportSpritesheetFramesDialog"
    ).ImportSpritesheetFramesResult,
  ) => void;
  showExportAnimationFramesDialog: boolean;
  setShowExportAnimationFramesDialog: (v: boolean) => void;
  handleExportAnimationFrames: (
    settings: import(
      "@/ux/modals/ExportAnimationFramesDialog/ExportAnimationFramesDialog"
    ).ExportAnimationFramesSettings,
    onProgress: (current: number, total: number) => void,
  ) => Promise<void>;
  exportAnimationName: string | undefined;
  exportPaletteGroups:
    | import(
        "@/ux/modals/ExportAnimationFramesDialog/ExportAnimationFramesDialog"
      ).PaletteGroupOption[]
    | undefined;
  exportComputeFrameCount: (
    selectedGroupIds: string[],
    evaluation: import(
      "@/ux/modals/ExportAnimationFramesDialog/ExportAnimationFramesDialog"
    ).PaletteCycleEvaluation,
  ) => number;
  exportDefaultGifFps: number | undefined;
  showAboutDialog: boolean;
  setShowAboutDialog: (v: boolean) => void;
  showPreferencesDialog: boolean;
  setShowPreferencesDialog: (v: boolean) => void;
  showShortcutsDialog: boolean;
  setShowShortcutsDialog: (v: boolean) => void;
  showSystemInfoDialog: boolean;
  setShowSystemInfoDialog: (v: boolean) => void;
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

  // Layer handlers (used by RightPanel)
  handleDuplicateLayer: () => void;
  handleRasterizeLayer: (id: string) => void;
  handleMergeSelected: (ids: string[]) => void;
  handleMergeDown: () => void;
  handleMergeVisible: () => void;
  handleFlattenImage: () => void;
  handleMergeGroup: (groupId: string) => void;
  handleGroupLayers: (ids: string[]) => void;
  handleUngroupLayers: (id: string) => void;
  handleCreateCompositeLayer: () => void;
  handleRefreshLinkedLayer: () => void;

  // Canvas transform handlers (used by dialogs)
  handleResizeImage: (s: ResizeImageSettings) => Promise<void>;
  handleRescaleImage: (s: RescaleImageSettings) => Promise<void>;
  handleRestoreImage: (s: RestoreImageSettings) => Promise<void>;
  handleResizeCanvas: (s: ResizeCanvasSettings) => void;

  findLayersCounter: number;

  // Tool
  handleToolChange: (tool: Tool) => void;

  // Tab guards
  guardedSwitchTab: (id: string) => void;
  guardedCloseTab: (id: string) => void;

  // CAF
  handleCafConfirm: (samplingRadius: number) => void;

  // Adjustment + filter guards (used to gate adjustment-panel open)
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
  paletteAnimationActive: boolean;

  // Animation panel
  onCopyPrevFrame: (animationId: string, frameId: string) => void;
  onCopyNextFrame: (animationId: string, frameId: string) => void;
}

// ─── MainWindow ───────────────────────────────────────────────────────────────

export function MainWindow(props: MainWindowProps): React.JSX.Element {
  // Props the menu used to forward to TopBar (`onSave`, `handleUndo`,
  // `handleZoomIn`, …) are gone from this destructure — they live in
  // `menuDeps` now, which `<TopBar />` consumes directly. MainWindow
  // still destructures what it needs for the rest of the layout:
  // dialog state, canvas state, animation playback, layer-panel
  // context, etc.
  const {
    isMac,
    menuDeps,
    activeTool,
    pixelFormat,
    activeLayerId,
    openAdjustmentLayerId,
    swatches,
    canvasWidth,
    canvasHeight,
    zoom,
    tiledMode,
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
    adjustments,
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
    exportableLayers,
    showResizeDialog,
    setShowResizeDialog,
    showResizeCanvasDialog,
    setShowResizeCanvasDialog,
    showRescaleDialog,
    setShowRescaleDialog,
    showRestoreDialog,
    setShowRestoreDialog,
    isRescaling,
    rescaleProgress,
    isAutoMasking,
    isInpainting,
    showLutManager,
    setShowLutManager,
    showColorSettings,
    setShowColorSettings,
    showProofSetup,
    setShowProofSetup,
    onPickProofProfile,
    onClearProofProfile,
    onToggleSimulatePaperColor,
    onToggleGamutWarning,
    showProfileManager,
    setShowProfileManager,
    showImportSpritesheetFramesDialog,
    setShowImportSpritesheetFramesDialog,
    handleImportSpritesheetFrames,
    showExportAnimationFramesDialog,
    setShowExportAnimationFramesDialog,
    handleExportAnimationFrames,
    exportAnimationName,
    exportPaletteGroups,
    exportComputeFrameCount,
    exportDefaultGifFps,
    showAboutDialog,
    setShowAboutDialog,
    showPreferencesDialog,
    setShowPreferencesDialog,
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
    pendingConversion,
    setPendingConversion,
    pendingGuardedAction,
    setPendingGuardedAction,
    handleTransformGuardApply,
    handleTransformGuardDiscard,
    handleNewConfirm,
    handleDuplicateLayer,
    handleRasterizeLayer,
    handleMergeSelected,
    handleMergeDown,
    handleMergeVisible,
    handleFlattenImage,
    handleMergeGroup,
    handleGroupLayers,
    handleUngroupLayers,
    handleCreateCompositeLayer,
    handleRefreshLinkedLayer,
    handleResizeImage,
    handleRescaleImage,
    handleRestoreImage,
    handleResizeCanvas,
    findLayersCounter,
    handleToolChange,
    guardedSwitchTab,
    guardedCloseTab,
    handleCafConfirm,
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
    paletteAnimationActive,
    onCopyPrevFrame,
    onCopyNextFrame,
  } = props;

  return (
    <div className={styles.app}>
      <TopBar
        deps={menuDeps}
        isMac={isMac}
        tiledMode={tiledMode}
        onDebug={() => window.api.openDevTools()}
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
          <ProgressOverlay
            visible={isContentAwareFilling}
            label={contentAwareFillLabel}
            sublabel="Analyzing image…"
          />
          <ProgressOverlay
            visible={isRescaling}
            label={
              rescaleProgress.layerCount > 1
                ? `${rescaleProgress.label} layer ${rescaleProgress.layerIdx} of ${rescaleProgress.layerCount}…`
                : `${rescaleProgress.label} image…`
            }
            sublabel={
              rescaleProgress.tilesTotal > 0
                ? `Tile ${rescaleProgress.tilesLoaded} of ${rescaleProgress.tilesTotal}`
                : "Running model…"
            }
          />
          <ProgressOverlay
            visible={isAutoMasking}
            label="Detecting subject…"
          />
          <ProgressOverlay
            visible={isInpainting}
            label="Removing object…"
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
          onRefreshLinkedLayer={handleRefreshLinkedLayer}
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
          paletteAnimationActive={paletteAnimationActive}
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
          const mask = activeScope().selection.mask;
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
        exportableLayers={exportableLayers}
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
      <RescaleImageDialog
        open={showRescaleDialog}
        currentWidth={canvasWidth}
        currentHeight={canvasHeight}
        onCancel={() => setShowRescaleDialog(false)}
        onConfirm={(s) => {
          setShowRescaleDialog(false);
          void handleRescaleImage(s);
        }}
      />
      <RestoreImageDialog
        open={showRestoreDialog}
        currentWidth={canvasWidth}
        currentHeight={canvasHeight}
        onCancel={() => setShowRestoreDialog(false)}
        onConfirm={(s) => {
          setShowRestoreDialog(false);
          void handleRestoreImage(s);
        }}
      />
      <ImportSpritesheetFramesDialog
        open={showImportSpritesheetFramesDialog}
        canvasWidth={canvasWidth}
        canvasHeight={canvasHeight}
        onCancel={() => setShowImportSpritesheetFramesDialog(false)}
        onConfirm={(r) => {
          handleImportSpritesheetFrames(r);
          setShowImportSpritesheetFramesDialog(false);
        }}
      />
      <ExportAnimationFramesDialog
        open={showExportAnimationFramesDialog}
        animationName={exportAnimationName}
        paletteGroups={exportPaletteGroups}
        computeFrameCount={exportComputeFrameCount}
        defaultGifFps={exportDefaultGifFps}
        onCancel={() => setShowExportAnimationFramesDialog(false)}
        onConfirm={(s, onProgress) =>
          handleExportAnimationFrames(s, onProgress)
        }
      />
      <LutManagerDialog
        open={showLutManager}
        onClose={() => setShowLutManager(false)}
      />
      <ColorSettingsDialog
        open={showColorSettings}
        onClose={() => setShowColorSettings(false)}
      />
      <ProofSetupDialog
        open={showProofSetup}
        onClose={() => setShowProofSetup(false)}
        onPickProofProfile={onPickProofProfile}
        onClearProofProfile={onClearProofProfile}
        onToggleSimulatePaperColor={onToggleSimulatePaperColor}
        onToggleGamutWarning={onToggleGamutWarning}
      />
      <ProfileManagerDialog
        open={showProfileManager}
        onClose={() => setShowProfileManager(false)}
      />
      <ProfilePickerDialog />
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
          onConfirm={(sourceColorSpace) => {
            void colorMode.executeConversion(
              pendingConversion,
              sourceColorSpace,
            );
            setPendingConversion(null);
          }}
          onCancel={() => setPendingConversion(null)}
        />
      )}
    </div>
  );
}
