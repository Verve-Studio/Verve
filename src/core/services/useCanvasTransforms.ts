import type { AppAction } from '@/core/store/AppContext'
import { cropStore } from '@/core/store/cropStore'
import { f32TransferStore, u8TransferStore } from '@/core/store/layerDataTransfer'
import type { TabRecord } from '@/core/store/tabTypes'
import type { AppState } from '@/types'
import type { CanvasHandle } from '@/ux/main/Canvas/Canvas'
import type { ResizeCanvasSettings } from '@/ux/modals/ResizeCanvasDialog/ResizeCanvasDialog'
import type { ResizeImageSettings } from '@/ux/modals/ResizeImageDialog/ResizeImageDialog'
import { expandIndicesToRgba } from '@/utils/indexedColorUtils'
import { flipIndexed, flipRgba, matchPaletteIndices, resizeBilinear, resizeNearest, rotateIndexed, rotateRgba } from '@/wasm'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useEffect } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseCanvasTransformsOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null }
  stateRef: MutableRefObject<AppState>
  captureHistory: (label: string) => void
  dispatch: Dispatch<AppAction>
  activeTabId: string
  setTabs: Dispatch<SetStateAction<TabRecord[]>>
  setPendingLayerData: Dispatch<SetStateAction<Map<string, string> | null>>
  pendingLayerLabelRef: MutableRefObject<string | null>
  canvasWidth: number
  canvasHeight: number
}

export type RotateAmount = '90cw' | '180' | '270cw'
export type FlipAxis    = 'horizontal' | 'vertical'

export interface UseCanvasTransformsReturn {
  handleResizeImage:          (settings: ResizeImageSettings)  => Promise<void>
  handleResizeCanvas:         (settings: ResizeCanvasSettings) => void
  handleCrop:                 () => void
  handleRotate:               (amount: RotateAmount) => Promise<void>
  handleFlip:                 (axis: FlipAxis)       => Promise<void>
  handleRotateSelectedLayers: (amount: RotateAmount) => Promise<void>
  handleFlipSelectedLayers:   (axis: FlipAxis)       => Promise<void>
}

// ─── Layer-local helpers ──────────────────────────────────────────────────────

function rotateF32(
  src: Float32Array, srcW: number, srcH: number, amount: 0 | 1 | 2
): { data: Float32Array; dstW: number; dstH: number } {
  const dstW = amount === 1 ? srcW : srcH
  const dstH = amount === 1 ? srcH : srcW
  const dst = new Float32Array(dstW * dstH * 4)
  for (let sy = 0; sy < srcH; sy++) {
    for (let sx = 0; sx < srcW; sx++) {
      let dx: number, dy: number
      if (amount === 0)      { dx = srcH - 1 - sy; dy = sx }
      else if (amount === 1) { dx = srcW - 1 - sx; dy = srcH - 1 - sy }
      else                   { dx = sy;             dy = srcW - 1 - sx }
      const si = (sy * srcW + sx) * 4
      const di = (dy * dstW + dx) * 4
      dst[di] = src[si]; dst[di+1] = src[si+1]; dst[di+2] = src[si+2]; dst[di+3] = src[si+3]
    }
  }
  return { data: dst, dstW, dstH }
}

