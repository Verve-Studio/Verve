import type { AppAction } from '@/core/store/AppContext'
import type { ClearHistoryOptions } from '@/core/store/historyStore'
import { historyStore } from '@/core/store/historyStore'
import { f32TransferStore } from '@/core/store/layerDataTransfer'
import type { TabRecord } from '@/core/store/tabTypes'
import type { AppState, RGBAColor } from '@/types'
import type { CanvasHandle } from '@/ux/main/Canvas/Canvas'
import type { Dispatch, MutableRefObject } from 'react'
import { useCallback, useEffect, useRef } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseHistoryOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null }
  stateRef: MutableRefObject<AppState>
  dispatch: Dispatch<AppAction>
  activeTabIdRef: MutableRefObject<string>
  setTabsRef: MutableRefObject<Dispatch<React.SetStateAction<TabRecord[]>>>
  setPendingLayerData: Dispatch<React.SetStateAction<Map<string, string> | null>>
  /** state.layers — dependency for the auto-capture-on-layer-change effect. */
  layers: AppState['layers']
}

export interface UseHistoryReturn {
  captureHistory: (label: string, overrides?: { swatches?: RGBAColor[] }) => void
  isRestoringRef: MutableRefObject<boolean>
  suppressReadyCaptureRef: MutableRefObject<boolean>
  pendingLayerLabelRef: MutableRefObject<string | null>
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useHistory({
  canvasHandleRef,
  stateRef,
  dispatch,
  activeTabIdRef,
  setTabsRef,
  setPendingLayerData,
  layers,
}: UseHistoryOptions): UseHistoryReturn {
  const isRestoringRef        = useRef(false)
  const suppressReadyCaptureRef = useRef(false)
  const pendingLayerLabelRef  = useRef<string | null>(null)
  const prevLayersRef         = useRef(layers)

  const captureHistory = useCallback((label: string, overrides?: { swatches?: RGBAColor[] }): void => {
    if (isRestoringRef.current) return
    if (suppressReadyCaptureRef.current) {
      suppressReadyCaptureRef.current = false
      return
    }
    const layerPixels = canvasHandleRef.current?.captureAllLayerPixels()
    if (!layerPixels || layerPixels.size === 0) return
    const layerGeometry = canvasHandleRef.current?.captureAllLayerGeometry() ?? new Map()
    const adjustmentMasks = canvasHandleRef.current?.captureAllAdjustmentMasks() ?? new Map()
    const s = stateRef.current
    historyStore.push({
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      label,
      timestamp: Date.now(),
      layerPixels,
      layerGeometry,
      adjustmentMasks,
      layerState: s.layers,
      activeLayerId: s.activeLayerId,
      canvasWidth: s.canvas.width,
      canvasHeight: s.canvas.height,
      swatches: overrides?.swatches ?? s.swatches,
    })
  }, [canvasHandleRef, stateRef])

  // Preview: temporarily show a history entry without committing state
  useEffect(() => {
    historyStore.onPreview = (index: number): void => {
      const entry = historyStore.entries[index]
      if (!entry) return
      if (
        entry.canvasWidth  !== stateRef.current.canvas.width ||
        entry.canvasHeight !== stateRef.current.canvas.height
      ) return
      canvasHandleRef.current?.restoreAllLayerPixels(entry.layerPixels, entry.layerGeometry, entry.layerState)
      canvasHandleRef.current?.restoreAllAdjustmentMasks(entry.adjustmentMasks)
    }
    return () => { historyStore.onPreview = null }
  }, [canvasHandleRef, stateRef])

  // Jump-to: full restore — may trigger canvas remount for dimension changes
  useEffect(() => {
    historyStore.onJumpTo = (index: number): void => {
      const entry = historyStore.entries[index]
      if (!entry) return
      isRestoringRef.current = true
      const currentW = stateRef.current.canvas.width
      const currentH = stateRef.current.canvas.height

      if (entry.canvasWidth !== currentW || entry.canvasHeight !== currentH) {
        const encoded = new Map<string, string>()
        for (const [id, pixels] of entry.layerPixels) {
          const geo = entry.layerGeometry?.get(id)
          const lw = geo?.layerWidth ?? entry.canvasWidth
          const lh = geo?.layerHeight ?? entry.canvasHeight
          if ((pixels as unknown) instanceof Float32Array) {
            f32TransferStore.set(id, pixels as unknown as Float32Array)
            encoded.set(id, `data:raw/f32-ref;id=${id}`)
          } else if (pixels.length === lw * lh) {
            // indexed8 — 1 byte/pixel
            const u8 = pixels as Uint8Array
            const CHUNK = 65535
            let b64 = ''
            for (let i = 0; i < u8.length; i += CHUNK) {
              b64 += btoa(String.fromCharCode(...Array.from(u8.subarray(i, i + CHUNK))))
            }
            encoded.set(id, `data:raw/indexed8;base64,${b64}`)
          } else {
            const tmp = document.createElement('canvas')
            tmp.width = lw; tmp.height = lh
            const ctx2d = tmp.getContext('2d')!
            ctx2d.putImageData(
              new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer), lw, lh),
              0, 0
            )
            encoded.set(id, tmp.toDataURL('image/png'))
          }
          if (geo) encoded.set(`${id}:geo`, JSON.stringify(geo))
        }
        for (const [layerId, maskPixels] of entry.adjustmentMasks) {
          const maskCanvas = document.createElement('canvas')
          maskCanvas.width = entry.canvasWidth
          maskCanvas.height = entry.canvasHeight
          const maskCtx2d = maskCanvas.getContext('2d')!
          maskCtx2d.putImageData(
            new ImageData(new Uint8ClampedArray(maskPixels.buffer as ArrayBuffer), entry.canvasWidth, entry.canvasHeight),
            0, 0
          )
          encoded.set(`${layerId}:adjustment-mask`, maskCanvas.toDataURL('image/png'))
        }
        suppressReadyCaptureRef.current = true
        setPendingLayerData(encoded)
        const jumpTabId = activeTabIdRef.current
        setTabsRef.current(prev => prev.map(t =>
          t.id === jumpTabId
            ? { ...t, canvasKey: t.canvasKey + 1, snapshot: { ...t.snapshot, canvasWidth: entry.canvasWidth, canvasHeight: entry.canvasHeight } }
            : t
        ))
        dispatch({
          type: 'SWITCH_TAB',
          payload: {
            width: entry.canvasWidth,
            height: entry.canvasHeight,
            backgroundFill: stateRef.current.canvas.backgroundFill,
            layers: entry.layerState,
            activeLayerId: entry.activeLayerId,
            zoom: stateRef.current.canvas.zoom,
            tiledMode: stateRef.current.canvas.tiledMode,
            showTileGrid: stateRef.current.canvas.showTileGrid,
          },
        })
        if (entry.swatches) {
          dispatch({ type: 'SET_SWATCHES', payload: entry.swatches })
        }
      } else {
        canvasHandleRef.current?.restoreAllLayerPixels(entry.layerPixels, entry.layerGeometry, entry.layerState)
        canvasHandleRef.current?.restoreAllAdjustmentMasks(entry.adjustmentMasks)
        dispatch({
          type: 'RESTORE_LAYERS',
          payload: { layers: entry.layerState, activeLayerId: entry.activeLayerId },
        })
        if (entry.swatches) {
          dispatch({ type: 'SET_SWATCHES', payload: entry.swatches })
        }
      }

      historyStore.setCurrent(index)
      setTimeout(() => { isRestoringRef.current = false }, 200)
    }
    return () => { historyStore.onJumpTo = null }
  }, [dispatch, canvasHandleRef, stateRef, activeTabIdRef, setTabsRef, setPendingLayerData])

  // Register onClear: capture current state as 'History Cleared' entry
  useEffect(() => {
    historyStore.onClear = (options?: ClearHistoryOptions): void => {
      if (options?.recaptureSnapshot === false) return
      captureHistory('History Cleared')
    }
    return () => { historyStore.onClear = null }
  }, [captureHistory])

  // Auto-capture when layers are added or removed
  useEffect(() => {
    if (isRestoringRef.current) {
      prevLayersRef.current = layers
      isRestoringRef.current = false
      return
    }
    const prev = prevLayersRef.current
    const curr = layers
    if (prev !== curr) {
      if (curr.length > prev.length) {
        captureHistory(pendingLayerLabelRef.current ?? 'New Layer')
        pendingLayerLabelRef.current = null
      } else if (curr.length < prev.length) {
        captureHistory('Delete Layer')
      }
      prevLayersRef.current = curr
    }
  }, [layers, captureHistory])

  return { captureHistory, isRestoringRef, suppressReadyCaptureRef, pendingLayerLabelRef }
}
