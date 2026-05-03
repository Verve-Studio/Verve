import { useCallback, useEffect, useRef } from 'react'
import type { AdjustmentType, FilterKey, PixelFormat } from '@/types'
import type { GuidePreset } from './useViewActions'
import { selectionStore } from '@/core/store/selectionStore'
import { ADJUSTMENT_MENU_ITEMS, EFFECTS_MENU_ITEMS, FILTER_MENU_ITEMS } from '@/core/menuConstants'
import { dockStore } from '@/ux/main/RightPanel/Dock/dockStore'
import type { PanelId } from '@/ux/main/RightPanel/Dock/types'

interface MacNativeMenuParams {
  isMac: boolean
  recentFiles: string[]

  // Transform guard
  requireTransformDecision: (action: () => void) => void

  // Adjustment / effect / filter actions
  adjustments: {
    handleCreateAdjustmentLayer: (type: AdjustmentType, params?: Record<string, unknown>) => void
    isAdjustmentMenuEnabled: boolean
  }
  filters: {
    handleInstantFilter: (key: FilterKey) => void
  }
  handleOpenFilterDialog: (key: FilterKey) => void

  // File operations
  handleOpen: () => Promise<void>
  handleOpenPath: (path: string) => Promise<void>
  handleClose: () => void
  handleCloseAll: () => void
  handleSave: (saveAs: boolean) => Promise<void>
  handleSaveACopy: () => Promise<void>
  handleClearRecentFiles: () => Promise<void>

  // Edit operations
  handleUndo: () => void
  handleRedo: () => void
  handleCut: () => void
  handleCopy: () => void
  handleCopyMerged: () => void
  handlePaste: () => void
  handlePasteInto: () => void
  handleDelete: () => void

  // Content-aware fill
  handleOpenCafDialog: (mode: 'fill' | 'delete') => void

  // Layer operations
  handleNewLayer: () => void
  handleDuplicateLayer: () => void
  handleDeleteActiveLayer: () => void
  handleRasterizeLayer: (id: string) => void
  handleGroupLayers: (ids: string[]) => void
  handleUngroupLayers: (id: string) => void
  handleMergeSelected: (ids: string[]) => void
  handleMergeDown: () => void
  handleMergeVisible: () => void
  handleFlattenImage: () => void

  // Canvas transforms
  handleEnterTransform: () => void

  // View actions
  handleZoomIn: () => void
  handleZoomOut: () => void
  handleZoom100: () => void
  handleFitToWindow: () => void
  handleToggleGrid: () => void
  handleToggleRulers: () => void
  handleToggleGuides: () => void
  handleApplyGuidePreset: (preset: GuidePreset) => void
  handleSetNormalMode: () => void
  handleSetTiledMode: () => void
  handleToggleTileGrid: () => void
  handleSelectAll: () => void
  handleDeselect: () => void
  handleSelectAllLayers: () => void
  handleDeselectLayers: () => void
  handleFindLayers: () => void

  // Color mode
  colorMode: { handleConvertColorMode: (fmt: PixelFormat) => void }

  // Dialog openers
  openNewImageDialog: () => void
  openExportDialog: () => void
  openResizeImageDialog: () => void
  openResizeCanvasDialog: () => void
  handleRotate: (amount: import('./useCanvasTransforms').RotateAmount) => Promise<void>
  handleFlip:   (axis:   import('./useCanvasTransforms').FlipAxis)    => Promise<void>
  handleRotateSelectedLayers: (amount: import('./useCanvasTransforms').RotateAmount) => Promise<void>
  handleFlipSelectedLayers:   (axis:   import('./useCanvasTransforms').FlipAxis)    => Promise<void>
  layerArrange: import('./useLayerArrange').UseLayerArrangeReturn
  openAboutDialog: () => void
  openShortcutsDialog: () => void
  openColorDitheringSetup: () => void

  // State for enabled/checked sync
  activeLayerId: string | null
  effectiveSelectedIds: Set<string>
  isFreeTransformEnabled: boolean
  isRasterizeLayerEnabled: boolean
  isMergeSelectedEnabled: boolean
  hasSelection: boolean
  isContentAwareFilling: boolean
  pixelFormat: PixelFormat
  showGrid: boolean
  showRulers: boolean
  showGuides: boolean
  tiledMode: boolean
  showTileGrid: boolean
}