function flipF32(src: Float32Array, w: number, h: number, axis: 0 | 1): Float32Array {
  const dst = new Float32Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = axis === 0 ? w - 1 - x : x
      const dy = axis === 1 ? h - 1 - y : y
      const si = (y * w + x) * 4
      const di = (dy * w + dx) * 4
      dst[di] = src[si]; dst[di+1] = src[si+1]; dst[di+2] = src[si+2]; dst[di+3] = src[si+3]
    }
  }
  return dst
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useCanvasTransforms({
  canvasHandleRef,
  stateRef,
  captureHistory,
  dispatch,
  activeTabId,
  setTabs,
  setPendingLayerData,
  pendingLayerLabelRef,
  canvasWidth,
  canvasHeight,
}: UseCanvasTransformsOptions): UseCanvasTransformsReturn {

  const handleResizeImage = useCallback(async (settings: ResizeImageSettings): Promise<void> => {
    const { width: newW, height: newH, filter } = settings
    const oldW = canvasWidth
    const oldH = canvasHeight
    if (newW === oldW && newH === oldH) return
    const resizeFn = filter === 'nearest' ? resizeNearest : resizeBilinear
    const handle   = canvasHandleRef.current
    if (!handle) return
    const { pixelFormat, swatches } = stateRef.current
    const isIndexed = pixelFormat === 'indexed8'
    try {
      const encoded = new Map<string, string>()
      for (const layer of stateRef.current.layers) {
        if (isIndexed) {
          const indexData = handle.getLayerIndexData(layer.id)
          if (!indexData) continue
          const rgba = expandIndicesToRgba(indexData, swatches)
          const resizedRgba = await resizeNearest(rgba, oldW, oldH, newW, newH)
          const resizedIndices = await matchPaletteIndices(resizedRgba, swatches, 255)
          const binary = btoa(String.fromCharCode(...resizedIndices))
          encoded.set(layer.id, `data:raw/indexed8;base64,${binary}`)
        } else {
          const pixels = handle.getLayerPixels(layer.id)
          if (!pixels) continue
          const resized = await resizeFn(pixels, oldW, oldH, newW, newH)
          u8TransferStore.set(layer.id, resized)
          encoded.set(layer.id, `data:raw/rgba8-ref;id=${layer.id}`)
        }
      }
      captureHistory('Before Resize Image')
      const resizeTabId = activeTabId
      setTabs(prev => prev.map(t =>
        t.id === resizeTabId
          ? { ...t, canvasKey: t.canvasKey + 1, snapshot: { ...t.snapshot, canvasWidth: newW, canvasHeight: newH } }
          : t
      ))
      setPendingLayerData(encoded)
      pendingLayerLabelRef.current = 'Resize Image'
      dispatch({ type: 'RESIZE_CANVAS', payload: { width: newW, height: newH } })
    } catch (err) {
      console.error('[Resize] Failed to resize image:', err)
    }
  }, [canvasWidth, canvasHeight, canvasHandleRef, stateRef, captureHistory, activeTabId, setTabs, setPendingLayerData, pendingLayerLabelRef, dispatch])

  const handleResizeCanvas = useCallback((settings: ResizeCanvasSettings): void => {
    const { width: newW, height: newH, anchorCol, anchorRow } = settings
    const oldW = canvasWidth
    const oldH = canvasHeight
    if (newW === oldW && newH === oldH) return
    const handle = canvasHandleRef.current
    if (!handle) return

    const offsetX = anchorCol === 0 ? 0 : anchorCol === 1 ? Math.round((newW - oldW) / 2) : newW - oldW
    const offsetY = anchorRow === 0 ? 0 : anchorRow === 1 ? Math.round((newH - oldH) / 2) : newH - oldH

    const { pixelFormat } = stateRef.current
    const isIndexed = pixelFormat === 'indexed8'

    const encoded = new Map<string, string>()
    for (const layer of stateRef.current.layers) {
      if (isIndexed) {
        const indexData = handle.getLayerIndexData(layer.id)
        if (!indexData) continue
        const newIndices = new Uint8Array(newW * newH).fill(255)
        const copyX = Math.max(0, offsetX)
        const copyY = Math.max(0, offsetY)
        const copyW = Math.min(oldW, newW - offsetX) - copyX
        const copyH = Math.min(oldH, newH - offsetY) - copyY
        if (copyW > 0 && copyH > 0) {
          for (let row = 0; row < copyH; row++) {
            const srcOffset = (copyY + row - offsetY) * oldW + (copyX - offsetX)
            const dstOffset = (copyY + row) * newW + copyX
            newIndices.set(indexData.subarray(srcOffset, srcOffset + copyW), dstOffset)
          }
        }
        const binary = btoa(String.fromCharCode(...newIndices))
        encoded.set(layer.id, `data:raw/indexed8;base64,${binary}`)
      } else {
        const oldPixels = handle.getLayerPixels(layer.id)
        if (!oldPixels) continue
        const newPixels = new Uint8Array(newW * newH * 4)
        const srcX0 = Math.max(0, -offsetX)
        const srcY0 = Math.max(0, -offsetY)
        const dstX0 = Math.max(0, offsetX)
        const dstY0 = Math.max(0, offsetY)
        const cpW = Math.min(oldW - srcX0, newW - dstX0)
        const cpH = Math.min(oldH - srcY0, newH - dstY0)
        if (cpW > 0 && cpH > 0) {
          for (let row = 0; row < cpH; row++) {
            const srcOff = ((srcY0 + row) * oldW + srcX0) * 4
            const dstOff = ((dstY0 + row) * newW + dstX0) * 4
            newPixels.set(oldPixels.subarray(srcOff, srcOff + cpW * 4), dstOff)
          }
        }
        u8TransferStore.set(layer.id, newPixels)
        encoded.set(layer.id, `data:raw/rgba8-ref;id=${layer.id}`)
      }
    }

    captureHistory('Before Resize Canvas')
    const resizeCanvasTabId = activeTabId
    setTabs(prev => prev.map(t =>
      t.id === resizeCanvasTabId
        ? { ...t, canvasKey: t.canvasKey + 1, snapshot: { ...t.snapshot, canvasWidth: newW, canvasHeight: newH } }
        : t
    ))
    setPendingLayerData(encoded)
    pendingLayerLabelRef.current = 'Resize Canvas'
    dispatch({ type: 'RESIZE_CANVAS', payload: { width: newW, height: newH } })
  }, [canvasWidth, canvasHeight, canvasHandleRef, stateRef, captureHistory, activeTabId, setTabs, setPendingLayerData, pendingLayerLabelRef, dispatch])

  const handleCrop = useCallback((): void => {
    const r = cropStore.rect
    if (!r) return
    const oldW  = canvasWidth
    const oldH  = canvasHeight
    const cropX = Math.max(0, r.x)
    const cropY = Math.max(0, r.y)
    const cropW = Math.min(r.w, oldW - cropX)
    const cropH = Math.min(r.h, oldH - cropY)
    if (cropW <= 0 || cropH <= 0) return
    const handle = canvasHandleRef.current
    if (!handle) return

    const { pixelFormat } = stateRef.current
    const isIndexed = pixelFormat === 'indexed8'

    const encoded = new Map<string, string>()
    for (const layer of stateRef.current.layers) {
      if (isIndexed) {
        const src = handle.getLayerIndexData(layer.id)
        if (!src) continue
        const dst = new Uint8Array(cropW * cropH).fill(255)
        for (let row = 0; row < cropH; row++) {
          const srcRow = cropY + row
          if (srcRow < 0 || srcRow >= oldH) continue
          for (let col = 0; col < cropW; col++) {
            const srcCol = cropX + col
            if (srcCol < 0 || srcCol >= oldW) continue
            dst[row * cropW + col] = src[srcRow * oldW + srcCol]
          }
        }
        const binary = btoa(String.fromCharCode(...dst))
        encoded.set(layer.id, `data:raw/indexed8;base64,${binary}`)
      } else {
        const pixels = handle.getLayerPixels(layer.id)
        if (!pixels) continue
        const cropPixels = new Uint8Array(cropW * cropH * 4)
        for (let row = 0; row < cropH; row++) {
          const srcOff = ((cropY + row) * oldW + cropX) * 4
          const dstOff = row * cropW * 4
          cropPixels.set(pixels.subarray(srcOff, srcOff + cropW * 4), dstOff)
        }
        u8TransferStore.set(layer.id, cropPixels)
        encoded.set(layer.id, `data:raw/rgba8-ref;id=${layer.id}`)
      }
    }

    cropStore.clear()
    captureHistory('Before Crop')
    const cropTabId = activeTabId
    setTabs(prev => prev.map(t =>
      t.id === cropTabId
        ? { ...t, canvasKey: t.canvasKey + 1, snapshot: { ...t.snapshot, canvasWidth: cropW, canvasHeight: cropH } }
        : t
    ))
    setPendingLayerData(encoded)
    pendingLayerLabelRef.current = 'Crop'
    dispatch({ type: 'RESIZE_CANVAS', payload: { width: cropW, height: cropH } })
  }, [canvasWidth, canvasHeight, canvasHandleRef, stateRef, captureHistory, activeTabId, setTabs, setPendingLayerData, pendingLayerLabelRef, dispatch])

  useEffect(() => {
    cropStore.onCrop = handleCrop
    return () => { cropStore.onCrop = null }
  }, [handleCrop])

  const handleRotate = useCallback(async (amount: RotateAmount): Promise<void> => {
    const handle = canvasHandleRef.current
    if (!handle) return
    const oldW = canvasWidth
    const oldH = canvasHeight
    const { layers, pixelFormat } = stateRef.current
    const isIndexed = pixelFormat === 'indexed8'
    const newW = (amount === '180') ? oldW : oldH
    const newH = (amount === '180') ? oldH : oldW
    const wasmAmount: 0 | 1 | 2 = amount === '90cw' ? 0 : amount === '180' ? 1 : 2

    try {
      const entries = await Promise.all(layers.map(async (layer): Promise<[string, string] | null> => {
        if (isIndexed) {
          const srcIdx = handle.getLayerIndexData(layer.id)
          if (!srcIdx) return null
          const dst = await rotateIndexed(srcIdx, oldW, oldH, wasmAmount)
          const binary = btoa(String.fromCharCode(...dst))
          return [layer.id, `data:raw/indexed8;base64,${binary}`]
        } else if (stateRef.current.pixelFormat === 'rgba32f') {
          const raw = handle.getLayerRawData(layer.id)
          if (!raw) return null
          const { data } = rotateF32(raw as Float32Array, oldW, oldH, wasmAmount)
          f32TransferStore.set(layer.id, data)
          return [layer.id, `data:raw/f32-ref;id=${layer.id}`]
        } else {
          const src = handle.getLayerPixels(layer.id)
          if (!src) return null
          const rotated = await rotateRgba(src, oldW, oldH, wasmAmount)
          u8TransferStore.set(layer.id, rotated)
          return [layer.id, `data:raw/rgba8-ref;id=${layer.id}`]
        }
      }))
      const encoded = new Map(entries.filter((e): e is [string, string] => e !== null))

      const label = amount === '90cw' ? 'Rotate 90° CW' : amount === '270cw' ? 'Rotate 270° CW' : 'Rotate 180°'
      captureHistory(`Before ${label}`)
      const tabId = activeTabId
      setTabs(prev => prev.map(t =>
        t.id === tabId
          ? { ...t, canvasKey: t.canvasKey + 1, snapshot: { ...t.snapshot, canvasWidth: newW, canvasHeight: newH } }
          : t
      ))
      setPendingLayerData(encoded)
      pendingLayerLabelRef.current = label
      if (amount !== '180') {
        dispatch({ type: 'RESIZE_CANVAS', payload: { width: newW, height: newH } })
      }
    } catch (err) {
      console.error('[Rotate] Failed:', err)
    }
  }, [canvasWidth, canvasHeight, canvasHandleRef, stateRef, captureHistory, activeTabId, setTabs, setPendingLayerData, pendingLayerLabelRef, dispatch])

  const handleFlip = useCallback(async (axis: FlipAxis): Promise<void> => {
    const handle = canvasHandleRef.current
    if (!handle) return
    const w = canvasWidth
    const h = canvasHeight
    const { layers, pixelFormat } = stateRef.current
    const isIndexed = pixelFormat === 'indexed8'
    const wasmAxis: 0 | 1 = axis === 'horizontal' ? 0 : 1

    try {
      const entries = await Promise.all(layers.map(async (layer): Promise<[string, string] | null> => {
        if (isIndexed) {
          const srcIdx = handle.getLayerIndexData(layer.id)
          if (!srcIdx) return null
          const dst = await flipIndexed(srcIdx, w, h, wasmAxis)
          const binary = btoa(String.fromCharCode(...dst))
          return [layer.id, `data:raw/indexed8;base64,${binary}`]
        } else if (stateRef.current.pixelFormat === 'rgba32f') {
          const raw = handle.getLayerRawData(layer.id)
          if (!raw) return null
          const data = flipF32(raw as Float32Array, w, h, wasmAxis)
          f32TransferStore.set(layer.id, data)
          return [layer.id, `data:raw/f32-ref;id=${layer.id}`]
        } else {
          const src = handle.getLayerPixels(layer.id)
          if (!src) return null
          const flipped = await flipRgba(src, w, h, wasmAxis)
          u8TransferStore.set(layer.id, flipped)
          return [layer.id, `data:raw/rgba8-ref;id=${layer.id}`]
        }
      }))
      const encoded = new Map(entries.filter((e): e is [string, string] => e !== null))

      const label = axis === 'horizontal' ? 'Flip Horizontal' : 'Flip Vertical'
      captureHistory(`Before ${label}`)
      const tabId = activeTabId
      setTabs(prev => prev.map(t =>
        t.id === tabId ? { ...t, canvasKey: t.canvasKey + 1 } : t
      ))
      setPendingLayerData(encoded)
      pendingLayerLabelRef.current = label
    } catch (err) {
      console.error('[Flip] Failed:', err)
    }
  }, [canvasWidth, canvasHeight, canvasHandleRef, stateRef, captureHistory, activeTabId, setTabs, setPendingLayerData, pendingLayerLabelRef])

  const handleRotateSelectedLayers = useCallback(async (amount: RotateAmount): Promise<void> => {
    const handle = canvasHandleRef.current
    if (!handle) return
    const { layers, selectedLayerIds, activeLayerId, swatches } = stateRef.current
    const effectiveIds = new Set(selectedLayerIds)
    if (activeLayerId) effectiveIds.add(activeLayerId)
    const wasmAmount: 0 | 1 | 2 = amount === '90cw' ? 0 : amount === '180' ? 1 : 2
    try {
      type Op = { id: string; data: Uint8Array | Float32Array; newW: number; newH: number; fmt: import('@/types').PixelFormat }
      const ops = (await Promise.all(
        layers
          .filter(l => effectiveIds.has(l.id))
          .map(async (layer): Promise<Op | null> => {
            const gpuLayer = handle.getGpuLayer(layer.id)
            if (!gpuLayer) return null
            const lw = gpuLayer.layerWidth, lh = gpuLayer.layerHeight
            const raw = handle.getLayerRawData(layer.id)
            if (!raw) return null
            if (gpuLayer.format === 'indexed8') {
              const result = await rotateIndexed(raw as Uint8Array, lw, lh, wasmAmount)
              return { id: layer.id, data: result, newW: amount === '180' ? lw : lh, newH: amount === '180' ? lh : lw, fmt: 'indexed8' }
            } else if (gpuLayer.format === 'rgba32f') {
              const { data, dstW, dstH } = rotateF32(raw as Float32Array, lw, lh, wasmAmount)
              return { id: layer.id, data, newW: dstW, newH: dstH, fmt: 'rgba32f' }
            } else {
              const result = await rotateRgba(raw as Uint8Array, lw, lh, wasmAmount)
              return { id: layer.id, data: result, newW: amount === '180' ? lw : lh, newH: amount === '180' ? lh : lw, fmt: 'rgba8' }
            }
          })
      )).filter((op): op is Op => op !== null)
      if (ops.length === 0) return
      const label = amount === '90cw' ? 'Rotate Layer 90° CW' : amount === '270cw' ? 'Rotate Layer 270° CW' : 'Rotate Layer 180°'
      captureHistory(`Before ${label}`)
      for (const op of ops) {
        const gpuLayer = handle.getGpuLayer(op.id)
        if (!gpuLayer) continue
        gpuLayer.layerWidth  = op.newW
        gpuLayer.layerHeight = op.newH
        handle.replaceLayerData(op.id, op.data, op.fmt, op.fmt === 'indexed8' ? swatches as import('@/types').RGBAColor[] : undefined)
      }
    } catch (err) {
      console.error('[RotateLayer] Failed:', err)
    }
  }, [canvasHandleRef, stateRef, captureHistory])

  const handleFlipSelectedLayers = useCallback(async (axis: FlipAxis): Promise<void> => {
    const handle = canvasHandleRef.current
    if (!handle) return
    const { layers, selectedLayerIds, activeLayerId, swatches } = stateRef.current
    const effectiveIds = new Set(selectedLayerIds)
    if (activeLayerId) effectiveIds.add(activeLayerId)
    const wasmAxis: 0 | 1 = axis === 'horizontal' ? 0 : 1
    try {
      type Op = { id: string; data: Uint8Array | Float32Array; fmt: import('@/types').PixelFormat }
      const ops = (await Promise.all(
        layers
          .filter(l => effectiveIds.has(l.id))
          .map(async (layer): Promise<Op | null> => {
            const gpuLayer = handle.getGpuLayer(layer.id)
            if (!gpuLayer) return null
            const lw = gpuLayer.layerWidth, lh = gpuLayer.layerHeight
            const raw = handle.getLayerRawData(layer.id)
            if (!raw) return null
            if (gpuLayer.format === 'indexed8') {
              const result = await flipIndexed(raw as Uint8Array, lw, lh, wasmAxis)
              return { id: layer.id, data: result, fmt: 'indexed8' }
            } else if (gpuLayer.format === 'rgba32f') {
              return { id: layer.id, data: flipF32(raw as Float32Array, lw, lh, wasmAxis), fmt: 'rgba32f' }
            } else {
              const result = await flipRgba(raw as Uint8Array, lw, lh, wasmAxis)
              return { id: layer.id, data: result, fmt: 'rgba8' }
            }
          })
      )).filter((op): op is Op => op !== null)
      if (ops.length === 0) return
      const label = axis === 'horizontal' ? 'Flip Layer Horizontal' : 'Flip Layer Vertical'
      captureHistory(`Before ${label}`)
      for (const op of ops) {
        handle.replaceLayerData(op.id, op.data, op.fmt, op.fmt === 'indexed8' ? swatches as import('@/types').RGBAColor[] : undefined)
      }
    } catch (err) {
      console.error('[FlipLayer] Failed:', err)
    }
  }, [canvasHandleRef, stateRef, captureHistory])

  return { handleResizeImage, handleResizeCanvas, handleCrop, handleRotate, handleFlip, handleRotateSelectedLayers, handleFlipSelectedLayers }
}
