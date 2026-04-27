import { useCallback, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { cloneHistoryEntries, historyStore } from '@/core/store/historyStore'
import { IMAGE_EXTENSIONS, EXT_TO_MIME, loadImagePixels } from '@/core/io/imageLoader'
import { makeTabId, fileTitle, DEFAULT_SWATCHES } from '@/core/store/tabTypes'
import type { TabRecord, TabSnapshot } from '@/core/store/tabTypes'
import type { LayerState, BackgroundFill, AppState, SwatchGroup, PixelBrush } from '@/types'
import type { AppAction } from '@/core/store/AppContext'
import type { CanvasHandle } from '@/ux/main/Canvas/Canvas'
import { showOperationError } from '@/utils/userFeedback'

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseFileOpsOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null }
  state: AppState
  tabs: TabRecord[]
  activeTabId: string
  setTabs: Dispatch<SetStateAction<TabRecord[]>>
  setActiveTabId: Dispatch<SetStateAction<string>>
  setPendingLayerData: Dispatch<SetStateAction<Map<string, string> | null>>
  captureActiveSnapshot: () => TabSnapshot
  serializeActiveTabPixels: () => Map<string, string> | null
  handleSwitchTab: (toId: string) => void
  dispatch: Dispatch<AppAction>
  onRecentFilesUpdated?: (files: string[]) => void
}