export function useMacNativeMenu(params: MacNativeMenuParams): void {
  const {
    isMac, recentFiles,
    requireTransformDecision, adjustments, filters, handleOpenFilterDialog,
    handleOpen, handleOpenPath, handleClose, handleCloseAll, handleSave, handleSaveACopy,
    handleClearRecentFiles,
    handleUndo, handleRedo, handleCut, handleCopy, handleCopyMerged, handlePaste, handlePasteInto, handleDelete,
    handleOpenCafDialog,
    handleNewLayer, handleDuplicateLayer, handleDeleteActiveLayer,
    handleRasterizeLayer, handleGroupLayers, handleUngroupLayers,
    handleMergeSelected, handleMergeDown, handleMergeVisible, handleFlattenImage,
    handleEnterTransform,
    handleZoomIn, handleZoomOut, handleZoom100, handleFitToWindow, handleToggleGrid,
    handleToggleRulers, handleToggleGuides, handleApplyGuidePreset,
    handleSetNormalMode, handleSetTiledMode, handleToggleTileGrid,
    handleSelectAll, handleDeselect, handleSelectAllLayers, handleDeselectLayers, handleFindLayers,
    colorMode,
    openNewImageDialog, openExportDialog, openResizeImageDialog, openResizeCanvasDialog,
    handleRotate, handleFlip,
    handleRotateSelectedLayers, handleFlipSelectedLayers,
    layerArrange,
    openAboutDialog, openShortcutsDialog, openColorDitheringSetup,
    activeLayerId, effectiveSelectedIds,
    isFreeTransformEnabled, isRasterizeLayerEnabled, isMergeSelectedEnabled,
    hasSelection, isContentAwareFilling,
    pixelFormat, showGrid, showRulers, showGuides, tiledMode, showTileGrid,
  } = params

  // A ref that holds the latest action dispatcher (avoids stale closures in the IPC listener).
  const handlerRef = useRef<(actionId: string) => void>(() => { /* noop until mounted */ })
  handlerRef.current = useCallback((actionId: string): void => {
    // Dynamic: adjustment / effect layers
    if (actionId.startsWith('adj:')) {
      const type = actionId.slice(4) as AdjustmentType
      if (type === 'color-dithering') {
        requireTransformDecision(() => openColorDitheringSetup())
      } else {
        requireTransformDecision(() => adjustments.handleCreateAdjustmentLayer(type))
      }
      return
    }
    // Dynamic: filter layers
    if (actionId.startsWith('filter:')) {
      const key = actionId.slice(7) as FilterKey
      const fi = FILTER_MENU_ITEMS.find(f => f.key === key)
      if (fi?.instant) {
        requireTransformDecision(() => filters.handleInstantFilter(key))
      } else {
        handleOpenFilterDialog(key)
      }
      return
    }
    // Dynamic: recent files
    if (actionId.startsWith('recentFile:')) {
      const idx = parseInt(actionId.slice(11), 10)
      const path = recentFiles[idx]
      if (path) void handleOpenPath(path)
      return
    }
    // Static actions
    switch (actionId) {
      case 'new':              openNewImageDialog(); break
      case 'open':             void handleOpen(); break
      case 'close':            handleClose(); break
      case 'closeAll':         handleCloseAll(); break
      case 'save':             void handleSave(false); break
      case 'saveAs':           void handleSave(true); break
      case 'saveACopy':        void handleSaveACopy(); break
      case 'export':           openExportDialog(); break
      case 'clearRecentFiles': void handleClearRecentFiles(); break
      case 'undo':             handleUndo(); break
      case 'redo':             handleRedo(); break
      case 'cut':              handleCut(); break
      case 'copy':             handleCopy(); break
      case 'copyMerged':       handleCopyMerged(); break
      case 'paste':            handlePaste(); break
      case 'pasteInto':        handlePasteInto(); break
      case 'delete':           handleDelete(); break
      case 'contentAwareFill':    handleOpenCafDialog('fill');   break
      case 'contentAwareDelete':  handleOpenCafDialog('delete'); break
      case 'resizeImage':      openResizeImageDialog(); break
      case 'resizeCanvas':     openResizeCanvasDialog(); break
      case 'rotate90CW':       void handleRotate('90cw');     break
      case 'rotate180CW':      void handleRotate('180');      break
      case 'rotate270CW':      void handleRotate('270cw');    break
      case 'flipHorizontal':   void handleFlip('horizontal'); break
      case 'flipVertical':     void handleFlip('vertical');   break
      case 'layer:rotate90CW':  void handleRotateSelectedLayers('90cw');     break
      case 'layer:rotate180CW': void handleRotateSelectedLayers('180');      break
      case 'layer:rotate270CW': void handleRotateSelectedLayers('270cw');    break
      case 'layer:flipHorizontal': void handleFlipSelectedLayers('horizontal'); break
      case 'layer:flipVertical':   void handleFlipSelectedLayers('vertical');   break
      case 'layer:alignLeft':     layerArrange.handleAlign('left');     break
      case 'layer:alignCenterV':  layerArrange.handleAlign('centerV');  break
      case 'layer:alignRight':    layerArrange.handleAlign('right');    break
      case 'layer:alignTop':      layerArrange.handleAlign('top');      break
      case 'layer:alignCenterH':  layerArrange.handleAlign('centerH'); break
      case 'layer:alignBottom':   layerArrange.handleAlign('bottom');   break
      case 'layer:distributeH':   layerArrange.handleDistribute('horizontal'); break
      case 'layer:distributeV':   layerArrange.handleDistribute('vertical');   break
      case 'layer:orderFront':    layerArrange.handleOrder('front');    break
      case 'layer:orderBack':     layerArrange.handleOrder('back');     break
      case 'layer:orderForward':  layerArrange.handleOrder('forward');  break
      case 'layer:orderBackward': layerArrange.handleOrder('backward'); break
      case 'layer:orderReverse':  layerArrange.handleOrder('reverse');  break
      case 'freeTransform':    requireTransformDecision(handleEnterTransform); break
      case 'invertSelection':  selectionStore.invert(); break
      case 'selectAll':        handleSelectAll(); break
      case 'deselect':         handleDeselect(); break
      case 'selectAllLayers':  handleSelectAllLayers(); break
      case 'deselectLayers':   handleDeselectLayers(); break
      case 'findLayers':       handleFindLayers(); break
      case 'newLayer':         handleNewLayer(); break
      case 'duplicateLayer':   handleDuplicateLayer(); break
      case 'deleteLayer':      handleDeleteActiveLayer(); break
      case 'rasterizeLayer':   activeLayerId && handleRasterizeLayer(activeLayerId); break
      case 'groupLayers':      handleGroupLayers([...effectiveSelectedIds]); break
      case 'ungroupLayers':    activeLayerId && handleUngroupLayers(activeLayerId); break
      case 'mergeSelected':    handleMergeSelected([...effectiveSelectedIds]); break
      case 'mergeDown':        handleMergeDown(); break
      case 'mergeVisible':     handleMergeVisible(); break
      case 'flattenImage':     handleFlattenImage(); break
      case 'zoomIn':           handleZoomIn(); break
      case 'zoomOut':          handleZoomOut(); break
      case 'zoom100':          handleZoom100(); break
      case 'fitToWindow':      handleFitToWindow(); break
      case 'toggleGrid':       handleToggleGrid(); break
      case 'toggleRulers':     handleToggleRulers(); break
      case 'toggleGuides':          handleToggleGuides(); break
      case 'guidePreset:thirds':     handleApplyGuidePreset('thirds'); break
      case 'guidePreset:fourths':    handleApplyGuidePreset('fourths'); break
      case 'guidePreset:center-split': handleApplyGuidePreset('center-split'); break
      case 'guidePreset:safe-zone':  handleApplyGuidePreset('safe-zone'); break
      case 'setNormalMode':    handleSetNormalMode(); break
      case 'setTiledMode':     handleSetTiledMode(); break
      case 'toggleTileGrid':   handleToggleTileGrid(); break
      case 'about':            openAboutDialog(); break
      case 'keyboardShortcuts': openShortcutsDialog(); break
      case 'colorMode:rgba8':    colorMode.handleConvertColorMode('rgba8');    break
      case 'colorMode:rgba32f':  colorMode.handleConvertColorMode('rgba32f');  break
      case 'colorMode:indexed8': colorMode.handleConvertColorMode('indexed8'); break
      case 'openDevTools':     window.api.openDevTools(); break
      default: {
        if (actionId.startsWith('togglePanel:')) {
          dockStore.togglePanel(actionId.slice('togglePanel:'.length) as PanelId)
        } else if (actionId === 'resetPanelLayout') {
          dockStore.resetLayout()
        }
      }
    }
  }, [
    requireTransformDecision, adjustments, filters, handleOpenFilterDialog,
    handleOpen, handleOpenPath, handleClose, handleCloseAll, handleSave, handleSaveACopy,
    handleClearRecentFiles, recentFiles,
    handleUndo, handleRedo, handleCut, handleCopy, handlePaste, handlePasteInto, handleDelete,
    handleNewLayer, handleDuplicateLayer, handleDeleteActiveLayer,
    handleRasterizeLayer, handleGroupLayers, handleUngroupLayers, handleMergeSelected,
    handleMergeDown, handleMergeVisible, handleFlattenImage, handleZoomIn, handleZoomOut,
    handleZoom100, handleFitToWindow, handleToggleGrid, handleToggleRulers, handleToggleGuides, handleApplyGuidePreset, handleEnterTransform,
    handleSetNormalMode, handleSetTiledMode, handleToggleTileGrid,
    handleSelectAll, handleDeselect, handleSelectAllLayers, handleDeselectLayers, handleFindLayers,
    handleOpenCafDialog,
    openNewImageDialog, openExportDialog, openResizeImageDialog, openResizeCanvasDialog,
    handleRotate, handleFlip,
    openAboutDialog, openShortcutsDialog, openColorDitheringSetup,
    activeLayerId, effectiveSelectedIds,
    colorMode,
  ])

  // Build the native menu once on mount (sends the dynamic items list to the main process).
  useEffect(() => {
    if (!isMac) return
    window.api.buildNativeMenu({
      adjustments: ADJUSTMENT_MENU_ITEMS.map(i => ({ id: i.type, label: i.label, group: i.group })),
      effects:     EFFECTS_MENU_ITEMS.map(i => ({ id: i.type, label: i.label, group: i.group })),
      filters:     FILTER_MENU_ITEMS.map(i => ({ id: i.key, label: i.label, group: i.group })),
      recentFiles,
    })
  }, [isMac, recentFiles])

  // Register the IPC action listener once. Handler is always fresh via the ref.
  useEffect(() => {
    if (!isMac) return
    const cleanup = window.api.onMenuAction((actionId) => handlerRef.current(actionId))
    return cleanup
  }, [isMac])

  // Sync enabled/disabled state of native menu items when app state changes.
  useEffect(() => {
    if (!isMac) return
    const { isAdjustmentMenuEnabled } = adjustments
    const enabled: Record<string, boolean> = {
      freeTransform:      isFreeTransformEnabled,
      rasterizeLayer:     isRasterizeLayerEnabled,
      mergeSelected:      isMergeSelectedEnabled,
      contentAwareFill:   hasSelection && !isContentAwareFilling,
      contentAwareDelete: hasSelection && !isContentAwareFilling,
    }
    for (const ai of ADJUSTMENT_MENU_ITEMS) enabled[`adj:${ai.type}`]   = isAdjustmentMenuEnabled && !(ai.type === 'reduce-colors' && pixelFormat !== 'rgba8')
    for (const ei of EFFECTS_MENU_ITEMS)    enabled[`adj:${ei.type}`]   = isAdjustmentMenuEnabled
    for (const fi of FILTER_MENU_ITEMS)     enabled[`filter:${fi.key}`] = isAdjustmentMenuEnabled
    window.api.setMenuItemEnabled(enabled)
  }, [isMac, isFreeTransformEnabled, isRasterizeLayerEnabled, isMergeSelectedEnabled,
      hasSelection, isContentAwareFilling, adjustments, pixelFormat])

  // Sync Show Grid and tiled mode checkbox states.
  useEffect(() => {
    if (!isMac) return
    window.api.setMenuItemChecked({
      toggleGrid:   showGrid,
      toggleRulers: showRulers,
      toggleGuides: showGuides,
      normalMode:   !tiledMode,
      tiledMode:    tiledMode,
      showTileGrid: showTileGrid,
    })
  }, [isMac, showGrid, showRulers, showGuides, tiledMode, showTileGrid])

  // Sync panel open/closed states to native menu checkboxes.
  useEffect(() => {
    if (!isMac) return
    const sync = () => {
      const openIds = dockStore.openPanelIds
      const panels: PanelId[] = ['Color', 'Swatches', 'Navigator', 'Layers', 'History', 'Info']
      const updates: Record<string, boolean> = {}
      for (const id of panels) {
        updates[`togglePanel:${id}`] = openIds.includes(id)
      }
      window.api.setMenuItemChecked(updates)
    }
    sync()
    return dockStore.subscribe(sync)
  }, [isMac])
}
