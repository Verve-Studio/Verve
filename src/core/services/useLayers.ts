import type { AppAction } from '@/core/store/AppContext'
import type { AppState, LayerState, PixelLayerState } from '@/types'
import { showOperationError } from '@/utils/userFeedback'
import type { CanvasHandle } from '@/ux/main/Canvas/Canvas'
import { matchPaletteIndices } from '@/wasm'
import type { Dispatch, MutableRefObject } from 'react'
import { useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseLayersOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null }
  stateRef: MutableRefObject<AppState>
  captureHistory: (label: string) => void
  dispatch: Dispatch<AppAction>
  pendingLayerLabelRef: MutableRefObject<string | null>
}

export interface UseLayersReturn {
  handleMergeSelected:    (ids: string[]) => void
  handleMergeDown:        () => void
  handleMergeVisible:     () => void
  handleNewLayer:         () => void
  handleDuplicateLayer:   () => void
  handleDeleteActiveLayer: () => void
  handleFlattenImage:     () => void
  handleRasterizeLayer:   (layerId: string) => void
}

function isPixelRootLayer(layer: LayerState): boolean {
  if (!('type' in layer)) return true                           // plain pixel layer
  return layer.type === 'text' || layer.type === 'shape'        // rasterisable root layers
}

function expandMergeLayerIds(
  layers: readonly LayerState[],
  rootIds: ReadonlySet<string>,
): Set<string> {
  const mergeIds = new Set<string>(rootIds)
  for (const layer of layers) {
    if (
      'type' in layer &&
      (layer.type === 'mask' || layer.type === 'adjustment') &&
      rootIds.has(layer.parentId)
    ) {
      mergeIds.add(layer.id)
    }
  }
  return mergeIds
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useLayers({
  canvasHandleRef,
  stateRef,
  captureHistory,
  dispatch,
  pendingLayerLabelRef,
}: UseLayersOptions): UseLayersReturn {

  const handleMergeSelected = useCallback(async (ids: string[]): Promise<void> => {
    try {
      const handle = canvasHandleRef.current
      if (ids.length < 2 || !handle) return
      const layers = stateRef.current.layers
      const selectedSet = new Set(ids)
      const selectedRoots = layers.filter(l => selectedSet.has(l.id) && isPixelRootLayer(l))
      if (selectedRoots.length < 2) return

      const rootIds = new Set(selectedRoots.map(l => l.id))
      const mergeIds = expandMergeLayerIds(layers, rootIds)
      const mergeLayers = layers.filter(l => mergeIds.has(l.id))
      const merged = (await handle.rasterizeLayers(mergeLayers, 'merge')).data
      captureHistory('Merge Layers')

      const topIdx = layers.findLastIndex(l => rootIds.has(l.id))
      const mergedName = selectedRoots[selectedRoots.length - 1].name
      const newId = `layer-${Date.now()}`
      const { pixelFormat, swatches } = stateRef.current
      if (pixelFormat === 'indexed8') {
        const indexData = await matchPaletteIndices(merged as Uint8Array, swatches, 255)
        handle.prepareNewLayerIndexed(newId, mergedName, indexData)
      } else {
        handle.prepareNewLayer(newId, mergedName, merged as Uint8Array)
      }

      const newLayers: LayerState[] = []
      for (let i = 0; i < layers.length; i++) {
        const l = layers[i]
        if (i === topIdx) newLayers.push({ id: newId, name: mergedName, visible: true, opacity: 1, locked: false, blendMode: 'normal' })
        if (!mergeIds.has(l.id)) newLayers.push(l)
      }
      dispatch({ type: 'REORDER_LAYERS', payload: newLayers })
      dispatch({ type: 'SET_ACTIVE_LAYER', payload: newId })
    } catch (error) {
      console.error('[useLayers] Merge selected failed:', error)
      showOperationError('Merge selected failed.', error)
    }
  }, [canvasHandleRef, stateRef, captureHistory, dispatch])

  const handleMergeDown = useCallback(async (): Promise<void> => {
    try {
      const layers = stateRef.current.layers
      const activeLayerId = stateRef.current.activeLayerId
      const handle = canvasHandleRef.current
      if (!handle || !activeLayerId) return

      const activeMeta = layers.find(l => l.id === activeLayerId)
      if (!activeMeta || !isPixelRootLayer(activeMeta)) return

      const pixelRoots = layers.filter(isPixelRootLayer)
      const activeIdx = pixelRoots.findIndex(l => l.id === activeLayerId)
      if (activeIdx <= 0) return

      const mergeRoots = pixelRoots.slice(0, activeIdx + 1)
      const rootIds = new Set(mergeRoots.map(l => l.id))
      const mergeIds = expandMergeLayerIds(layers, rootIds)
      const mergeLayers = layers.filter(l => mergeIds.has(l.id))
      const merged = (await handle.rasterizeLayers(mergeLayers, 'merge')).data
      captureHistory('Merge Down')

      const newId = `layer-${Date.now()}`
      const mergedName = pixelRoots[0].name
      const { pixelFormat, swatches } = stateRef.current
      if (pixelFormat === 'indexed8') {
        const indexData = await matchPaletteIndices(merged as Uint8Array, swatches, 255)
        handle.prepareNewLayerIndexed(newId, mergedName, indexData)
      } else {
        handle.prepareNewLayer(newId, mergedName, merged as Uint8Array)
      }

      const newLayers: LayerState[] = []
      let insertedMerged = false
      for (const l of layers) {
        if (mergeIds.has(l.id)) {
          if (!insertedMerged) {
            newLayers.push({ id: newId, name: mergedName, visible: true, opacity: 1, locked: false, blendMode: 'normal' })
            insertedMerged = true
          }
          continue
        }
        newLayers.push(l)
      }
      dispatch({ type: 'REORDER_LAYERS', payload: newLayers })
      dispatch({ type: 'SET_ACTIVE_LAYER', payload: newId })
    } catch (error) {
      console.error('[useLayers] Merge down failed:', error)
      showOperationError('Merge down failed.', error)
    }
  }, [canvasHandleRef, stateRef, captureHistory, dispatch])

  const handleMergeVisible = useCallback(async (): Promise<void> => {
    try {
      const layers = stateRef.current.layers
      const handle = canvasHandleRef.current
      if (!handle) return

      const visibleRoots = layers.filter(l => l.visible && isPixelRootLayer(l))
      if (visibleRoots.length < 2) return

      const rootIds = new Set(visibleRoots.map(l => l.id))
      const mergeIds = expandMergeLayerIds(layers, rootIds)
      const mergeLayers = layers.filter(l => mergeIds.has(l.id))
      const merged = (await handle.rasterizeLayers(mergeLayers, 'merge')).data
      captureHistory('Merge Visible')

      const topIdx = layers.findLastIndex(l => rootIds.has(l.id))
      const newId = `layer-${Date.now()}`
      const { pixelFormat, swatches } = stateRef.current
      if (pixelFormat === 'indexed8') {
        const indexData = await matchPaletteIndices(merged as Uint8Array, swatches, 255)
        handle.prepareNewLayerIndexed(newId, 'Merged', indexData)
      } else {
        handle.prepareNewLayer(newId, 'Merged', merged as Uint8Array)
      }

      const newLayers: LayerState[] = []
      for (let i = 0; i < layers.length; i++) {
        const l = layers[i]
        if (i === topIdx) newLayers.push({ id: newId, name: 'Merged', visible: true, opacity: 1, locked: false, blendMode: 'normal' })
        if (!mergeIds.has(l.id)) newLayers.push(l)
      }
      dispatch({ type: 'REORDER_LAYERS', payload: newLayers })
      dispatch({ type: 'SET_ACTIVE_LAYER', payload: newId })
    } catch (error) {
      console.error('[useLayers] Merge visible failed:', error)
      showOperationError('Merge visible failed.', error)
    }
  }, [canvasHandleRef, stateRef, captureHistory, dispatch])

  const handleNewLayer = useCallback((): void => {
    const id = `layer-${Date.now()}`
    pendingLayerLabelRef.current = 'New Layer'
    dispatch({
      type: 'ADD_LAYER',
      payload: { id, name: `Layer ${stateRef.current.layers.length + 1}`, visible: true, opacity: 1, locked: false, blendMode: 'normal' },
    })
  }, [dispatch, stateRef, pendingLayerLabelRef])

  const handleDuplicateLayer = useCallback((): void => {
    const { activeLayerId, layers } = stateRef.current
    if (!activeLayerId || !canvasHandleRef.current) return
    const src    = layers.find(l => l.id === activeLayerId)
    if (!src) return
    const pixels = canvasHandleRef.current.getLayerPixels(src.id)
    if (!pixels) return
    const newId  = `layer-${Date.now()}`
    const name   = `${src.name} copy`
    canvasHandleRef.current.prepareNewLayer(newId, name, pixels)
    pendingLayerLabelRef.current = 'Duplicate Layer'
    dispatch({ type: 'ADD_LAYER', payload: { ...src, id: newId, name } })
  }, [dispatch, stateRef, canvasHandleRef, pendingLayerLabelRef])

  const handleDeleteActiveLayer = useCallback((): void => {
    const id = stateRef.current.activeLayerId
    if (id) dispatch({ type: 'REMOVE_LAYER', payload: id })
  }, [dispatch, stateRef])

  const handleFlattenImage = useCallback(async (): Promise<void> => {
    const layers    = stateRef.current.layers
    const pxLayers  = layers.filter(l => !('type' in l && l.type === 'mask'))
    if (pxLayers.length < 2) return
    try {
      const handle = canvasHandleRef.current
      if (!handle) throw new Error('Canvas renderer is not ready yet. Please try flattening again.')
      const flat = await handle.rasterizeComposite('flatten')
      captureHistory('Flatten Image')
      const merged = flat.data
      const newId  = `layer-${Date.now()}`
      const { pixelFormat, swatches } = stateRef.current
      if (pixelFormat === 'indexed8') {
        const indexData = await matchPaletteIndices(merged as Uint8Array, swatches, 255)
        handle.prepareNewLayerIndexed(newId, 'Background', indexData)
      } else {
        handle.prepareNewLayer(newId, 'Background', merged as Uint8Array)
      }
      dispatch({ type: 'REORDER_LAYERS', payload: [{ id: newId, name: 'Background', visible: true, opacity: 1, locked: false, blendMode: 'normal' }] })
      dispatch({ type: 'SET_ACTIVE_LAYER', payload: newId })
    } catch (error) {
      console.error('[useLayers] Flatten failed:', error)
      showOperationError('Flatten image failed.', error)
    }
  }, [canvasHandleRef, stateRef, captureHistory, dispatch])

  const handleRasterizeLayer = useCallback(async (layerId: string): Promise<void> => {
    try {
      const handle = canvasHandleRef.current
      const layers = stateRef.current.layers
      if (!handle) return

      const layer = layers.find(l => l.id === layerId)
      if (!layer) return
      if ('type' in layer && (layer.type === 'mask' || layer.type === 'adjustment')) return

      // Collect the root layer + all its child mask/adjustment layers
      const childLayers = layers.filter(
        l => 'type' in l && (l.type === 'mask' || l.type === 'adjustment') &&
          (l as { parentId: string }).parentId === layerId
      )
      const targetLayers: LayerState[] = [layer, ...childLayers]

      const result = await handle.rasterizeLayers(targetLayers, 'merge')
      captureHistory('Rasterize Layer')

      const newId = `layer-${Date.now()}`
      const childIds = new Set(childLayers.map(l => l.id))

      // Preserve opacity + blend mode from the source layer (pixel/text/shape all have these)
      const src = layer as PixelLayerState
      const newPixelLayer: PixelLayerState = {
        id: newId,
        name: src.name,
        visible: src.visible,
        opacity: src.opacity,
        locked: src.locked,
        blendMode: src.blendMode,
      }

      handle.prepareNewLayer(newId, src.name, result.data as Uint8Array)

      const newLayers = layers
        .map(l => (l.id === layerId ? newPixelLayer : l))
        .filter(l => !childIds.has(l.id))

      dispatch({ type: 'REORDER_LAYERS', payload: newLayers })
      dispatch({ type: 'SET_ACTIVE_LAYER', payload: newId })
    } catch (error) {
      console.error('[useLayers] Rasterize layer failed:', error)
      showOperationError('Rasterize layer failed.', error)
    }
  }, [canvasHandleRef, stateRef, captureHistory, dispatch])

  return {
    handleMergeSelected, handleMergeDown, handleMergeVisible,
    handleNewLayer, handleDuplicateLayer, handleDeleteActiveLayer,
    handleFlattenImage, handleRasterizeLayer,
  }
}
