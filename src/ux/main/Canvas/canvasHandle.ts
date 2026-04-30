import { useImperativeHandle, useRef } from 'react'
import type React from 'react'
import type { GpuLayer, WebGPURenderer, RenderPlanEntry } from '@/graphicspipeline/webgpu/rendering/WebGPURenderer'
import type { LayerState, RGBAColor, PixelFormat } from '@/types'
import { isGroupLayer } from '@/types'
import { buildRenderPlan as buildCanvasRenderPlan, buildSubPlan } from './canvasPlan'
import { adjustmentPreviewStore } from '@/core/store/adjustmentPreviewStore'
import { encodePng } from './pngHelpers'
import { rasterizeDocument, type RasterBackend, type RasterReason } from '@/graphicspipeline/rasterization'
import { matchPaletteIndices } from '@/wasm'

// ─── Public handle type (imported by App.tsx and other callers) ────────────

export interface CanvasHandle {
  /** Encode a layer's pixel data to a PNG data-URL synchronously. Returns layer-local PNG + geometry. */
  exportLayerPng: (layerId: string) => { png: string; layerWidth: number; layerHeight: number; offsetX: number; offsetY: number } | null
  /** Encode a baked adjustment mask to a PNG data-URL synchronously. */
  exportAdjustmentMaskPng: (layerId: string) => string | null
  /**
   * Composite all visible layers (in state order) and return the raw RGBA
   * pixel data together with the image dimensions.
   * Returns null when the renderer is not yet initialised.
   */
  rasterizeComposite: (reason: RasterReason) => Promise<{ data: Uint8Array | Float32Array; width: number; height: number; backendUsed: RasterBackend }>
  /** Rasterize a provided subset of layer state using the same plan builder logic as canvas rendering. */
  rasterizeLayers: (layers: readonly LayerState[], reason: RasterReason) => Promise<{ data: Uint8Array | Float32Array; width: number; height: number; backendUsed: RasterBackend }>
  /** Return a copy of a layer's raw RGBA pixel data IN CANVAS-SIZE buffer (pixels outside layer bounds are transparent). */
  getLayerPixels: (layerId: string) => Uint8Array | null
  /**
   * Create a new GL layer, fill it with data, and render.
   * data is canvas-size RGBA. Call BEFORE dispatching ADD_LAYER so the sync effect is a no-op.
   * offsetX/offsetY/lw/lh let you specify exact layer bounds (for paste from clipboard).
   */
  prepareNewLayer: (layerId: string, name: string, data: Uint8Array, lw?: number, lh?: number, ox?: number, oy?: number) => void
  /** Zero out every pixel in a layer that is covered by the selection mask (canvas-space), then flush+render. */
  clearLayerPixels: (layerId: string, mask: Uint8Array) => void
  /** Snapshot all current layers' raw pixel data + geometry for history. */
  captureAllLayerPixels: () => Map<string, Uint8Array | Float32Array>
  /** Snapshot per-layer geometry (width/height/offset). */
  captureAllLayerGeometry: () => Map<string, { layerWidth: number; layerHeight: number; offsetX: number; offsetY: number }>
  /** Snapshot baked selection masks for adjustment layers. */
  captureAllAdjustmentMasks: () => Map<string, Uint8Array>
  /** Restore previously snapshotted pixel data + geometry and flush+render for each layer.
   * Pass layerStateForRender (the history snapshot's layer state) so the render uses the correct mask map. */
  restoreAllLayerPixels: (data: Map<string, Uint8Array | Float32Array>, geometry?: Map<string, { layerWidth: number; layerHeight: number; offsetX: number; offsetY: number }>, layerStateForRender?: readonly LayerState[]) => void
  /** Restore baked selection masks for adjustment layers and re-render. */
  restoreAllAdjustmentMasks: (masks: Map<string, Uint8Array>) => void
  /** Return full-canvas RGBA pixels that feed into the target adjustment layer. Float32Array for f32 docs, Uint8Array otherwise. */
  readAdjustmentInputPixels: (adjustmentLayerId: string) => Promise<Uint8Array | Float32Array | null>
  /** Return a copy of a baked adjustment selection mask by adjustment layer ID. */
  getAdjustmentMaskPixels: (adjustmentLayerId: string) => Uint8Array | Float32Array | null
  /** Rasterize only the children of a group layer, against a transparent background. Used by Merge Group. */
  rasterizeGroupChildren: (groupId: string, layers: readonly LayerState[], swatches: readonly RGBAColor[], reason: RasterReason) => Promise<{ data: Uint8Array | Float32Array; width: number; height: number; backendUsed: RasterBackend }>
  /** Zoom to fit the whole canvas inside the current viewport with a small margin. */
  fitToWindow: () => void
  /**
   * Write a canvas-size RGBA pixel buffer into an existing layer, flush to GPU,
   * and re-render. `pixels` must be Uint8Array of length (canvasWidth × canvasHeight × 4),
   * the same format returned by `getLayerPixels`. Does NOT push to undo history.
   */
  writeLayerPixels: (layerId: string, pixels: Uint8Array) => void
  /**
   * Register a baked selection mask for an adjustment layer.
   * selPixels is a full-canvas Uint8Array (1 byte per pixel, 255 = selected) from selectionStore.mask.
   * The R channel of the resulting WebGL layer drives the shader blend weight.
   */
  registerAdjustmentSelectionMask: (layerId: string, selPixels: Uint8Array) => void
  /** Get raw pixel data for a layer in its native format (Uint8Array for rgba8/indexed8, Float32Array for rgba32f). */
  getLayerRawData: (layerId: string) => Uint8Array | Float32Array | null
  /** Replace a layer's pixel data and GPU texture with new data in a new format. Flushes and re-renders. */
  replaceLayerData: (layerId: string, newData: Uint8Array | Float32Array, newFormat: PixelFormat, palette?: RGBAColor[]) => void
  /** Export raw Float32Array for an rgba32f layer. Returns null for non-f32 layers. */
  exportLayerF32: (layerId: string) => Float32Array | null
  /** Export raw Uint8Array for an indexed8 layer. Returns null for non-indexed layers. */
  exportLayerIndexed: (layerId: string) => Uint8Array | null
  /** Return the raw index buffer for an indexed8 layer as a canvas-sized Uint8Array (1 byte/pixel, 255 = off-layer). Returns null for non-indexed layers. */
  getLayerIndexData: (layerId: string) => Uint8Array | null
  /** Create a full-canvas indexed8 GPU layer from a canvas-sized index buffer. Used by useLayers after merge/flatten. */
  prepareNewLayerIndexed: (layerId: string, name: string, indexData: Uint8Array) => void
  /** Write a canvas-sized index buffer into an indexed8 layer without quantization. Flushes and re-renders. */
  writeLayerIndexData: (layerId: string, indexData: Uint8Array) => void
  /** Return the GpuLayer object for a given layer ID, or null if not found. */
  getGpuLayer: (layerId: string) => GpuLayer | null
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

interface UseCanvasHandleParams {
  ref: React.ForwardedRef<CanvasHandle>
  rendererRef: { readonly current: WebGPURenderer | null }
  glLayersRef: { readonly current: Map<string, GpuLayer> }
  adjustmentMaskMap: { readonly current: Map<string, GpuLayer> }
  layersStateRef: { readonly current: readonly LayerState[] }
  swatchesRef: { readonly current: readonly RGBAColor[] }
  /** Returns the correctly-filtered layers + mask map + full render plan. */
  buildRenderArgs: () => { layers: GpuLayer[]; maskMap: Map<string, GpuLayer>; plan: RenderPlanEntry[] }
  width: number
  height: number
  viewportRef: React.RefObject<HTMLDivElement | null>
  onZoom: (zoom: number) => void
  tiledMode?: boolean
  /** Re-renders both the WebGPU canvas and (if active) the tiled 2D overlay. */
  requestRender: () => void
}

export function useCanvasHandle({
  ref,
  rendererRef,
  glLayersRef,
  adjustmentMaskMap,
  layersStateRef,
  swatchesRef,
  buildRenderArgs,
  width,
  height,
  viewportRef,
  onZoom,
  tiledMode,
  requestRender,
}: UseCanvasHandleParams): void {
  const buildRenderArgsRef = useRef(buildRenderArgs)
  buildRenderArgsRef.current = buildRenderArgs

  const requireRenderer = (): WebGPURenderer => {
    const renderer = rendererRef.current
    if (!renderer) throw new Error('Rasterization failed because the GPU renderer is not ready.')
    return renderer
  }

  const requestRenderRef = useRef(requestRender)
  requestRenderRef.current = requestRender

  const renderFromPlan = (): void => {
    requestRenderRef.current()
  }

  const rebuildPlanForLayers = (layers: readonly LayerState[]): RenderPlanEntry[] => {
    const maskMap = new Map<string, GpuLayer>()
    for (const layer of layers) {
      if ('type' in layer && layer.type === 'mask' && layer.visible) {
        const gl = glLayersRef.current.get(layer.id)
        if (gl) maskMap.set(layer.parentId, gl)
      }
    }
    return buildCanvasRenderPlan(
      layers,
      glLayersRef.current,
      maskMap,
      adjustmentMaskMap.current,
      adjustmentPreviewStore.snapshot(),
      swatchesRef.current as RGBAColor[]
    )
  }

  useImperativeHandle(ref, () => ({
    exportLayerPng: (layerId) => {
      const renderer = rendererRef.current
      const layer = glLayersRef.current.get(layerId)
      if (!renderer || !layer) return null
      const png = encodePng(renderer.readLayerPixels(layer) as Uint8Array, layer.layerWidth, layer.layerHeight)
      return { png, layerWidth: layer.layerWidth, layerHeight: layer.layerHeight, offsetX: layer.offsetX, offsetY: layer.offsetY }
    },

    exportAdjustmentMaskPng: (layerId) => {
      const renderer = rendererRef.current
      const maskLayer = adjustmentMaskMap.current.get(layerId)
      if (!renderer || !maskLayer) return null
      return encodePng(renderer.readLayerPixels(maskLayer) as Uint8Array, renderer.pixelWidth, renderer.pixelHeight)
    },

    rasterizeComposite: async (reason) => {
      const renderer = requireRenderer()
      const { plan } = buildRenderArgsRef.current()
      const result = await rasterizeDocument({
        plan,
        width: renderer.pixelWidth,
        height: renderer.pixelHeight,
        reason,
        renderer,
      })
      if (result.warning) {
        console.warn('[Rasterization]', result.warning)
      }
      return {
        data: result.data,
        width: result.width,
        height: result.height,
        backendUsed: result.backendUsed,
      }
    },

    rasterizeLayers: async (layers, reason) => {
      const renderer = requireRenderer()
      const plan = rebuildPlanForLayers(layers)
      const result = await rasterizeDocument({
        plan,
        width: renderer.pixelWidth,
        height: renderer.pixelHeight,
        reason,
        renderer,
      })
      if (result.warning) {
        console.warn('[Rasterization]', result.warning)
      }
      return {
        data: result.data,
        width: result.width,
        height: result.height,
        backendUsed: result.backendUsed,
      }
    },

    rasterizeGroupChildren: async (groupId, layers, swatches, reason) => {
      const renderer = requireRenderer()
      const group = layers.find(l => l.id === groupId)
      if (!group || !isGroupLayer(group)) throw new Error(`Group ${groupId} not found`)
      const maskMap = new Map<string, GpuLayer>()
      for (const layer of layers) {
        if ('type' in layer && layer.type === 'mask' && layer.visible) {
          const gl = glLayersRef.current.get(layer.id)
          if (gl) maskMap.set((layer as { parentId: string }).parentId, gl)
        }
      }
      const plan = buildSubPlan(
        group.childIds,
        layers,
        glLayersRef.current,
        maskMap,
        adjustmentMaskMap.current,
        new Set(),
        swatches as RGBAColor[],
      )
      const result = await rasterizeDocument({
        plan,
        width: renderer.pixelWidth,
        height: renderer.pixelHeight,
        reason,
        renderer,
      })
      return { data: result.data, width: result.width, height: result.height, backendUsed: result.backendUsed }
    },

    getLayerPixels: (layerId) => {
      const renderer = rendererRef.current
      const layer = glLayersRef.current.get(layerId)
      if (!renderer || !layer) return null
      const w = renderer.pixelWidth
      const h = renderer.pixelHeight
      if (layer.format === 'indexed8') {
        const result = new Uint8Array(w * h * 4)
        for (let ly2 = 0; ly2 < layer.layerHeight; ly2++) {
          const cy2 = layer.offsetY + ly2
          if (cy2 < 0 || cy2 >= h) continue
          for (let lx2 = 0; lx2 < layer.layerWidth; lx2++) {
            const cx2 = layer.offsetX + lx2
            if (cx2 < 0 || cx2 >= w) continue
            const idx = (layer.data as Uint8Array)[ly2 * layer.layerWidth + lx2]
            const di = (cy2 * w + cx2) * 4
            if (idx < swatchesRef.current.length) {
              const p = swatchesRef.current[idx]
              result[di] = p.r; result[di+1] = p.g; result[di+2] = p.b; result[di+3] = p.a
            }
          }
        }
        return result
      }
      const result = new Uint8Array(w * h * 4)
      for (let ly = 0; ly < layer.layerHeight; ly++) {
        const cy = layer.offsetY + ly
        if (cy < 0 || cy >= h) continue
        for (let lx = 0; lx < layer.layerWidth; lx++) {
          const cx = layer.offsetX + lx
          if (cx < 0 || cx >= w) continue
          const si = (ly * layer.layerWidth + lx) * 4
          const di = (cy * w + cx) * 4
          result[di]     = layer.data[si]
          result[di + 1] = layer.data[si + 1]
          result[di + 2] = layer.data[si + 2]
          result[di + 3] = layer.data[si + 3]
        }
      }
      return result
    },

    prepareNewLayer: (layerId, name, data, lw?, lh?, ox?, oy?) => {
      const renderer = rendererRef.current
      if (!renderer) return
      const useW  = lw ?? renderer.pixelWidth
      const useH  = lh ?? renderer.pixelHeight
      const useOx = ox ?? 0
      const useOy = oy ?? 0
      const layer = renderer.createLayer(layerId, name, useW, useH, useOx, useOy)
      layer.data.set(data)
      renderer.flushLayer(layer)
      glLayersRef.current.set(layerId, layer)
      renderFromPlan()
    },

    clearLayerPixels: (layerId, mask) => {
      const renderer = rendererRef.current
      const layer = glLayersRef.current.get(layerId)
      if (!renderer || !layer) return
      const w = renderer.pixelWidth
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue
        const cx = i % w
        const cy = Math.floor(i / w)
        const lx = cx - layer.offsetX
        const ly = cy - layer.offsetY
        if (lx < 0 || ly < 0 || lx >= layer.layerWidth || ly >= layer.layerHeight) continue
        const pi = (ly * layer.layerWidth + lx) * 4
        const f = 1 - mask[i] / 255
        layer.data[pi]     = Math.round(layer.data[pi]     * f)
        layer.data[pi + 1] = Math.round(layer.data[pi + 1] * f)
        layer.data[pi + 2] = Math.round(layer.data[pi + 2] * f)
        layer.data[pi + 3] = Math.round(layer.data[pi + 3] * f)
      }
      renderer.flushLayer(layer)
      renderFromPlan()
    },

    captureAllLayerPixels: () => {
      const result = new Map<string, Uint8Array | Float32Array>()
      for (const ls of layersStateRef.current) {
        const layer = glLayersRef.current.get(ls.id)
        if (layer) result.set(ls.id, layer.data.slice())
      }
      return result
    },

    captureAllLayerGeometry: () => {
      const result = new Map<string, { layerWidth: number; layerHeight: number; offsetX: number; offsetY: number }>()
      for (const ls of layersStateRef.current) {
        const layer = glLayersRef.current.get(ls.id)
        if (layer) result.set(ls.id, { layerWidth: layer.layerWidth, layerHeight: layer.layerHeight, offsetX: layer.offsetX, offsetY: layer.offsetY })
      }
      return result
    },

    captureAllAdjustmentMasks: () => {
      const result = new Map<string, Uint8Array>()
      for (const [layerId, maskLayer] of adjustmentMaskMap.current) {
        result.set(layerId, maskLayer.data.slice() as Uint8Array)
      }
      return result
    },

    fitToWindow: () => {
      const vp = viewportRef.current
      if (!vp) return
      const dpr = window.devicePixelRatio || 1
      const margin = 0.9
      const scale = tiledMode ? 3 : 1
      const zoom = Math.min(
        (vp.clientWidth  / (width  * scale / dpr)) * margin,
        (vp.clientHeight / (height * scale / dpr)) * margin,
      )
      onZoom(parseFloat(Math.max(0.05, Math.min(32, zoom)).toFixed(4)))
    },

    restoreAllLayerPixels: (data, geometry?, layerStateForRender?) => {
      const renderer = rendererRef.current
      if (!renderer) return
      for (const [id, pixels] of data) {
        const geo = geometry?.get(id)
        let layer = glLayersRef.current.get(id)
        const isF32 = (pixels as unknown) instanceof Float32Array
        const isIndexed8 = !isF32 && pixels.length !== (geo?.layerWidth ?? renderer.pixelWidth) * (geo?.layerHeight ?? renderer.pixelHeight) * 4
        const fmt = isF32 ? 'rgba32f' : isIndexed8 ? 'indexed8' : 'rgba8'
        if (geo) {
          if (!layer || layer.layerWidth !== geo.layerWidth || layer.layerHeight !== geo.layerHeight || layer.format !== fmt) {
            if (layer) renderer.destroyLayer(layer)
            layer = renderer.createLayer(id, layer?.name ?? 'Restored', geo.layerWidth, geo.layerHeight, geo.offsetX, geo.offsetY, fmt)
            glLayersRef.current.set(id, layer)
          } else {
            layer.offsetX = geo.offsetX
            layer.offsetY = geo.offsetY
          }
        }
        if (!layer) {
          layer = renderer.createLayer(id, 'Restored', renderer.pixelWidth, renderer.pixelHeight, 0, 0, fmt)
          glLayersRef.current.set(id, layer)
        }
        layer.data.set(pixels as Uint8Array)
        renderer.flushLayer(layer, fmt === 'indexed8' ? swatchesRef.current as import('@/types').RGBAColor[] : undefined)
      }
      // Note: layerStateForRender is currently unused — Canvas.tsx's doRender
      // builds the plan from the live state.layers via buildRenderPlan().
      // Tiled mode requires going through doRender so the 2D overlay is updated.
      void layerStateForRender
      requestRenderRef.current()
    },

    restoreAllAdjustmentMasks: (masks) => {
      const renderer = rendererRef.current
      if (!renderer) return
      for (const [layerId, existing] of adjustmentMaskMap.current) {
        if (!masks.has(layerId)) {
          renderer.destroyLayer(existing)
          adjustmentMaskMap.current.delete(layerId)
        }
      }
      for (const [layerId, data] of masks) {
        let maskLayer = adjustmentMaskMap.current.get(layerId)
        if (!maskLayer) {
          maskLayer = renderer.createLayer(`${layerId}:adjustment-mask`, 'Adjustment Mask', renderer.pixelWidth, renderer.pixelHeight, 0, 0)
          adjustmentMaskMap.current.set(layerId, maskLayer)
        }
        maskLayer.data.set(data)
        renderer.flushLayer(maskLayer)
      }
      renderFromPlan()
    },

    readAdjustmentInputPixels: async (adjustmentLayerId) => {
      const renderer = rendererRef.current
      if (!renderer) return null
      const { plan } = buildRenderArgsRef.current()
      return renderer.readAdjustmentInputPlan(plan, adjustmentLayerId)
    },

    getAdjustmentMaskPixels: (adjustmentLayerId) => {
      const maskLayer = adjustmentMaskMap.current.get(adjustmentLayerId)
      if (!maskLayer) return null
      return maskLayer.data.slice()
    },

    writeLayerPixels: (layerId, pixels) => {
      const renderer = rendererRef.current
      const layer    = glLayersRef.current.get(layerId)
      if (!renderer || !layer) return
      const w = renderer.pixelWidth
      const h = renderer.pixelHeight

      if (layer.format === 'indexed8') {
        matchPaletteIndices(pixels, swatchesRef.current as import('@/types').RGBAColor[], 255).then(indices => {
          for (let ly2 = 0; ly2 < layer.layerHeight; ly2++) {
            for (let lx2 = 0; lx2 < layer.layerWidth; lx2++) {
              const ci = (layer.offsetY + ly2) * w + (layer.offsetX + lx2)
              ;(layer.data as Uint8Array)[ly2 * layer.layerWidth + lx2] = indices[ci]
            }
          }
          renderer.flushLayer(layer, swatchesRef.current as import('@/types').RGBAColor[])
          renderFromPlan()
        })
        return
      }

      // Scan the input for the bounding box of non-transparent pixels (canvas-space).
      // Operations like Free Transform / Perspective produce a canvas-sized buffer
      // where the result may extend beyond the layer's current rect (e.g. a perspective
      // skew that pushes corners outward). Without growing the layer first, those
      // out-of-rect pixels would be silently cropped.
      let minX = w, maxX = -1, minY = h, maxY = -1
      for (let y = 0; y < h; y++) {
        const row = y * w
        for (let x = 0; x < w; x++) {
          if (pixels[(row + x) * 4 + 3] !== 0) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      if (maxX >= 0) {
        renderer.growLayerToFit(layer, minX, minY)
        renderer.growLayerToFit(layer, maxX, maxY)
      }

      for (let ly = 0; ly < layer.layerHeight; ly++) {
        const cy = layer.offsetY + ly
        if (cy < 0 || cy >= h) continue
        for (let lx = 0; lx < layer.layerWidth; lx++) {
          const cx = layer.offsetX + lx
          if (cx < 0 || cx >= w) continue
          const si = (cy * w + cx) * 4
          const di = (ly * layer.layerWidth + lx) * 4
          layer.data[di]     = pixels[si]
          layer.data[di + 1] = pixels[si + 1]
          layer.data[di + 2] = pixels[si + 2]
          layer.data[di + 3] = pixels[si + 3]
        }
      }
      renderer.flushLayer(layer)
      renderFromPlan()
    },

    registerAdjustmentSelectionMask: (layerId, selPixels) => {
      const renderer = rendererRef.current
      if (!renderer) return
      const w = renderer.pixelWidth
      const h = renderer.pixelHeight
      let maskLayer = adjustmentMaskMap.current.get(layerId)
      if (!maskLayer) {
        maskLayer = renderer.createLayer(`${layerId}:adjustment-mask`, 'Adjustment Mask', w, h, 0, 0)
        adjustmentMaskMap.current.set(layerId, maskLayer)
      }
      const input = selPixels.length === w * h ? selPixels : new Uint8Array(w * h)
      for (let i = 0; i < w * h; i++) {
        const v = input[i]
        const di = i * 4
        maskLayer.data[di] = v
        maskLayer.data[di + 1] = v
        maskLayer.data[di + 2] = v
        maskLayer.data[di + 3] = 255
      }
      renderer.flushLayer(maskLayer)
      renderFromPlan()
    },

    getLayerRawData: (layerId) => {
      const layer = glLayersRef.current.get(layerId)
      if (!layer) return null
      return layer.data.slice() as Uint8Array | Float32Array
    },

    replaceLayerData: (layerId, newData, newFormat, palette) => {
      const renderer = rendererRef.current
      const layer = glLayersRef.current.get(layerId)
      if (!renderer || !layer) return
      renderer.replaceLayerData(layer, newData, newFormat, palette)
      renderFromPlan()
    },

    exportLayerF32: (layerId) => {
      const layer = glLayersRef.current.get(layerId)
      if (!layer || layer.format !== 'rgba32f') return null
      return (layer.data as Float32Array).slice()
    },

    exportLayerIndexed: (layerId) => {
      const layer = glLayersRef.current.get(layerId)
      if (!layer || layer.format !== 'indexed8') return null
      return (layer.data as Uint8Array).slice()
    },

    getLayerIndexData: (layerId) => {
      const layer = glLayersRef.current.get(layerId)
      const renderer = rendererRef.current
      if (!layer || !renderer || layer.format !== 'indexed8') return null
      const w = renderer.pixelWidth
      const h = renderer.pixelHeight
      const result = new Uint8Array(w * h).fill(255)
      for (let ly2 = 0; ly2 < layer.layerHeight; ly2++) {
        for (let lx2 = 0; lx2 < layer.layerWidth; lx2++) {
          const cx2 = layer.offsetX + lx2, cy2 = layer.offsetY + ly2
          if (cx2 < 0 || cx2 >= w || cy2 < 0 || cy2 >= h) continue
          result[cy2 * w + cx2] = (layer.data as Uint8Array)[ly2 * layer.layerWidth + lx2]
        }
      }
      return result
    },

    prepareNewLayerIndexed: (layerId, name, indexData) => {
      const renderer = rendererRef.current
      if (!renderer) return
      const w = renderer.pixelWidth, h = renderer.pixelHeight
      const layer = renderer.createLayer(layerId, name, w, h, 0, 0, 'indexed8')
      ;(layer.data as Uint8Array).set(indexData)
      renderer.flushLayer(layer, swatchesRef.current as import('@/types').RGBAColor[])
      glLayersRef.current.set(layerId, layer)
      renderFromPlan()
    },

    writeLayerIndexData: (layerId, indexData) => {
      const layer = glLayersRef.current.get(layerId)
      const renderer = rendererRef.current
      if (!layer || !renderer || layer.format !== 'indexed8') return
      const w = renderer.pixelWidth
      for (let ly2 = 0; ly2 < layer.layerHeight; ly2++) {
        for (let lx2 = 0; lx2 < layer.layerWidth; lx2++) {
          const ci = (layer.offsetY + ly2) * w + (layer.offsetX + lx2)
          ;(layer.data as Uint8Array)[ly2 * layer.layerWidth + lx2] = indexData[ci]
        }
      }
      renderer.flushLayer(layer, swatchesRef.current as import('@/types').RGBAColor[])
      renderFromPlan()
    },

    getGpuLayer: (layerId) => glLayersRef.current.get(layerId) ?? null,
  }), [width, height]) // eslint-disable-line react-hooks/exhaustive-deps
}
