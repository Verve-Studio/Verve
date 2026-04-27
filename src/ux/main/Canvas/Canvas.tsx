import React, { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import { useWebGPU } from '@/core/services/useWebGPU'
import { useCanvas } from '@/core/services/useCanvas'
import { useAppContext } from '@/core/store/AppContext'
import { useCanvasContext } from '@/core/store/CanvasContext'
import type { GpuLayer, RenderPlanEntry } from '@/graphicspipeline/webgpu/rendering/WebGPURenderer'
import type { TextLayerState, ShapeLayerState, MaskLayerState } from '@/types'
import { TOOL_REGISTRY } from '@/tools'
import type { ToolContext, ToolHandler } from '@/tools'
import { brushOptions } from '@/tools/brush'
import { pencilOptions, getPencilBrushPreviewDataUrl, getPencilShapePreviewDataUrl } from '@/tools/pencil'
import { eraserOptions } from '@/tools/eraser'
import { cloneStampOptions } from '@/tools/cloneStamp'
import { dodgeOptions, burnOptions } from '@/tools/dodge'
import { cloneStampStore } from '@/core/store/cloneStampStore'
import { drawCloneStampOverlay } from './cloneStampOverlay'
import { polygonalSelectionStore } from '@/core/store/polygonalSelectionStore'
import { objectSelectionStore } from '@/core/store/objectSelectionStore'
import { selectionStore } from '@/core/store/selectionStore'
import { cursorStore } from '@/core/store/cursorStore'
import { transformStore } from '@/core/store/transformStore'
import { drawTransformOverlay } from '@/tools/transform'
import { TextLayerEditor } from './TextLayerEditor'
import { rasterizeTextToLayer } from './textRasterizer'
import { rasterizeShapeToLayer } from './shapeRasterizer'
import { decodePng } from './pngHelpers'
import { useCanvasHandle } from './canvasHandle'
import type { CanvasHandle } from './canvasHandle'
import { buildRenderPlan as buildCanvasRenderPlan } from './canvasPlan'
import { useMarchingAnts } from './useMarchingAnts'
import { useScrollZoom } from './useScrollZoom'
import { adjustmentPreviewStore } from '@/core/store/adjustmentPreviewStore'
import styles from './Canvas.module.scss'

// Re-export so external importers (App.tsx etc.) don't need to change their paths.
export type { CanvasHandle } from './canvasHandle'

// ─── Component ────────────────────────────────────────────────────────────────

interface CanvasProps {
  width: number
  height: number
  /** Per-layer base64 PNG data URLs to populate on mount (used when opening a file). */
  initialLayerData?: Map<string, string>
  /** Called with the tool label after a pixel-modifying stroke completes. */
  onStrokeEnd?: (label: string) => void
  /** Called once after the canvas has finished its first initialization render. */
  onReady?: () => void
  /** When false the canvas is hidden and all interactive effects are suspended. Default true. */
  isActive?: boolean
}

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(function Canvas(
  { width, height, initialLayerData, onStrokeEnd, onReady, isActive = true },
  ref
) {
  const { state, dispatch } = useAppContext()
  const { canvasElRef, thumbnailCanvasRef } = useCanvasContext()
  const { canvasRef, rendererRef, rendererVersion } = useWebGPU({
    pixelWidth: width,
    pixelHeight: height
  })

  const glLayersRef = useRef<Map<string, GpuLayer>>(new Map())
  const adjustmentMaskMap = useRef<Map<string, GpuLayer>>(new Map())
  const toolHandlerRef = useRef<ToolHandler>(TOOL_REGISTRY[state.activeTool].createHandler())
  const hasInitializedRef = useRef(false)
  // Track isActive in a ref so async init can read the current value
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  // Saved scroll position, restored when the canvas becomes active again
  const scrollPosRef = useRef({ left: 0, top: 0 })
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const toolOverlayRef = useRef<HTMLCanvasElement>(null)
  const tiledCanvasRef = useRef<HTMLCanvasElement>(null)
  const brushCursorRef = useRef<HTMLDivElement>(null)
  const pixelBrushCursorRef = useRef<HTMLDivElement>(null)
  const canvasWrapperRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef(state.canvas.zoom)
  zoomRef.current = state.canvas.zoom
  const activeToolRef = useRef(state.activeTool)
  activeToolRef.current = state.activeTool
  const pendingScrollRef = useRef<{ scrollLeft: number; scrollTop: number } | null>(null)

  // Keep a ref to the current layer list so the imperative handle can access
  // up-to-date ordering and visibility without being re-created on every render.
  const layersStateRef = useRef(state.layers)
  layersStateRef.current = state.layers
  const swatchesRef = useRef(state.swatches)
  swatchesRef.current = state.swatches
  const onStrokeEndRef = useRef(onStrokeEnd)
  onStrokeEndRef.current = onStrokeEnd
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  // ── Inline text layer editor state ────────────────────────────
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null)

  // When a pixel-modifying tool starts on a text/shape layer, this holds the
  // newly-created pixel layer so buildCtx can target it before React re-renders.
  const newPixelLayerRef = useRef<GpuLayer | null>(null)

  // ── Thumbnail mirror canvas ────────────────────────────────────
  // A plain 2D canvas kept in sync with the WebGPU output so Navigator (and any
  // other panel) can read pixel content without touching the WebGPU canvas directly
  // (which can cause GPU-process crashes in Electron when cross-context read is attempted).
  useEffect(() => {
    const mirror = document.createElement('canvas')
    mirror.width = width
    mirror.height = height
    thumbnailCanvasRef.current = mirror
    return () => { thumbnailCanvasRef.current = null }
  }, [width, height, thumbnailCanvasRef])

  // doRender: wrapper around renderPlan that also asynchronously refreshes the mirror canvas.
  // Mirror updates are flight-controlled: at most one in-flight createImageBitmap. During a
  // high-frequency drag (60–120 fps) without this, bitmap snapshots queue up faster than they
  // resolve, causing perceived memory growth from large in-flight bitmaps.
  //
  // Render calls themselves are coalesced to one-per-animation-frame. A 1000 Hz mouse drag would
  // otherwise issue ~1000 renderPlan() calls/sec, each creating GPUBindGroups, GPUTextureViews,
  // and a GPUCommandBuffer. These objects rely on GC (no destroy API) and the WebGPU driver
  // retains them until the GPU consumes the submitted command buffers — at 1000 Hz the in-flight
  // set grows faster than it drains, producing visible memory growth during sustained drags.
  const mirrorBitmapInFlightRef = useRef(false)
  const mirrorBitmapPendingRef = useRef(false)
  const renderRafIdRef = useRef<number>(0)
  const doRender = (): void => {
    if (renderRafIdRef.current !== 0) return // already scheduled for this frame
    renderRafIdRef.current = requestAnimationFrame(() => {
      renderRafIdRef.current = 0
      const renderer = rendererRef.current
      if (!renderer) return
      renderer.renderPlan(buildRenderPlan())
      // Tiled mode: blit GPU canvas 9 times into the 2D overlay canvas
      if (state.canvas.tiledMode) {
        const tc = tiledCanvasRef.current
        const gc = canvasRef.current
        if (tc && gc) {
          const ctx2d = tc.getContext('2d')
          if (ctx2d) {
            ctx2d.clearRect(0, 0, tc.width, tc.height)
            for (let row = 0; row < 3; row++) {
              for (let col = 0; col < 3; col++) {
                ctx2d.drawImage(gc, col * width, row * height, width, height)
              }
            }
            if (state.canvas.showTileGrid) {
              ctx2d.strokeStyle = 'rgba(0, 220, 200, 0.55)'
              ctx2d.lineWidth = 0.75
              ctx2d.beginPath()
              ctx2d.moveTo(width, 0);       ctx2d.lineTo(width, 3 * height)
              ctx2d.moveTo(2 * width, 0);   ctx2d.lineTo(2 * width, 3 * height)
              ctx2d.moveTo(0, height);      ctx2d.lineTo(3 * width, height)
              ctx2d.moveTo(0, 2 * height);  ctx2d.lineTo(3 * width, 2 * height)
              ctx2d.stroke()
            }
          }
        }
      }
      scheduleMirrorUpdate()
    })
  }
  const scheduleMirrorUpdate = (): void => {
    const gpuCanvas = canvasRef.current
    const mirror = thumbnailCanvasRef.current
    if (!gpuCanvas || !mirror) return
    if (mirrorBitmapInFlightRef.current) {
      // Coalesce: a frame is already in flight; mark that we owe one more update once it resolves.
      mirrorBitmapPendingRef.current = true
      return
    }
    mirrorBitmapInFlightRef.current = true
    createImageBitmap(gpuCanvas).then(bitmap => {
      const m = thumbnailCanvasRef.current
      if (m) {
        const ctx = m.getContext('2d')
        ctx?.clearRect(0, 0, m.width, m.height)
        ctx?.drawImage(bitmap, 0, 0)
      }
      bitmap.close()
    }).catch(() => { /* not yet presented */ }).finally(() => {
      mirrorBitmapInFlightRef.current = false
      if (mirrorBitmapPendingRef.current) {
        mirrorBitmapPendingRef.current = false
        scheduleMirrorUpdate()
      }
    })
  }

  // ── Expose handle for save / export / clipboard ────────────────
  useCanvasHandle({
    ref,
    rendererRef,
    glLayersRef,
    adjustmentMaskMap,
    layersStateRef,
    swatchesRef,
    buildRenderArgs: () => ({
      layers: buildOrderedGLLayers(),
      maskMap: buildMaskMap(),
      plan: buildRenderPlan(),
    }),
    width,
    height,
    viewportRef,
    onZoom: (zoom) => dispatch({ type: 'SET_ZOOM', payload: zoom }),
    tiledMode: state.canvas.tiledMode,
    requestRender: doRender,
  })

  // ── Zoom to cursor + scroll save/restore ───────────────────────
  // When a selection is active, zoom towards its centroid (Photoshop behaviour).
  // Returns the selection centroid in image-pixel space, used by useScrollZoom
  // to keep the selection anchor stable while zooming (Ctrl+scroll and Navigator).
  const getSelectionAnchorRef = useRef<(() => { x: number; y: number } | null) | null>(null)
  getSelectionAnchorRef.current = (): { x: number; y: number } | null => {
    const mask = selectionStore.mask
    if (!mask) return null
    const sw = selectionStore.width
    const sh = selectionStore.height
    let lx = sw, ly = sh, rx = -1, ry = -1
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (mask[y * sw + x]) {
          if (x < lx) lx = x
          if (x > rx) rx = x
          if (y < ly) ly = y
          if (y > ry) ry = y
        }
      }
    }
    if (rx < 0) return null
    // Return centroid in image pixels
    return { x: (lx + rx) / 2, y: (ly + ry) / 2 }
  }

  useScrollZoom(
    isActive, isActiveRef, viewportRef, zoomRef, pendingScrollRef, scrollPosRef,
    state.canvas.zoom,
    (zoom) => dispatch({ type: 'SET_ZOOM', payload: zoom }),
    getSelectionAnchorRef,
  )

  // Init selection store dimensions once canvas is sized
  useEffect(() => {
    if (!isActive) return
    selectionStore.setDimensions(width, height)
    return () => { selectionStore.clear() }
  }, [width, height, isActive])

  // ── Marching ants + crop overlay + polygonal selection overlay ──
  useMarchingAnts(isActive, overlayRef, viewportRef, canvasWrapperRef, zoomRef, activeToolRef)

  // Publish canvas element into shared context (active canvas only)
  useEffect(() => {
    if (!isActive) return
    canvasElRef.current = canvasRef.current
  })

  // Initialize all layers once renderer is ready — runs once per mount
  useEffect(() => {
    if (hasInitializedRef.current) return
    const renderer = rendererRef.current
    if (!renderer) return
    if (!state.layers.length) return
    hasInitializedRef.current = true
    let cancelled = false
    const isStale = (): boolean => cancelled || rendererRef.current !== renderer

    const init = async (): Promise<void> => {
      if (isStale()) return
      const { pixelWidth: cw, pixelHeight: ch } = renderer
      for (let i = 0; i < state.layers.length; i++) {
        const ls = state.layers[i]

        if ('type' in ls && ls.type === 'adjustment') {
          const maskPng = initialLayerData?.get(`${ls.id}:adjustment-mask`)
          if (maskPng) {
            const maskLayer = renderer.createLayer(`${ls.id}:adjustment-mask`, `${ls.name} Mask`, cw, ch, 0, 0)
            try {
              const rgba = await decodePng(maskPng, cw, ch)
              if (isStale()) return
              maskLayer.data.set(rgba)
              renderer.flushLayer(maskLayer)
              adjustmentMaskMap.current.set(ls.id, maskLayer)
            } catch (e) {
              renderer.destroyLayer(maskLayer)
              console.error('[Canvas] Failed to load adjustment mask PNG:', e)
            }
          }
          continue
        }

        let layer
        const pngData = initialLayerData?.get(ls.id)
        if (!('type' in ls) && !pngData) {
          const prev = glLayersRef.current.get(ls.id)
          if (prev) {
            layer = renderer.createLayer(ls.id, ls.name, prev.layerWidth, prev.layerHeight, prev.offsetX, prev.offsetY)
            layer.data.set(prev.data)
          }
        }
        if (pngData) {
          // ── Opening a file: pngData may be layer-local, canvas-size, or a raw typed-array blob.
          const geoKey = `${ls.id}:geo`
          const geoJson = initialLayerData?.get(geoKey)

          if (pngData.startsWith('data:raw/f32;base64,')) {
            // rgba32f layer: base64-encoded raw Float32Array bytes
            const b64 = pngData.slice('data:raw/f32;base64,'.length)
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
            const f32 = new Float32Array(bytes.buffer)
            if (geoJson) {
              const geo = JSON.parse(geoJson) as { layerWidth: number; layerHeight: number; offsetX: number; offsetY: number }
              layer = renderer.createLayer(ls.id, ls.name, geo.layerWidth, geo.layerHeight, geo.offsetX, geo.offsetY, 'rgba32f')
            } else {
              layer = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0, 'rgba32f')
            }
            ;(layer.data as Float32Array).set(f32)
          } else if (pngData.startsWith('data:raw/indexed8;base64,')) {
            // indexed8 layer: base64-encoded raw palette-index bytes
            const b64 = pngData.slice('data:raw/indexed8;base64,'.length)
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
            if (geoJson) {
              const geo = JSON.parse(geoJson) as { layerWidth: number; layerHeight: number; offsetX: number; offsetY: number }
              layer = renderer.createLayer(ls.id, ls.name, geo.layerWidth, geo.layerHeight, geo.offsetX, geo.offsetY, 'indexed8')
            } else {
              layer = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0, 'indexed8')
            }
            ;(layer.data as Uint8Array).set(bytes)
          } else if (geoJson) {
            // Layer-local PNG with geometry
            const geo = JSON.parse(geoJson) as { layerWidth: number; layerHeight: number; offsetX: number; offsetY: number }
            layer = renderer.createLayer(ls.id, ls.name, geo.layerWidth, geo.layerHeight, geo.offsetX, geo.offsetY)
            try {
              const rgba = await decodePng(pngData, geo.layerWidth, geo.layerHeight)
              if (isStale()) return
              layer.data.set(rgba)
            } catch (e) {
              console.error('[Canvas] Failed to load layer PNG:', e)
            }
          } else {
            // Legacy / image import: PNG is canvas-sized
            layer = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0)
            try {
              const rgba = await decodePng(pngData, cw, ch)
              if (isStale()) return
              layer.data.set(rgba)
            } catch (e) {
              console.error('[Canvas] Failed to load layer PNG:', e)
            }
          }
        } else if (i === 0 && !initialLayerData) {
          // New document — background layer covers the full canvas
          layer = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0)
          const bg = state.canvas.backgroundFill
          if (bg === 'white') {
            layer.data.fill(255)
          } else if (bg === 'black') {
            for (let j = 0; j < layer.data.length; j += 4) {
              layer.data[j] = 0; layer.data[j + 1] = 0; layer.data[j + 2] = 0; layer.data[j + 3] = 255
            }
          }
        } else if ('type' in ls && ls.type === 'shape') {
          // Shape layers are full-canvas-sized (rasterized vector data)
          layer = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0)
          rasterizeShapeToLayer(ls, layer, cw, ch)
        } else if ('type' in ls && ls.type === 'mask') {
          // Mask layers are full-canvas-sized; initialized all-white (fully reveal parent)
          layer = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0)
          layer.data.fill(255)
        } else {
          // New blank layer — start at 128×128 centered on the canvas
          const initW = Math.min(128, cw)
          const initH = Math.min(128, ch)
          const ox = Math.round((cw - initW) / 2)
          const oy = Math.round((ch - initH) / 2)
          layer = renderer.createLayer(ls.id, ls.name, initW, initH, ox, oy)
        }

        layer.opacity   = 'opacity'   in ls ? ls.opacity   : 1
        layer.visible   = ls.visible
        layer.blendMode = 'blendMode' in ls ? ls.blendMode : 'normal'
        if (isStale()) return
        renderer.flushLayer(layer, layer.format === 'indexed8' ? swatchesRef.current as import('@/types').RGBAColor[] : undefined)
        glLayersRef.current.set(ls.id, layer)
      }
      if (isStale()) return
      doRender()
      if (!isStale() && isActiveRef.current) {
        onReadyRef.current?.()
      }
    }

    init()
    return () => {
      cancelled = true
      hasInitializedRef.current = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendererVersion])

  // Sync WebGL layers whenever AppState layer list changes
  useEffect(() => {
    if (!isActive) return
    const renderer = rendererRef.current
    if (!renderer) return
    const map = glLayersRef.current

    for (const ls of state.layers) {
      if ('type' in ls && ls.type === 'adjustment') continue
      if (!map.has(ls.id)) {
        if ('type' in ls && ls.type === 'text') {
          // Text layers are created imperatively in addTextLayer before the dispatch;
          // if they somehow still aren't in the map, create a full-canvas layer for them.
          const cw = renderer.pixelWidth
          const ch = renderer.pixelHeight
          const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0)
          rasterizeTextToLayer(ls, gl)
          renderer.flushLayer(gl)
          map.set(ls.id, gl)
        } else if ('type' in ls && ls.type === 'shape') {
          // Shape layers created imperatively via addShapeLayer; recreate if missing.
          const cw = renderer.pixelWidth
          const ch = renderer.pixelHeight
          const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0)
          rasterizeShapeToLayer(ls, gl, cw, ch)
          renderer.flushLayer(gl)
          map.set(ls.id, gl)
        } else if ('type' in ls && ls.type === 'mask') {
          // Newly added mask layer — full-canvas white (default: fully reveal parent)
          const cw = renderer.pixelWidth
          const ch = renderer.pixelHeight
          const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0)
          gl.data.fill(255)
          renderer.flushLayer(gl)
          map.set(ls.id, gl)
        } else {
          // Pixel layers start at 128×128 centered on the canvas
          const cw = renderer.pixelWidth
          const ch = renderer.pixelHeight
          const initW = Math.min(128, cw)
          const initH = Math.min(128, ch)
          const ox = Math.round((cw - initW) / 2)
          const oy = Math.round((ch - initH) / 2)
          const gl = renderer.createLayer(ls.id, ls.name, initW, initH, ox, oy)
          map.set(ls.id, gl)
        }
      }
    }

    const stateIds = new Set(state.layers.map((l) => l.id))
    for (const [id, gl] of map) {
      if (!stateIds.has(id)) {
        renderer.destroyLayer(gl)
        map.delete(id)
      }
    }
    for (const [id, gl] of adjustmentMaskMap.current) {
      if (!stateIds.has(id)) {
        renderer.destroyLayer(gl)
        adjustmentMaskMap.current.delete(id)
      }
    }

    if (state.activeTool === 'clone-stamp' && cloneStampStore.source) {
      if (!stateIds.has(cloneStampStore.source.layerId)) {
        cloneStampStore.clearSource()
      }
    }

    for (const ls of state.layers) {
      if ('type' in ls && ls.type === 'adjustment') continue
      const gl = map.get(ls.id)
      if (!gl) continue
      gl.opacity   = 'opacity'   in ls ? ls.opacity   : 1
      gl.visible   = ls.visible
      gl.blendMode = 'blendMode' in ls ? ls.blendMode : 'normal'
      // Re-rasterize text layers whenever their state changes (text, style, position, color).
      // While a text layer is being edited, blank its bitmap so only the textarea is visible.
      if ('type' in ls && ls.type === 'text') {
        // Always reset offset — move tool may have shifted it temporarily for preview.
        gl.offsetX = 0
        gl.offsetY = 0
        if (ls.id === editingLayerId) {
          gl.data.fill(0)
        } else {
          rasterizeTextToLayer(ls, gl)
        }
        renderer.flushLayer(gl)
      } else if ('type' in ls && ls.type === 'shape') {
        // Re-rasterize whenever shape parameters change
        const cw = renderer.pixelWidth
        const ch = renderer.pixelHeight
        rasterizeShapeToLayer(ls, gl, cw, ch)
        renderer.flushLayer(gl)
      }
    }

    doRender()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.layers, isActive, editingLayerId])

  useEffect(() => {
    if (!isActive) return
    doRender()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.swatches, isActive])

  useEffect(() => {
    if (!isActive) return
    doRender()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.canvas.tiledMode, state.canvas.showTileGrid, isActive])

  useEffect(() => {
    if (!isActive || !state.canvas.tiledMode) return
    const viewport = viewportRef.current
    if (!viewport) return
    const dpr = window.devicePixelRatio
    const zoom = zoomRef.current
    viewport.scrollLeft = width * zoom / dpr
    viewport.scrollTop  = height * zoom / dpr
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.canvas.tiledMode, isActive])

  useEffect(() => {
    if (!isActive) return
    const unsubscribe = adjustmentPreviewStore.subscribe(() => {
      const renderer = rendererRef.current
      if (!renderer) return
      doRender()
    })
    return unsubscribe
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])

  useEffect(() => {
    if (!isActive || state.activeTool !== 'transform') return
    const redraw = (): void => {
      const oc = toolOverlayRef.current
      if (!oc) return
      drawTransformOverlay(oc, transformStore, zoomRef.current)
    }
    redraw()
    transformStore.subscribe(redraw)
    return () => {
      transformStore.unsubscribe(redraw)
      const oc = toolOverlayRef.current
      if (oc) {
        const ctx = oc.getContext('2d')
        ctx?.clearRect(0, 0, oc.width, oc.height)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, state.activeTool])

  useEffect(() => {
    if (!isActive || state.activeTool !== 'clone-stamp') return
    const redraw = (): void => {
      const oc = toolOverlayRef.current
      if (!oc) return
      const canvas = canvasRef.current
      if (canvas) canvas.style.cursor = cloneStampStore.source ? 'none' : 'crosshair'
      if (!cloneStampStore.source) {
        oc.getContext('2d')?.clearRect(0, 0, oc.width, oc.height)
        return
      }
      drawCloneStampOverlay(
        oc,
        cloneStampStore.source.x,
        cloneStampStore.source.y,
        cursorStore.x,
        cursorStore.y,
        cloneStampOptions.aligned,
      )
    }

    redraw()
    cloneStampStore.subscribe(redraw)
    return () => {
      cloneStampStore.unsubscribe(redraw)
      const oc = toolOverlayRef.current
      oc?.getContext('2d')?.clearRect(0, 0, oc.width, oc.height)
      const canvas = canvasRef.current
      if (canvas) canvas.style.cursor = ''
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, state.activeTool])

  // Cursor updates for polygonal selection (drawing handled by useMarchingAnts)
  useEffect(() => {
    if (!isActive || state.activeTool !== 'polygonal-selection') return

    const updateCursor = (): void => {
      if (canvasRef.current) {
        canvasRef.current.style.cursor = polygonalSelectionStore.nearClose ? 'cell' : 'crosshair'
      }
    }

    updateCursor()
    polygonalSelectionStore.subscribe(updateCursor)
    return () => { polygonalSelectionStore.unsubscribe(updateCursor) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, state.activeTool])

  // ── Object selection overlay ──────────────────────────────────────────────────
  useEffect(() => {
    if (!isActive || state.activeTool !== 'object-selection') return

    const redraw = (): void => {
      const oc = toolOverlayRef.current
      if (!oc) return
      const ctx2d = oc.getContext('2d')
      if (!ctx2d) return
      ctx2d.clearRect(0, 0, oc.width, oc.height)

      const store = objectSelectionStore

      // Draw drag rectangle
      if (store.dragRect) {
        const { x1, y1, x2, y2 } = store.dragRect
        const rx = Math.min(x1, x2)
        const ry = Math.min(y1, y2)
        const rw = Math.abs(x2 - x1)
        const rh = Math.abs(y2 - y1)
        ctx2d.strokeStyle = 'rgba(0,0,0,0.6)'
        ctx2d.lineWidth = 2
        ctx2d.setLineDash([5, 4])
        ctx2d.strokeRect(rx, ry, rw, rh)
        ctx2d.strokeStyle = 'white'
        ctx2d.lineWidth = 1
        ctx2d.setLineDash([5, 4])
        ctx2d.strokeRect(rx, ry, rw, rh)
        ctx2d.setLineDash([])
      }

      // Draw point prompts
      for (const pt of store.points) {
        const color = pt.positive ? '#22cc44' : '#ee3333'
        ctx2d.beginPath()
        ctx2d.arc(pt.x, pt.y, 6, 0, Math.PI * 2)
        ctx2d.fillStyle = color
        ctx2d.fill()
        ctx2d.strokeStyle = 'white'
        ctx2d.lineWidth = 1.5
        ctx2d.setLineDash([])
        ctx2d.stroke()
        ctx2d.fillStyle = 'white'
        ctx2d.font = 'bold 9px sans-serif'
        ctx2d.textAlign = 'center'
        ctx2d.textBaseline = 'middle'
        ctx2d.fillText(pt.positive ? '+' : '\u2212', pt.x, pt.y)
      }
    }

    redraw()
    objectSelectionStore.subscribe(redraw)

    return () => {
      objectSelectionStore.unsubscribe(redraw)
      const oc = toolOverlayRef.current
      oc?.getContext('2d')?.clearRect(0, 0, oc.width, oc.height)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, state.activeTool])

  function buildMaskMap(): Map<string, GpuLayer> {
    const maskMap = new Map<string, GpuLayer>()
    for (const ls of state.layers) {
      if ('type' in ls && ls.type === 'mask' && ls.visible) {
        const gl = glLayersRef.current.get(ls.id)
        if (gl) maskMap.set((ls as MaskLayerState).parentId, gl)
      }
    }
    return maskMap
  }

  function buildOrderedGLLayers(): GpuLayer[] {
    const map = glLayersRef.current
    // Exclude mask and adjustment layers — mask applied via buildMaskMap, adjustments via renderPlan
    const layers = state.layers
      .filter((ls) => !('type' in ls && (ls.type === 'mask' || ls.type === 'adjustment')))
      .map((ls) => map.get(ls.id))
      .filter((l): l is GpuLayer => !!l)
    // Include any pending new pixel layer before state re-renders with it
    const pending = newPixelLayerRef.current
    if (pending && !layers.some(l => l === pending)) layers.push(pending)
    return layers
  }

  function buildRenderPlan(): RenderPlanEntry[] {
    const plan = buildCanvasRenderPlan(
      state.layers,
      glLayersRef.current,
      buildMaskMap(),
      adjustmentMaskMap.current,
      adjustmentPreviewStore.snapshot(),
      state.swatches,
      state.pixelFormat,
    )
    const pending = newPixelLayerRef.current
    if (pending && !plan.some(e => e.kind === 'layer' && e.layer === pending)) {
      plan.push({ kind: 'layer', layer: pending })
    }
    return plan
  }

  useEffect(() => {
    if (!isActive) return
    const sel = state.activeTool
    if (sel !== 'select' && sel !== 'lasso' && sel !== 'magic-wand') {
      selectionStore.setPending(null)
    }
    toolHandlerRef.current = TOOL_REGISTRY[state.activeTool].createHandler()
    // Cancel any in-progress polygonal selection when switching tools
    polygonalSelectionStore.cancel()
    if (sel !== 'object-selection') objectSelectionStore.reset()
    // Hide brush cursor when switching away from a circle-cursor tool
    if (brushCursorRef.current) {
      if (sel !== 'brush' && sel !== 'eraser' && sel !== 'clone-stamp') {
        brushCursorRef.current.style.display = 'none'
      }
      // Always reset the class so brushCursorCrossHair doesn't linger when switching between circle-cursor tools
      brushCursorRef.current.className = styles.brushCursor
    }
    if (pixelBrushCursorRef.current) pixelBrushCursorRef.current.style.display = 'none'
  }, [state.activeTool, isActive])

  const buildCtx = (): ToolContext | null => {
    const renderer = rendererRef.current
    if (!renderer) return null
    const activeId = state.activeLayerId
    let activeLayer = activeId ? glLayersRef.current.get(activeId) : undefined

    // Text/shape tools don't need an existing pixel layer — they create their own
    if (!activeLayer && state.activeTool !== 'text' && state.activeTool !== 'shape') return null
    // Block pixel-modifying tools on locked layers and on non-pixel layers (text, shape, group, adjustment).
    // Mask layers are allowed — tools paint grayscale onto the mask buffer.
    if (TOOL_REGISTRY[state.activeTool].modifiesPixels) {
      const stateMeta = state.layers.find((l) => l.id === activeId)
      if (stateMeta && 'locked' in stateMeta && stateMeta.locked) return null
      const isParametric = stateMeta && 'type' in stateMeta && stateMeta.type !== 'mask'
      if (isParametric && !TOOL_REGISTRY[state.activeTool].worksOnAllLayers) return null
    }
    // Detect mask layer — constrain colors to grayscale
    const activeMeta = state.layers.find((l) => l.id === activeId)
    const isMaskLayer = activeMeta && 'type' in activeMeta && activeMeta.type === 'mask'
    const toGray = (c: { r: number; g: number; b: number; a: number }) => {
      const g = Math.round(0.299 * c.r + 0.587 * c.g + 0.114 * c.b)
      return { r: g, g: g, b: g, a: 255 }
    }
    return {
      renderer,
      layer: activeLayer!, // text tool never dereferences this; all others are guarded above
      layers: buildOrderedGLLayers(),
      primaryColor: isMaskLayer ? toGray(state.primaryColor) : state.primaryColor,
      secondaryColor: isMaskLayer ? toGray(state.secondaryColor) : state.secondaryColor,
      selectionMask: selectionStore.mask,
      render: () => {
        doRender()
      },
      growLayerToFit: (canvasX: number, canvasY: number, extraRadius = 0): void => {
        // Mask layers are always full-canvas sized — never grow them.
        // Growing a mask shifts its existing pixel data to a non-zero offset inside
        // the new larger buffer, while new regions are zero-initialized (R=0 = hide).
        // The shader samples the mask at canvas UV [0,1]², so a shifted/grown mask
        // causes the parent layer to appear invisible ("squished mask" artifact).
        if (isMaskLayer) return
        // Tiled mode: wrap the coord into canvas range. blendPixelOver applies the
        // same wrap before bounds-checking against the layer rect, so the layer
        // must cover the wrapped destination, not the raw out-of-canvas input.
        if (state.canvas.tiledMode) {
          const W = renderer.pixelWidth
          const H = renderer.pixelHeight
          canvasX = ((canvasX % W) + W) % W
          canvasY = ((canvasY % H) + H) % H
        }
        renderer.growLayerToFit(activeLayer!, canvasX, canvasY, extraRadius)
      },
      setColor: (color) => {
        dispatch({ type: 'SET_PRIMARY_COLOR', payload: isMaskLayer ? toGray(color) : color })
      },
      commitStroke: (label: string) => {
        onStrokeEndRef.current?.(label)
      },
      overlayCanvas: toolOverlayRef.current,
      addTextLayer: (ls) => {
        const cw = renderer.pixelWidth
        const ch = renderer.pixelHeight
        const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0)
        rasterizeTextToLayer(ls, gl)
        renderer.flushLayer(gl)
        glLayersRef.current.set(ls.id, gl)
        doRender()
        dispatch({ type: 'ADD_TEXT_LAYER', payload: ls })
        setEditingLayerId(ls.id)
      },
      updateTextLayer: (ls) => {
        dispatch({ type: 'UPDATE_TEXT_LAYER', payload: ls })
      },
      openTextLayerEditor: (id) => {
        dispatch({ type: 'SET_ACTIVE_LAYER', payload: id })
        setEditingLayerId(id)
      },
      textLayers: state.layers.filter(
        (l): l is TextLayerState => 'type' in l && l.type === 'text'
      ),
      previewTextAt: (ls, x, y) => {
        const gl = glLayersRef.current.get(ls.id)
        if (!gl) return
        rasterizeTextToLayer({ ...ls, x, y }, gl)
        renderer.flushLayer(gl)
        doRender()
      },
      addShapeLayer: (ls) => {
        const cw = renderer.pixelWidth
        const ch = renderer.pixelHeight
        const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0)
        rasterizeShapeToLayer(ls, gl, cw, ch)
        renderer.flushLayer(gl)
        glLayersRef.current.set(ls.id, gl)
        doRender()
        dispatch({ type: 'ADD_SHAPE_LAYER', payload: ls })
      },
      updateShapeLayer: (ls) => {
        dispatch({ type: 'UPDATE_SHAPE_LAYER', payload: ls })
      },
      previewShapeLayer: (ls) => {
        const gl = glLayersRef.current.get(ls.id)
        if (!gl) return
        const cw = renderer.pixelWidth
        const ch = renderer.pixelHeight
        rasterizeShapeToLayer(ls, gl, cw, ch)
        renderer.flushLayer(gl)
        doRender()
      },
      shapeLayers: state.layers.filter(
        (l): l is ShapeLayerState => 'type' in l && l.type === 'shape'
      ),
      activeShapeLayer: (() => {
        const l = state.layers.find((l) => l.id === activeId)
        return l && 'type' in l && l.type === 'shape' ? l : null
      })(),
      zoom: state.canvas.zoom,
      tiledMode: state.canvas.tiledMode,
    }
  }

  const { handlePointerDown, handlePointerMove, handlePointerUp, handlePointerLeave } = useCanvas({
    onPointerDown: (pos) => {
      const ctx = buildCtx()
      if (ctx) toolHandlerRef.current.onPointerDown(pos, ctx)
    },
    onPointerMove: (pos) => {
      const ctx = buildCtx()
      if (ctx) toolHandlerRef.current.onPointerMove(pos, ctx)
    },
    onPointerMoveBatch: (positions) => {
      // Pen coalesced-event batch: accumulate all CPU drawing first, then do a
      // single GPU texture upload + composite render at the end.
      // This reduces GPU work from N×(flushLayer + render) to 1×(flushLayer + render)
      // per display frame — critical for Wacom pens on large (4K) canvases.
      const renderer = rendererRef.current
      const ctx = buildCtx()
      if (!ctx || !renderer) return

      // Suppress GPU uploads and renders during the loop
      renderer.deferFlush = true
      const noopRender = (): void => { /* deferred */ }
      for (const pos of positions) {
        toolHandlerRef.current.onPointerMove(pos, { ...ctx, render: noopRender })
      }

      // Single GPU flush + composite after all CPU drawing is complete
      renderer.deferFlush = false
      renderer.flushLayer(ctx.layer)
      ctx.render()
    },
    onPointerUp: (pos) => {
      const ctx = buildCtx()
      if (ctx) toolHandlerRef.current.onPointerUp(pos, ctx)
      newPixelLayerRef.current = null
      const def = TOOL_REGISTRY[state.activeTool]
      if (def.modifiesPixels && !def.skipAutoHistory && ctx) {
        const label = state.activeTool.charAt(0).toUpperCase() + state.activeTool.slice(1)
        onStrokeEndRef.current?.(label)
      }
    },
    onHover: (pos) => {
      if (isActive) cursorStore.setPosition(pos.x, pos.y)
      // Update circle cursor for brush / eraser / clone-stamp / dodge / burn
      const tool = state.activeTool
      if ((tool === 'brush' || tool === 'eraser' || tool === 'clone-stamp' || tool === 'dodge' || tool === 'burn') && brushCursorRef.current) {
        const dpr = window.devicePixelRatio
        const zoom = zoomRef.current
        const size = tool === 'brush' ? brushOptions.size
                   : tool === 'eraser' ? eraserOptions.size
                   : tool === 'dodge' ? dodgeOptions.size
                   : tool === 'burn' ? burnOptions.size
                   : cloneStampOptions.size
        const r = Math.max(1, size / 2 * zoom / dpr)
        const cx = (pos.x) * zoom / dpr
        const cy = (pos.y) * zoom / dpr
        const el = brushCursorRef.current
        el.style.left   = `${cx - r}px`
        el.style.top    = `${cy - r}px`
        el.style.width  = `${r * 2}px`
        el.style.height = `${r * 2}px`
        if (tool === 'clone-stamp') {
          el.style.display = cloneStampStore.source ? 'block' : 'none'
          el.className = `${styles.brushCursor} ${styles.brushCursorCrossHair}`
        } else {
          el.style.display = 'block'
          el.className = styles.brushCursor
        }
      }
      if (tool === 'pencil' && pixelBrushCursorRef.current) {
        const { r, g, b, a } = state.primaryColor
        const dpr  = window.devicePixelRatio
        const zoom = zoomRef.current
        const preview = pencilOptions.pixelBrush
          ? getPencilBrushPreviewDataUrl(r, g, b, a)
          : getPencilShapePreviewDataUrl(r, g, b, a)
        if (preview) {
          let canvasX = pos.x, canvasY = pos.y
          if (pencilOptions.pixelBrush && pencilOptions.snapToBrush && 'tileW' in preview) {
            canvasX = Math.round(pos.x / preview.tileW) * preview.tileW
            canvasY = Math.round(pos.y / preview.tileH) * preview.tileH
          }
          const previewW = 'previewW' in preview ? preview.previewW : preview.size
          const previewH = 'previewH' in preview ? preview.previewH : preview.size
          const scaledW = previewW * zoom / dpr
          const scaledH = previewH * zoom / dpr
          const screenX = (canvasX + 0.5) * zoom / dpr - scaledW / 2
          const screenY = (canvasY + 0.5) * zoom / dpr - scaledH / 2
          const el = pixelBrushCursorRef.current
          el.style.display          = 'block'
          el.style.left             = `${screenX}px`
          el.style.top              = `${screenY}px`
          el.style.width            = `${scaledW}px`
          el.style.height           = `${scaledH}px`
          el.style.backgroundImage  = `url("${preview.dataUrl}")`
          el.style.backgroundSize   = '100% 100%'
        } else {
          pixelBrushCursorRef.current.style.display = 'none'
        }
      } else if (pixelBrushCursorRef.current && pixelBrushCursorRef.current.style.display !== 'none') {
        pixelBrushCursorRef.current.style.display = 'none'
      }
      if (tool === 'pencil' && canvasRef.current) {
        canvasRef.current.style.cursor = 'none'
      }
      const ctx = buildCtx()
      if (ctx) toolHandlerRef.current.onHover?.(pos, ctx)
    },
    onLeave: () => {
      const ctx = buildCtx()
      if (ctx) toolHandlerRef.current.onLeave?.(ctx)
    },
  })

  // Stable offset object for the tiled canvas second useCanvas call
  const tiledOffset = useMemo(() => ({ x: width, y: height }), [width, height])

  const { handlePointerDown: handleTiledPointerDown, handlePointerMove: handleTiledPointerMove, handlePointerUp: handleTiledPointerUp, handlePointerLeave: handleTiledPointerLeave } = useCanvas({
    onPointerDown: (pos) => {
      const ctx = buildCtx()
      if (ctx) toolHandlerRef.current.onPointerDown(pos, ctx)
    },
    onPointerMove: (pos) => {
      const ctx = buildCtx()
      if (ctx) toolHandlerRef.current.onPointerMove(pos, ctx)
    },
    onPointerMoveBatch: (positions) => {
      const renderer = rendererRef.current
      const ctx = buildCtx()
      if (!ctx || !renderer) return
      renderer.deferFlush = true
      const noopRender = (): void => { /* deferred */ }
      for (const pos of positions) {
        toolHandlerRef.current.onPointerMove(pos, { ...ctx, render: noopRender })
      }
      renderer.deferFlush = false
      renderer.flushLayer(ctx.layer)
      ctx.render()
    },
    onPointerUp: (pos) => {
      const ctx = buildCtx()
      if (ctx) toolHandlerRef.current.onPointerUp(pos, ctx)
      newPixelLayerRef.current = null
      const def = TOOL_REGISTRY[state.activeTool]
      if (def.modifiesPixels && !def.skipAutoHistory && ctx) {
        const label = state.activeTool.charAt(0).toUpperCase() + state.activeTool.slice(1)
        onStrokeEndRef.current?.(label)
      }
    },
    onHover: (pos) => {
      if (isActive) cursorStore.setPosition(pos.x, pos.y)
      const tool = state.activeTool
      if ((tool === 'brush' || tool === 'eraser' || tool === 'clone-stamp' || tool === 'dodge' || tool === 'burn') && brushCursorRef.current) {
        const dpr = window.devicePixelRatio
        const zoom = zoomRef.current
        const size = tool === 'brush' ? brushOptions.size
                   : tool === 'eraser' ? eraserOptions.size
                   : tool === 'dodge' ? dodgeOptions.size
                   : tool === 'burn' ? burnOptions.size
                   : cloneStampOptions.size
        const r = Math.max(1, size / 2 * zoom / dpr)
        // In tiled mode, coordinates are in [-W, 2W). Map to wrapper-space:
        const cx = (pos.x + width) * zoom / dpr
        const cy = (pos.y + height) * zoom / dpr
        const el = brushCursorRef.current
        el.style.left   = `${cx - r}px`
        el.style.top    = `${cy - r}px`
        el.style.width  = `${r * 2}px`
        el.style.height = `${r * 2}px`
        if (tool === 'clone-stamp') {
          el.style.display = cloneStampStore.source ? 'block' : 'none'
          el.className = `${styles.brushCursor} ${styles.brushCursorCrossHair}`
        } else {
          el.style.display = 'block'
          el.className = styles.brushCursor
        }
      }
      const ctx = buildCtx()
      if (ctx) toolHandlerRef.current.onHover?.(pos, ctx)
    },
    onLeave: () => {
      const ctx = buildCtx()
      if (ctx) toolHandlerRef.current.onLeave?.(ctx)
    },
    coordinateOffset: tiledOffset,
  })

  return (
    <>
    <div ref={viewportRef} className={styles.viewport} data-canvas-viewport data-active-viewport={isActive ? '' : undefined}>
      <div className={styles.viewportInner}>
        <div
          ref={canvasWrapperRef}
          className={styles.canvasWrapper}
          style={{
            width:  (state.canvas.tiledMode ? 3 : 1) * width  * state.canvas.zoom / window.devicePixelRatio,
            height: (state.canvas.tiledMode ? 3 : 1) * height * state.canvas.zoom / window.devicePixelRatio,
          }}
        >
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            width={width}
            height={height}
            style={{
              display: state.canvas.tiledMode ? 'none' : 'block',
              width:  width  * state.canvas.zoom / window.devicePixelRatio,
              height: height * state.canvas.zoom / window.devicePixelRatio,
              cursor: (state.activeTool === 'brush' || state.activeTool === 'eraser' || state.activeTool === 'dodge' || state.activeTool === 'burn') ? 'none'
                    : state.activeTool === 'pencil' ? 'none'
                    : (state.activeTool === 'polygonal-selection') ? 'crosshair'
                    : undefined,
              // Bilinear when zoomed out (smooth downscale); nearest when at or above 100% (crisp pixel art)
              imageRendering: state.canvas.zoom < 1 ? 'auto' : 'pixelated',
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerLeave}
            aria-label={`Canvas ${width}\u00d7${height}`}
          />
          {state.canvas.tiledMode && (
            <canvas
              ref={tiledCanvasRef}
              width={3 * width}
              height={3 * height}
              style={{
                position: 'absolute',
                top: 0, left: 0,
                width: '100%', height: '100%',
                cursor: (state.activeTool === 'brush' || state.activeTool === 'eraser' || state.activeTool === 'dodge' || state.activeTool === 'burn') ? 'none'
                      : state.activeTool === 'pencil' ? 'none'
                      : state.activeTool === 'polygonal-selection' ? 'crosshair'
                      : undefined,
                imageRendering: state.canvas.zoom < 1 ? 'auto' : 'pixelated',
                touchAction: 'none',
              }}
              onPointerDown={handleTiledPointerDown}
              onPointerMove={handleTiledPointerMove}
              onPointerUp={handleTiledPointerUp}
              onPointerLeave={handleTiledPointerLeave}
            />
          )}
          <canvas
            ref={toolOverlayRef}
            className={styles.overlay}
            width={width}
            height={height}
          />
          <div ref={brushCursorRef} className={styles.brushCursor} />
          <div ref={pixelBrushCursorRef} className={styles.pixelBrushCursor} />
          {state.canvas.showGrid && (() => {
            const { gridType, gridColor, gridSize, zoom } = state.canvas
            const dpr = window.devicePixelRatio
            const cellPx = gridSize * zoom / dpr

            if (gridType === 'normal') {
              return (
                <div
                  className={styles.gridOverlay}
                  style={{
                    '--grid-size': `${cellPx}px`,
                    '--grid-color': gridColor,
                  } as React.CSSProperties}
                />
              )
            }

            const svgStyle: React.CSSProperties = {
              position: 'absolute', top: 0, left: 0,
              width: '100%', height: '100%',
              pointerEvents: 'none', zIndex: 2,
              overflow: 'visible',
            }
            const stroke = gridColor
            const sw = Math.max(1, zoom / dpr)

            if (gridType === 'thirds') {
              return (
                <svg style={svgStyle} viewBox="0 0 100 100" preserveAspectRatio="none">
                  <line x1="33.333" y1="0" x2="33.333" y2="100" stroke={stroke} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
                  <line x1="66.667" y1="0" x2="66.667" y2="100" stroke={stroke} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
                  <line x1="0" y1="33.333" x2="100" y2="33.333" stroke={stroke} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
                  <line x1="0" y1="66.667" x2="100" y2="66.667" stroke={stroke} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
                </svg>
              )
            }

            // safe-zone: action safe 80%, title safe 90%
            return (
              <svg style={svgStyle} viewBox="0 0 100 100" preserveAspectRatio="none">
                {/* Title safe – 90% */}
                <rect x="5" y="5" width="90" height="90" fill="none" stroke={stroke} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
                {/* Action safe – 80% */}
                <rect x="10" y="10" width="80" height="80" fill="none" stroke={stroke} strokeWidth={sw} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
                {/* Centre crosshair */}
                <line x1="49" y1="50" x2="51" y2="50" stroke={stroke} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
                <line x1="50" y1="49" x2="50" y2="51" stroke={stroke} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
              </svg>
            )
          })()}
        </div>
      </div>
      {/* Marching-ants overlay: viewport-sized, screen-space, never scrolls */}
      <canvas ref={overlayRef} className={styles.antsOverlay} />
    </div>
    <TextLayerEditor
      editingLayerId={editingLayerId}
      layers={state.layers}
      zoom={state.canvas.zoom}
      canvasWrapperRef={canvasWrapperRef}
      onCommit={(ls) => dispatch({ type: 'UPDATE_TEXT_LAYER', payload: ls })}
      onClose={() => {
        onStrokeEndRef.current?.('Text')
        setEditingLayerId(null)
      }}
    />
    </>
  )
})

