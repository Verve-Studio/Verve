import { useCallback, useState } from 'react'
import type { Dispatch, MutableRefObject } from 'react'
import type { AppAction } from '@/core/store/AppContext'
import type { AppState } from '@/types'
import type { CanvasHandle } from '@/ux/main/Canvas/Canvas'
import { selectionStore } from '@/core/store/selectionStore'

interface ViewActionsParams {
  dispatch: Dispatch<AppAction>
  stateRef: MutableRefObject<AppState>
  canvasHandleRef: { readonly current: CanvasHandle | null }
}

export function useViewActions({ dispatch, stateRef, canvasHandleRef }: ViewActionsParams) {
  const [findLayersCounter, setFindLayersCounter] = useState(0)

  const handleZoomIn = useCallback(() => {
    dispatch({ type: 'SET_ZOOM', payload: parseFloat(Math.min(32, stateRef.current.canvas.zoom * 1.25).toFixed(4)) })
  }, [dispatch, stateRef])

  const handleZoomOut = useCallback(() => {
    dispatch({ type: 'SET_ZOOM', payload: parseFloat(Math.max(0.05, stateRef.current.canvas.zoom * 0.8).toFixed(4)) })
  }, [dispatch, stateRef])

  const handleZoom100 = useCallback(() => {
    dispatch({ type: 'SET_ZOOM', payload: 1 })
  }, [dispatch])

  const handleFitToWindow = useCallback(() => {
    canvasHandleRef.current?.fitToWindow()
  }, [canvasHandleRef])

  const handleToggleGrid = useCallback(() => {
    dispatch({ type: 'TOGGLE_GRID' })
  }, [dispatch])

  const handleToggleRulers = useCallback(() => {
    dispatch({ type: 'TOGGLE_RULERS' })
  }, [dispatch])

  const handleToggleGuides = useCallback(() => {
    dispatch({ type: 'TOGGLE_GUIDES' })
  }, [dispatch])

  const handleSetNormalMode = useCallback(() => {
    dispatch({ type: 'SET_TILED_MODE', payload: false })
  }, [dispatch])

  const handleSetTiledMode = useCallback(() => {
    dispatch({ type: 'SET_TILED_MODE', payload: true })
  }, [dispatch])

  const handleToggleTileGrid = useCallback(() => {
    dispatch({ type: 'SET_SHOW_TILE_GRID', payload: !stateRef.current.canvas.showTileGrid })
  }, [dispatch, stateRef])

  const handleSelectAll = useCallback((): void => {
    const { width, height } = stateRef.current.canvas
    if (width === 0 || height === 0) return
    selectionStore.setRect(0, 0, width - 1, height - 1, 'set')
  }, [stateRef])

  const handleDeselect = useCallback((): void => {
    selectionStore.clear()
  }, [])

  const handleSelectAllLayers = useCallback((): void => {
    const allIds = stateRef.current.layers.map(l => l.id)
    dispatch({ type: 'SET_SELECTED_LAYERS', payload: allIds })
  }, [dispatch, stateRef])

  const handleDeselectLayers = useCallback((): void => {
    dispatch({ type: 'SET_SELECTED_LAYERS', payload: [] })
  }, [dispatch])

  const handleFindLayers = useCallback((): void => {
    setFindLayersCounter(c => c + 1)
  }, [])

  return {
    findLayersCounter,
    handleZoomIn, handleZoomOut, handleZoom100,
    handleFitToWindow, handleToggleGrid, handleToggleRulers, handleToggleGuides,
    handleSetNormalMode, handleSetTiledMode, handleToggleTileGrid,
    handleSelectAll, handleDeselect,
    handleSelectAllLayers, handleDeselectLayers,
    handleFindLayers,
  }
}