export interface UseFileOpsReturn {
  untitledCounter: number
  handleNewConfirm: (settings: { width: number; height: number; backgroundFill: BackgroundFill }) => void
  handleOpen: () => Promise<void>
  handleOpenPath: (path: string) => Promise<void>
  handleSave: (saveAs?: boolean) => Promise<void>
  handleSaveACopy: () => Promise<void>
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isValidSwatchArray(val: unknown): val is { r: number; g: number; b: number; a: number }[] {
  if (!Array.isArray(val)) return false
  for (const item of val) {
    if (typeof item !== 'object' || item === null) return false
    const { r, g, b, a } = item as Record<string, unknown>
    if (
      !Number.isInteger(r) || (r as number) < 0 || (r as number) > 255 ||
      !Number.isInteger(g) || (g as number) < 0 || (g as number) > 255 ||
      !Number.isInteger(b) || (b as number) < 0 || (b as number) > 255 ||
      !Number.isInteger(a) || (a as number) < 0 || (a as number) > 255
    ) return false
  }
  return true
}

function isValidSwatchGroupsArray(
  val: unknown,
  swatchCount: number,
): val is SwatchGroup[] {
  if (!Array.isArray(val)) return false
  const names = new Set<string>()
  for (const item of val) {
    if (typeof item !== 'object' || item === null) return false
    const { id, name, swatchIndices } = item as Record<string, unknown>
    if (typeof id !== 'string' || id === '') return false
    if (typeof name !== 'string' || name === '') return false
    if (names.has(name)) return false
    names.add(name)
    if (!Array.isArray(swatchIndices)) return false
    for (const idx of swatchIndices) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= swatchCount) return false
    }
  }
  return true
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useFileOps({
  canvasHandleRef,
  state,
  tabs,
  activeTabId,
  setTabs,
  setActiveTabId,
  setPendingLayerData,
  captureActiveSnapshot,
  serializeActiveTabPixels,
  handleSwitchTab,
  dispatch,
  onRecentFilesUpdated,
}: UseFileOpsOptions): UseFileOpsReturn {
  const [untitledCounter, setUntitledCounter] = useState(1)

  const handleNewConfirm = useCallback(({ width, height, backgroundFill }: { width: number; height: number; backgroundFill: BackgroundFill }): void => {
    const snapshot        = captureActiveSnapshot()
    const savedHistory    = { entries: cloneHistoryEntries(historyStore.entries), currentIndex: historyStore.currentIndex }
    const savedLayerData  = serializeActiveTabPixels()
    const n               = untitledCounter
    setUntitledCounter(n + 1)
    const newId: string = makeTabId()
    const newSnapshot: TabSnapshot = {
      canvasWidth: width, canvasHeight: height, backgroundFill,
      layers: [{ id: 'layer-0', name: 'Background', visible: true, opacity: 1, locked: false, blendMode: 'normal' }],
      activeLayerId: 'layer-0', zoom: 1,
      swatches: DEFAULT_SWATCHES,
      swatchGroups: [],
      pixelBrushes: [],
    }
    const updated: TabRecord[] = [
      ...tabs.map(t => t.id === activeTabId ? { ...t, snapshot, savedHistory, savedLayerData } : t),
      { id: newId, title: `Untitled-${n + 1}`, filePath: null, snapshot: newSnapshot, savedLayerData: null, savedHistory: null, canvasKey: 1, tiledMode: false, showTileGrid: false },
    ]
    setTabs(updated)
    setActiveTabId(newId)
    historyStore.clear({ recaptureSnapshot: false })
    setPendingLayerData(null)
    dispatch({ type: 'NEW_CANVAS', payload: { width, height, backgroundFill } })
  }, [tabs, activeTabId, untitledCounter, captureActiveSnapshot, serializeActiveTabPixels, dispatch, setTabs, setActiveTabId, setPendingLayerData])

  const openFromPath = useCallback(async (path: string): Promise<void> => {
    // ── Image file import ──────────────────────────────────────────────────
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
    if (IMAGE_EXTENSIONS.has(ext)) {
      const base64            = await window.api.readFileBase64(path)
      const mime              = EXT_TO_MIME[ext] ?? 'image/png'
      const { data, width, height } = await loadImagePixels(`data:${mime};base64,${base64}`)
      const layerId           = 'layer-0'
      const tmp               = document.createElement('canvas')
      tmp.width = width; tmp.height = height
      const ctx2d             = tmp.getContext('2d')!
      ctx2d.putImageData(new ImageData(new Uint8ClampedArray(data.buffer as ArrayBuffer), width, height), 0, 0)
      const layerData         = new Map([[layerId, tmp.toDataURL('image/png')]])
      const layers: LayerState[] = [{ id: layerId, name: 'Background', visible: true, opacity: 1, locked: false, blendMode: 'normal' }]
      const title             = fileTitle(path)
      const newSnapshot: TabSnapshot = {
        canvasWidth: width, canvasHeight: height, backgroundFill: 'transparent',
        layers, activeLayerId: layerId, zoom: 1,
        swatches: DEFAULT_SWATCHES,
        swatchGroups: [],
        pixelBrushes: [],
      }
      const snapshot      = captureActiveSnapshot()
      const savedHistory   = { entries: cloneHistoryEntries(historyStore.entries), currentIndex: historyStore.currentIndex }
      const savedLayerData = serializeActiveTabPixels()
      const newId          = makeTabId()
      const updated: TabRecord[] = [
        ...tabs.map(t => t.id === activeTabId ? { ...t, snapshot, savedHistory, savedLayerData } : t),
        { id: newId, title, filePath: null, snapshot: newSnapshot, savedLayerData: layerData, savedHistory: null, canvasKey: 1, tiledMode: false, showTileGrid: false },
      ]
      setTabs(updated)
      setActiveTabId(newId)
      historyStore.clear({ recaptureSnapshot: false })
      setPendingLayerData(null)
      dispatch({ type: 'SWITCH_TAB', payload: { width, height, backgroundFill: 'transparent', layers, activeLayerId: layerId, zoom: 1, tiledMode: false, showTileGrid: false } })
      const updatedRecent = await window.api.addRecentFile(path)
      onRecentFilesUpdated?.(updatedRecent)
      return
    }

    // Already open? Just switch.
    const existing = tabs.find(t => t.filePath === path)
    if (existing) { handleSwitchTab(existing.id); return }

    // ── .pxshop file ──────────────────────────────────────────────────────
    const json = await window.api.openPxshopFile(path)
    const doc  = JSON.parse(json) as {
      version: number
      canvas: { width: number; height: number; backgroundFill?: BackgroundFill }
      activeLayerId: string | null
      layers: Array<LayerState & {
        pngData?: string | null
        layerGeo?: { layerWidth: number; layerHeight: number; offsetX: number; offsetY: number } | null
        adjustmentMaskPng?: string | null
      }>
      swatches?: unknown
      swatchGroups?: unknown
      pixelBrushes?: unknown
    }

    const layerData = new Map<string, string>()
    const layers: LayerState[] = doc.layers.map(({ pngData, layerGeo, adjustmentMaskPng, ...meta }) => {
      if (pngData)  layerData.set(meta.id, pngData)
      if (layerGeo) layerData.set(`${meta.id}:geo`, JSON.stringify(layerGeo))
      if (adjustmentMaskPng) layerData.set(`${meta.id}:adjustment-mask`, adjustmentMaskPng)
      return meta as LayerState
    })
    const title       = fileTitle(path)
    const bg          = doc.canvas.backgroundFill ?? 'transparent'
    if (doc.version >= 2) {
      if (!isValidSwatchArray(doc.swatches)) {
        showOperationError('Could not open file.', 'The file contains invalid swatch data.')
        return
      }
    }
    const docSwatches = doc.version >= 2
      ? (doc.swatches as { r: number; g: number; b: number; a: number }[])
      : DEFAULT_SWATCHES
    let docSwatchGroups: SwatchGroup[] = []
    if (doc.version >= 3) {
      if (!isValidSwatchGroupsArray(doc.swatchGroups, docSwatches.length)) {
        showOperationError('Could not open file.', 'The file contains invalid swatch group data.')
        return
      }
      docSwatchGroups = doc.swatchGroups as SwatchGroup[]
    }
    let docPixelBrushes: PixelBrush[] = []
    if (doc.version >= 4 && Array.isArray(doc.pixelBrushes)) {
      docPixelBrushes = doc.pixelBrushes as PixelBrush[]
    }
    const newSnapshot: TabSnapshot = {
      canvasWidth: doc.canvas.width, canvasHeight: doc.canvas.height, backgroundFill: bg,
      layers, activeLayerId: doc.activeLayerId ?? layers[0]?.id ?? null, zoom: 1,
      swatches: docSwatches,
      swatchGroups: docSwatchGroups,
      pixelBrushes: docPixelBrushes,
    }
    const snapshot      = captureActiveSnapshot()
    const savedHistory   = { entries: cloneHistoryEntries(historyStore.entries), currentIndex: historyStore.currentIndex }
    const savedLayerData = serializeActiveTabPixels()
    const newId          = makeTabId()
    const updated: TabRecord[] = [
      ...tabs.map(t => t.id === activeTabId ? { ...t, snapshot, savedHistory, savedLayerData } : t),
      { id: newId, title, filePath: path, snapshot: newSnapshot, savedLayerData: layerData, savedHistory: null, canvasKey: 1, tiledMode: false, showTileGrid: false },
    ]
    setTabs(updated)
    setActiveTabId(newId)
    historyStore.clear({ recaptureSnapshot: false })
    setPendingLayerData(null)
    dispatch({ type: 'SWITCH_TAB', payload: { width: doc.canvas.width, height: doc.canvas.height, backgroundFill: bg, layers, activeLayerId: newSnapshot.activeLayerId, zoom: 1, tiledMode: false, showTileGrid: false } })
    dispatch({ type: 'SET_SWATCHES', payload: docSwatches })
    dispatch({ type: 'SET_SWATCH_GROUPS', payload: docSwatchGroups })
    dispatch({ type: 'SET_PIXEL_BRUSHES', payload: docPixelBrushes })
    const updated2 = await window.api.addRecentFile(path)
    onRecentFilesUpdated?.(updated2)
  }, [tabs, activeTabId, captureActiveSnapshot, serializeActiveTabPixels, handleSwitchTab, dispatch, setTabs, setActiveTabId, setPendingLayerData, onRecentFilesUpdated])

  const handleOpen = useCallback(async (): Promise<void> => {
    const path = await window.api.openPxshopDialog()
    if (!path) return
    await openFromPath(path)
  }, [openFromPath])

  const handleOpenPath = useCallback(async (path: string): Promise<void> => {
    await openFromPath(path)
  }, [openFromPath])

  const handleSave = useCallback(async (saveAs = false): Promise<void> => {
    const activeTab = tabs.find(t => t.id === activeTabId)
    let path        = saveAs ? null : (activeTab?.filePath ?? null)
    if (!path) {
      path = await window.api.savePxshopDialog(activeTab?.filePath ?? undefined)
      if (!path) return
    }

    const layerPngs: Record<string, string>  = {}
    const adjustmentMaskPngs: Record<string, string> = {}
    const layerGeos: Record<string, { layerWidth: number; layerHeight: number; offsetX: number; offsetY: number }> = {}
    for (const layer of state.layers) {
      const result = canvasHandleRef.current?.exportLayerPng(layer.id)
      if (result) {
        layerPngs[layer.id] = result.png
        layerGeos[layer.id] = { layerWidth: result.layerWidth, layerHeight: result.layerHeight, offsetX: result.offsetX, offsetY: result.offsetY }
      }
      if ('type' in layer && layer.type === 'adjustment') {
        const maskPng = canvasHandleRef.current?.exportAdjustmentMaskPng(layer.id)
        if (maskPng) adjustmentMaskPngs[layer.id] = maskPng
      }
    }
    const doc = {
      version: 4,
      canvas: { width: state.canvas.width, height: state.canvas.height, backgroundFill: state.canvas.backgroundFill },
      activeLayerId: state.activeLayerId,
      layers: state.layers.map(l => ({
        ...l,
        pngData: layerPngs[l.id] ?? null,
        layerGeo: layerGeos[l.id] ?? null,
        adjustmentMaskPng: adjustmentMaskPngs[l.id] ?? null,
      })),
      swatches: state.swatches,
      swatchGroups: state.swatchGroups,
      pixelBrushes: state.pixelBrushes,
    }
    await window.api.savePxshopFile(path, JSON.stringify(doc))
    const savedPath = path
    const title     = fileTitle(savedPath)
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, filePath: savedPath, title } : t))
    const updated = await window.api.addRecentFile(savedPath)
    onRecentFilesUpdated?.(updated)
  }, [tabs, activeTabId, state, canvasHandleRef, setTabs, onRecentFilesUpdated])

  const handleSaveACopy = useCallback(async (): Promise<void> => {
    const activeTab = tabs.find(t => t.id === activeTabId)
    const path = await window.api.savePxshopDialog(activeTab?.filePath ?? undefined)
    if (!path) return

    const layerPngs: Record<string, string>  = {}
    const adjustmentMaskPngs: Record<string, string> = {}
    const layerGeos: Record<string, { layerWidth: number; layerHeight: number; offsetX: number; offsetY: number }> = {}
    for (const layer of state.layers) {
      const result = canvasHandleRef.current?.exportLayerPng(layer.id)
      if (result) {
        layerPngs[layer.id] = result.png
        layerGeos[layer.id] = { layerWidth: result.layerWidth, layerHeight: result.layerHeight, offsetX: result.offsetX, offsetY: result.offsetY }
      }
      if ('type' in layer && layer.type === 'adjustment') {
        const maskPng = canvasHandleRef.current?.exportAdjustmentMaskPng(layer.id)
        if (maskPng) adjustmentMaskPngs[layer.id] = maskPng
      }
    }
    const doc = {
      version: 4,
      canvas: { width: state.canvas.width, height: state.canvas.height, backgroundFill: state.canvas.backgroundFill },
      activeLayerId: state.activeLayerId,
      layers: state.layers.map(l => ({
        ...l,
        pngData: layerPngs[l.id] ?? null,
        layerGeo: layerGeos[l.id] ?? null,
        adjustmentMaskPng: adjustmentMaskPngs[l.id] ?? null,
      })),
      swatches: state.swatches,
      swatchGroups: state.swatchGroups,
      pixelBrushes: state.pixelBrushes,
    }
    await window.api.savePxshopFile(path, JSON.stringify(doc))
    // The current tab's filePath is NOT updated — this is a copy.
  }, [tabs, activeTabId, state, canvasHandleRef])

  return { untitledCounter, handleNewConfirm, handleOpen, handleOpenPath, handleSave, handleSaveACopy }
}
