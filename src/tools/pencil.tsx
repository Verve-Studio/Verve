import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { bresenham, blendPixelOver } from './algorithm/primitives'
import { walkQuadBezier, stampAirbrush } from './algorithm/brushStroke'
import type { BrushShape } from './algorithm/brushStroke'
import { SliderInput } from '@/ux/widgets/SliderInput/SliderInput'
import { useAppContext } from '@/core/store/AppContext'
import { selectionStore } from '@/core/store/selectionStore'
import { pixelBrushStore } from '@/core/store/pixelBrushStore'
import { PixelBrushGallery } from '@/ux/widgets/PixelBrushGallery/PixelBrushGallery'
import { PixelBrushesModal } from '@/ux/modals/PixelBrushesModal/PixelBrushesModal'
import type { PixelBrush } from '@/types'
import type { WebGPURenderer } from '@/graphicspipeline/webgpu/rendering/WebGPURenderer'
import type { GpuLayer } from '@/graphicspipeline/webgpu/rendering/WebGPURenderer'
import type { ToolDefinition, ToolHandler, ToolPointerPos, ToolContext, ToolOptionsStyles } from './types'

// ─── Shared options ───────────────────────────────────────────────────────────

export const pencilOptions = {
  size:         1,
  opacity:      100,
  shape:        'round' as BrushShape,
  pixelPerfect: false,  // Aseprite-style: remove L-corner pixels for clean diagonals
  antiAlias:    true,
  smoothing:    20,     // 0 = raw coords, 100 = maximum stabilizer (size > 1 only)
  motionBlur:   5,      // 0 = round dabs, 100 = dabs elongated along stroke direction (size > 1)
  /** The currently active pixel brush. null = use the standard shape-based pencil. */
  pixelBrush:   null as PixelBrush | null,
  /**
   * Snap brush position to a grid aligned to the brush dimensions so stamps
   * never overlap each other — only effective when a pixel brush is active.
   */
  snapToBrush: false,
}

/**
 * Snap canvas coordinates to the nearest brush-grid position.
 * The grid cell size matches the brush dimensions, so stamps tile perfectly.
 */
function snapToBrushGrid(x: number, y: number, brush: PixelBrush): { x: number; y: number } {
  const gx = Math.round(x / brush.width)  * brush.width
  const gy = Math.round(y / brush.height) * brush.height
  return { x: gx, y: gy }
}

// ─── Pixel brush stamp cache ──────────────────────────────────────────────────

/** Cache decoded RGBA bytes so we don't re-decode on every pointer event. */
const brushPixelCache = new Map<string, Uint8ClampedArray>()

function getBrushPixels(brush: PixelBrush): Uint8ClampedArray {
  if (brushPixelCache.has(brush.id)) return brushPixelCache.get(brush.id)!
  const bin = atob(brush.rgba)
  const bytes = new Uint8ClampedArray(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  brushPixelCache.set(brush.id, bytes)
  return bytes
}

/**
 * Returns a CSS data-URL for the current pixel brush rendered with the given primary
 * color, pencilOptions.size, pencilOptions.shape, and pencilOptions.opacity.
 * Cached by a composite key so it regenerates only when something relevant changes.
 * Returns null if no pixel brush is active.
 *
 * - previewW / previewH: dimensions of the rendered preview image (= size when size > 1, else brush tile size)
 * - tileW / tileH: brush tile dimensions, used to align the snap grid in Canvas
 */
let _brushPreviewCache: { key: string; dataUrl: string; previewW: number; previewH: number } | null = null

export function getPencilBrushPreviewDataUrl(
  r: number, g: number, b: number, a: number,
): { dataUrl: string; previewW: number; previewH: number; tileW: number; tileH: number } | null {
  const brush = pencilOptions.pixelBrush
  if (!brush) return null

  const { size, shape, opacity } = pencilOptions
  const cacheKey = `${brush.id}_${size}_${shape}_${opacity}_${r}_${g}_${b}_${a}`

  if (_brushPreviewCache?.key === cacheKey) {
    return {
      dataUrl:  _brushPreviewCache.dataUrl,
      previewW: _brushPreviewCache.previewW,
      previewH: _brushPreviewCache.previewH,
      tileW: brush.width,
      tileH: brush.height,
    }
  }

  const pixels = getBrushPixels(brush)
  const fa = a / 255  // primary color alpha factor (0–1)

  if (size <= 1) {
    // For size=1 the brush is a tiling mask — only one pixel is ever painted at
    // the cursor position. Show a 1×1 preview so the cursor matches reality.
    const cvs = document.createElement('canvas')
    cvs.width = 1; cvs.height = 1
    const ctx = cvs.getContext('2d')!
    const imgData = ctx.createImageData(1, 1)
    imgData.data[0] = r
    imgData.data[1] = g
    imgData.data[2] = b
    imgData.data[3] = Math.round((opacity / 100) * fa * 255)
    ctx.putImageData(imgData, 0, 0)
    const dataUrl = cvs.toDataURL()
    _brushPreviewCache = { key: cacheKey, dataUrl, previewW: 1, previewH: 1 }
    return { dataUrl, previewW: 1, previewH: 1, tileW: brush.width, tileH: brush.height }
  }

  // size > 1: stamp footprint with shape + tiling brush mask
  const half   = Math.floor(size / 2)
  const radius = (size - 1) / 2
  const cvs = document.createElement('canvas')
  cvs.width = size; cvs.height = size
  const ctx2 = cvs.getContext('2d')!
  const imgData = ctx2.createImageData(size, size)
  const d = imgData.data
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const dx = i - half
      const dy = j - half
      const ox = dx - (radius - half)
      const oy = dy - (radius - half)
      let inside: boolean
      if (shape === 'square') {
        inside = true
      } else if (shape === 'diamond') {
        inside = (Math.abs(ox) + Math.abs(oy)) / Math.SQRT2 <= radius
      } else {
        inside = ox * ox + oy * oy <= radius * radius
      }
      if (!inside) continue
      const bx = ((i % brush.width)  + brush.width)  % brush.width
      const by = ((j % brush.height) + brush.height) % brush.height
      const brushA = pixels[(by * brush.width + bx) * 4 + 3]
      if (brushA === 0) continue
      const idx = (j * size + i) * 4
      d[idx]     = r
      d[idx + 1] = g
      d[idx + 2] = b
      d[idx + 3] = Math.round((brushA / 255) * (opacity / 100) * fa * 255)
    }
  }
  ctx2.putImageData(imgData, 0, 0)
  const dataUrl = cvs.toDataURL()
  _brushPreviewCache = { key: cacheKey, dataUrl, previewW: size, previewH: size }
  return { dataUrl, previewW: size, previewH: size, tileW: brush.width, tileH: brush.height }
}

/** Invalidate the preview cache (call when the active brush changes). */
export function invalidatePencilBrushPreview(): void {
  _brushPreviewCache = null
}

/**
 * Returns a CSS data-URL for the standard (no pixel brush) pencil tip shape
 * based on pencilOptions.size, pencilOptions.shape, pencilOptions.opacity, and
 * the given primary color. Returns null when size <= 1 (single pixel — too small
 * to preview meaningfully as an image; show a simple dot cursor instead).
 */
let _shapePreviewCache: { key: string; dataUrl: string; size: number } | null = null

export function getPencilShapePreviewDataUrl(
  r: number, g: number, b: number, a: number,
): { dataUrl: string; size: number } | null {
  const { size, shape, opacity } = pencilOptions
  if (pencilOptions.pixelBrush) return null  // handled by getPencilBrushPreviewDataUrl

  const cacheKey = `${size}_${shape}_${opacity}_${r}_${g}_${b}_${a}`
  if (_shapePreviewCache?.key === cacheKey) {
    return { dataUrl: _shapePreviewCache.dataUrl, size: _shapePreviewCache.size }
  }

  if (size <= 1) {
    // 1×1 dot
    const cvs = document.createElement('canvas')
    cvs.width = 1; cvs.height = 1
    const ctx = cvs.getContext('2d')!
    const imgData = ctx.createImageData(1, 1)
    const fa = a / 255
    imgData.data[0] = r; imgData.data[1] = g; imgData.data[2] = b
    imgData.data[3] = Math.round((opacity / 100) * fa * 255)
    ctx.putImageData(imgData, 0, 0)
    const dataUrl = cvs.toDataURL()
    _shapePreviewCache = { key: cacheKey, dataUrl, size: 1 }
    return { dataUrl, size: 1 }
  }

  const half   = Math.floor(size / 2)
  const radius = (size - 1) / 2
  const fa     = a / 255
  const alpha  = Math.round((opacity / 100) * fa * 255)
  const cvs = document.createElement('canvas')
  cvs.width = size; cvs.height = size
  const ctx = cvs.getContext('2d')!
  const imgData = ctx.createImageData(size, size)
  const d = imgData.data
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const dx = i - half
      const dy = j - half
      const ox = dx - (radius - half)
      const oy = dy - (radius - half)
      let inside: boolean
      if (shape === 'square') {
        inside = true
      } else if (shape === 'diamond') {
        inside = (Math.abs(ox) + Math.abs(oy)) / Math.SQRT2 <= radius
      } else {
        inside = ox * ox + oy * oy <= radius * radius
      }
      if (!inside) continue
      const idx = (j * size + i) * 4
      d[idx] = r; d[idx + 1] = g; d[idx + 2] = b; d[idx + 3] = alpha
    }
  }
  ctx.putImageData(imgData, 0, 0)
  const dataUrl = cvs.toDataURL()
  _shapePreviewCache = { key: cacheKey, dataUrl, size }
  return { dataUrl, size }
}

// ─── Module-level context refs (for selection capture from the Options UI) ────

/** Updated on every pointer event so the Options UI can capture selection pixels. */
let _renderer: WebGPURenderer | null = null
let _layer: GpuLayer | null = null

/** EMA alpha: fraction of the new sample mixed in each event (used for size > 1 path). */
function smoothingToAlpha(s: number): number {
  return Math.max(0.05, 1 - s / 100 * 0.92)
}

// ─── Pixel-perfect helpers ────────────────────────────────────────────────────

type Point = { x: number; y: number }

/**
 * Returns true if B is a redundant L-corner pixel between A and C.
 * An L-corner occurs when A→B is axis-aligned and B→C is also axis-aligned
 * but in the perpendicular direction — removing B still leaves A and C connected
 * diagonally, so B is unnecessary and creates a notch in the diagonal stroke.
 */
function isLCorner(a: Point, b: Point, c: Point): boolean {
  return (b.x === a.x && b.y === c.y) || (b.y === a.y && b.x === c.x)
}

// ─── Color shade helpers (for options UI) ─────────────────────────────────────

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  switch (max) {
    case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break
    case gn: h = (bn - rn) / d + 2; break
    case bn: h = (rn - gn) / d + 4; break
  }
  return [h / 6, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v] }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue2rgb = (p2: number, q2: number, t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p2 + (q2 - p2) * 6 * t
    if (t < 1 / 2) return q2
    if (t < 2 / 3) return p2 + (q2 - p2) * (2 / 3 - t) * 6
    return p2
  }
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ]
}

/** Generate 5 lightness variants of (r,g,b,a): 2 darker, base, 2 lighter. */
function getColorShades(
  r: number, g: number, b: number, a: number,
): Array<{ r: number; g: number; b: number; a: number }> {
  const [h, s, l] = rgbToHsl(r, g, b)
  return [-0.28, -0.14, 0, 0.14, 0.28].map(offset => {
    const nl = Math.max(0, Math.min(1, l + offset))
    const [nr, ng, nb] = hslToRgb(h, s, nl)
    return { r: nr, g: ng, b: nb, a }
  })
}

// ─── Pixel brush paint ───────────────────────────────────────────────────────

/**
 * Paint a single canvas pixel using the brush as a repeating tile mask.
 * Each canvas coordinate is looked up directly in the tile — the pattern
 * always stays at 1:1 pixel scale.
 */
function paintBrushPixel(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  canvasX: number,
  canvasY: number,
  brush: PixelBrush,
  pixels: Uint8ClampedArray,
  r: number, g: number, b: number, a: number,
  opacity: number,
  touched: Map<number, number>,
  sel?: { mask: Uint8Array; width: number } | null,
  tiledW?: number,
  tiledH?: number,
): void {
  const bx = ((canvasX % brush.width)  + brush.width)  % brush.width
  const by = ((canvasY % brush.height) + brush.height) % brush.height
  if (pixels[(by * brush.width + bx) * 4 + 3] === 0) return
  blendPixelOver(renderer, layer, canvasX, canvasY, r, g, b, a, opacity, touched, sel ?? undefined, tiledW, tiledH)
}

/**
 * Stamp a `size`-pixel footprint at (cx, cy) using the brush as a tiling mask.
 * The footprint shape follows the pencil's `shape` setting (round / square /
 * diamond) so the stroke profile matches the standard pencil.
 */
function paintBrushStamp(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  cx: number,
  cy: number,
  brush: PixelBrush,
  r: number, g: number, b: number, a: number,
  opacity: number,
  size: number,
  shape: BrushShape,
  touched: Map<number, number>,
  sel?: { mask: Uint8Array; width: number } | null,
  tiledW?: number,
  tiledH?: number,
): void {
  const pixels = getBrushPixels(brush)
  if (size <= 1) {
    paintBrushPixel(renderer, layer, cx, cy, brush, pixels, r, g, b, a, opacity, touched, sel, tiledW, tiledH)
    return
  }
  // Iterate a size×size axis-aligned bounding box so the painted footprint is
  // exactly `size` pixels on each side (works for both even and odd sizes).
  const half   = Math.floor(size / 2)
  const radius = (size - 1) / 2  // distance from the box's geometric centre to its edge
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const dx = i - half
      const dy = j - half
      // Offsets relative to the geometric centre, used by round/diamond tests.
      const ox = dx - (radius - half)   // = i - radius
      const oy = dy - (radius - half)   // = j - radius
      let inside: boolean
      if (shape === 'square') {
        inside = true
      } else if (shape === 'diamond') {
        inside = (Math.abs(ox) + Math.abs(oy)) / Math.SQRT2 <= radius
      } else {
        inside = ox * ox + oy * oy <= radius * radius
      }
      if (!inside) continue
      paintBrushPixel(renderer, layer, cx + dx, cy + dy, brush, pixels, r, g, b, a, opacity, touched, sel, tiledW, tiledH)
    }
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function createPencilHandler(): ToolHandler {
  // ── State for size > 1 bezier path ──
  let lastRendered: Point | null = null
  let lastCtrl:     Point | null = null
  let stabX = 0, stabY = 0

  // ── State for 1px Bresenham path ──
  // lastPx:    last Bresenham pixel emitted (end of previous segment)
  // ppPrev:    pixel before ppPending (L-shape left context)
  // ppPending: buffered pixel not yet drawn (waiting for next pixel as right context)
  let lastPx:    Point | null = null
  let ppPrev:    Point | null = null
  let ppPending: Point | null = null

  let touched: Map<number, number> | null = null

  // ── 1px helpers ────────────────────────────────────────────────────────────

  function paintOnePixel(px: number, py: number, ctx: ToolContext): void {
    const { renderer, layer, primaryColor, selectionMask, growLayerToFit } = ctx
    const { r, g, b, a } = primaryColor
    growLayerToFit(px, py, 2)
    const sel = selectionMask ? { mask: selectionMask, width: renderer.pixelWidth } : undefined
    const tiledW = ctx.tiledMode ? renderer.pixelWidth : undefined
    const tiledH = ctx.tiledMode ? renderer.pixelHeight : undefined
    blendPixelOver(renderer, layer, px, py, r, g, b, a, pencilOptions.opacity, touched ?? undefined, sel, tiledW, tiledH)
  }

  /**
   * Feed a new pixel into the pixel-perfect state machine.
   * Draws ppPending only after seeing the next pixel so L-corners can be skipped.
   */
  function addPPPixel(pt: Point, ctx: ToolContext): void {
    if (ppPending !== null) {
      if (ppPrev !== null && isLCorner(ppPrev, ppPending, pt)) {
        // ppPending is a redundant L-corner — discard it; ppPrev stays
      } else {
        paintOnePixel(ppPending.x, ppPending.y, ctx)
        ppPrev = ppPending
      }
      ppPending = null
    }
    ppPending = pt
  }

  /** Flush the buffered pending pixel at end of stroke. */
  function flushPPPending(ctx: ToolContext): void {
    if (ppPending !== null) {
      paintOnePixel(ppPending.x, ppPending.y, ctx)
      ppPending = null
    }
    ppPrev = null
  }

  /**
   * Draw from lastPx to (tx, ty) using Bresenham, with optional pixel-perfect
   * L-corner removal. Updates lastPx to the new endpoint.
   */
  function draw1pxSegment(tx: number, ty: number, ctx: ToolContext): void {
    if (!lastPx) return
    const x1 = Math.round(tx), y1 = Math.round(ty)
    if (lastPx.x === x1 && lastPx.y === y1) return

    const pixels: Point[] = []
    bresenham(lastPx.x, lastPx.y, x1, y1, (x, y) => pixels.push({ x, y }))

    // Skip pixel[0] — it equals lastPx and was already painted
    for (let i = 1; i < pixels.length; i++) {
      if (pencilOptions.pixelPerfect) {
        addPPPixel(pixels[i], ctx)
      } else {
        paintOnePixel(pixels[i].x, pixels[i].y, ctx)
      }
    }
    lastPx = { x: x1, y: y1 }
  }

  // ── Size > 1 bezier path ────────────────────────────────────────────────────

  function paint(
    p0x: number, p0y: number,
    cpx: number, cpy: number,
    p1x: number, p1y: number,
    ctx: ToolContext,
  ): void {
    const { renderer, layer, layers, primaryColor, selectionMask, render, growLayerToFit } = ctx
    const { r, g, b, a } = primaryColor
    const padR = Math.ceil(pencilOptions.size / 2) + 2
    growLayerToFit(Math.round(p0x), Math.round(p0y), padR)
    growLayerToFit(Math.round(cpx),  Math.round(cpy),  padR)
    growLayerToFit(Math.round(p1x), Math.round(p1y), padR)
    const sel = selectionMask ? { mask: selectionMask, width: renderer.pixelWidth } : undefined
    const tiledW = ctx.tiledMode ? renderer.pixelWidth  : undefined
    const tiledH = ctx.tiledMode ? renderer.pixelHeight : undefined
    walkQuadBezier(
      renderer, layer,
      p0x, p0y, cpx, cpy, p1x, p1y,
      pencilOptions.size, r, g, b, a, pencilOptions.opacity,
      100, // hardness always 100 for pencil
      pencilOptions.shape,
      pencilOptions.antiAlias,
      pencilOptions.motionBlur / 100,
      touched ?? undefined, sel,
      tiledW, tiledH,
    )

    // In tiled mode, wrapped writes may land anywhere on the layer — skip dirty
    // rect tracking and do a full upload, same as brush.tsx.
    if (!ctx.tiledMode) {
      const lx = Math.max(0, Math.floor(Math.min(p0x, cpx, p1x) - layer.offsetX) - padR)
      const ly = Math.max(0, Math.floor(Math.min(p0y, cpy, p1y) - layer.offsetY) - padR)
      const rx = Math.min(layer.layerWidth,  Math.ceil(Math.max(p0x, cpx, p1x) - layer.offsetX) + padR + 1)
      const ry = Math.min(layer.layerHeight, Math.ceil(Math.max(p0y, cpy, p1y) - layer.offsetY) + padR + 1)
      if (layer.dirtyRect === null) {
        layer.dirtyRect = { lx, ly, rx, ry }
      } else {
        layer.dirtyRect.lx = Math.min(layer.dirtyRect.lx, lx)
        layer.dirtyRect.ly = Math.min(layer.dirtyRect.ly, ly)
        layer.dirtyRect.rx = Math.max(layer.dirtyRect.rx, rx)
        layer.dirtyRect.ry = Math.max(layer.dirtyRect.ry, ry)
      }
    } else {
      layer.dirtyRect = null
    }

    renderer.flushLayer(layer)
    render(layers)
  }

  // ── ToolHandler ─────────────────────────────────────────────────────────────

  return {
    onPointerDown({ x, y }: ToolPointerPos, ctx: ToolContext) {
      _renderer = ctx.renderer
      _layer    = ctx.layer
      touched = new Map()

      const brush = pencilOptions.pixelBrush

      if (pencilOptions.size === 1 || brush) {
        // 1px path — direct Bresenham, no smoothing (also used for pixel brushes)
        lastRendered = null; lastCtrl = null
        let px = Math.round(x), py = Math.round(y)
        if (brush && pencilOptions.snapToBrush) {
          const snapped = snapToBrushGrid(x, y, brush)
          px = snapped.x; py = snapped.y
        }
        const { renderer, layer, layers, primaryColor, selectionMask, render, growLayerToFit } = ctx
        const { r, g, b, a } = primaryColor
        const sel = selectionMask ? { mask: selectionMask, width: renderer.pixelWidth } : undefined
        if (brush) {
          const pad = Math.ceil(pencilOptions.size / 2) + 2
          growLayerToFit(px, py, pad)
          paintBrushStamp(renderer, layer, px, py, brush, r, g, b, a, pencilOptions.opacity, pencilOptions.size, pencilOptions.shape, touched, sel ?? null, ctx.tiledMode ? renderer.pixelWidth : undefined, ctx.tiledMode ? renderer.pixelHeight : undefined)
        } else {
          growLayerToFit(px, py, 2)
          const tiledW = ctx.tiledMode ? renderer.pixelWidth : undefined
          const tiledH = ctx.tiledMode ? renderer.pixelHeight : undefined
          blendPixelOver(renderer, layer, px, py, r, g, b, a, pencilOptions.opacity, touched, sel, tiledW, tiledH)
        }
        lastPx    = { x: px, y: py }
        ppPrev    = { x: px, y: py }
        ppPending = null
        renderer.flushLayer(layer)
        render(layers)
      } else {
        // Bezier/dab path
        lastPx = null; ppPrev = null; ppPending = null
        stabX = x; stabY = y
        lastRendered = { x, y }
        lastCtrl     = { x, y }
        const { renderer, layer, layers, primaryColor, selectionMask, render, growLayerToFit } = ctx
        const { r, g, b, a } = primaryColor  // eslint-disable-line @typescript-eslint/no-unused-vars
        const padR = Math.ceil(pencilOptions.size / 2) + 2
        growLayerToFit(x, y, padR)
        const sel = selectionMask ? { mask: selectionMask, width: renderer.pixelWidth } : undefined
        stampAirbrush(
          renderer, layer, x, y,
          pencilOptions.size, r, g, b, a, pencilOptions.opacity,
          100, pencilOptions.shape, pencilOptions.antiAlias,
          touched ?? undefined, sel,
        )
        renderer.flushLayer(layer)
        render(layers)
      }
    },

    onPointerMove({ x, y }: ToolPointerPos, ctx: ToolContext) {
      _renderer = ctx.renderer
      _layer    = ctx.layer

      const brush = pencilOptions.pixelBrush

      if (pencilOptions.size === 1 || brush) {
        if (!lastPx) return
        let x1 = Math.round(x), y1 = Math.round(y)
        if (brush && pencilOptions.snapToBrush) {
          const snapped = snapToBrushGrid(x, y, brush)
          x1 = snapped.x; y1 = snapped.y
        }
        if (lastPx.x === x1 && lastPx.y === y1) return
        const { renderer, layer, layers, primaryColor, selectionMask, render, growLayerToFit } = ctx
        const { r, g, b, a } = primaryColor
        const sel = selectionMask ? { mask: selectionMask, width: renderer.pixelWidth } : undefined

        if (brush) {
          // Walk each Bresenham pixel and stamp a disk using the tiling brush mask
          const pad = Math.ceil(pencilOptions.size / 2) + 2
          const tiledW = ctx.tiledMode ? renderer.pixelWidth : undefined
          const tiledH = ctx.tiledMode ? renderer.pixelHeight : undefined
          bresenham(lastPx.x, lastPx.y, x1, y1, (px, py) => {
            growLayerToFit(px, py, pad)
            paintBrushStamp(renderer, layer, px, py, brush, r, g, b, a, pencilOptions.opacity, pencilOptions.size, pencilOptions.shape, touched!, sel ?? null, tiledW, tiledH)
          })
          lastPx = { x: x1, y: y1 }
        } else {
          draw1pxSegment(x, y, ctx)
        }
        renderer.flushLayer(layer)
        render(layers)
      } else {
        if (!lastRendered || !lastCtrl) return
        const alpha = smoothingToAlpha(pencilOptions.smoothing)
        stabX = stabX * (1 - alpha) + x * alpha
        stabY = stabY * (1 - alpha) + y * alpha

        const spacing = Math.max(1, pencilOptions.size * 0.2)
        const tipX = (lastCtrl.x + stabX) * 0.5
        const tipY = (lastCtrl.y + stabY) * 0.5

        if (Math.hypot(tipX - lastRendered.x, tipY - lastRendered.y) >= spacing) {
          paint(lastRendered.x, lastRendered.y, lastCtrl.x, lastCtrl.y, tipX, tipY, ctx)
          lastRendered = { x: tipX, y: tipY }
        }
        lastCtrl = { x: stabX, y: stabY }
      }
    },

    onPointerUp(_pos: ToolPointerPos, ctx: ToolContext) {
      if (pencilOptions.size === 1 || pencilOptions.pixelBrush) {
        if (!pencilOptions.pixelBrush) flushPPPending(ctx)
        const { renderer, layer, layers, render } = ctx
        renderer.flushLayer(layer)
        render(layers)
      } else {
        if (lastRendered && lastCtrl) {
          if (Math.hypot(lastCtrl.x - lastRendered.x, lastCtrl.y - lastRendered.y) >= 1) {
            paint(lastRendered.x, lastRendered.y, lastCtrl.x, lastCtrl.y, lastCtrl.x, lastCtrl.y, ctx)
          }
        }
      }
      lastRendered = null; lastCtrl = null
      lastPx = null; ppPrev = null; ppPending = null
      touched = null
    },
  }
}

// ─── Options UI ────────────────────────────────────────────────────────────────

/**
 * Capture the pixels within the current selection and create a new PixelBrush
 * from them, adding it to the document brush library.
 */
function captureSelectionAsBrush(dispatch: ReturnType<typeof useAppContext>['dispatch']): void {
  if (!_renderer || !_layer) return
  const mask = selectionStore.mask
  if (!mask) return

  const cw = _renderer.pixelWidth
  const ch = _renderer.pixelHeight

  // Find bounding rect of the selection mask
  let minX = cw, maxX = 0, minY = ch, maxY = 0
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (mask[y * cw + x]) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (minX > maxX || minY > maxY) return

  const bw = maxX - minX + 1
  const bh = maxY - minY + 1
  const rgba = new Uint8ClampedArray(bw * bh * 4)

  const layerData = _layer.data
  const lw = _layer.layerWidth
  const ox = _layer.offsetX
  const oy = _layer.offsetY

  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const cx = minX + x
      const cy = minY + y
      // Only include pixels inside the selection
      if (!mask[cy * cw + cx]) continue
      // Sample layer-local pixel
      const lx = cx - ox
      const ly = cy - oy
      if (lx < 0 || ly < 0 || lx >= lw || ly >= _layer.layerHeight) continue
      const src = (ly * lw + lx) * 4
      const dst = (y * bw + x) * 4
      rgba[dst]     = layerData[src]
      rgba[dst + 1] = layerData[src + 1]
      rgba[dst + 2] = layerData[src + 2]
      rgba[dst + 3] = layerData[src + 3]
    }
  }

  // Encode as base64
  let bin = ''
  for (let i = 0; i < rgba.length; i++) bin += String.fromCharCode(rgba[i])
  const b64 = btoa(bin)

  const brush: PixelBrush = {
    id:        crypto.randomUUID(),
    name:      `Brush ${Date.now()}`,
    width:     bw,
    height:    bh,
    rgba:      b64,
    createdAt: Date.now(),
  }
  dispatch({ type: 'ADD_PIXEL_BRUSH', payload: brush })
}

// ─── Flyout portal ────────────────────────────────────────────────────────────

interface BrushFlyoutProps {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  docBrushes: PixelBrush[]
  userBrushes: PixelBrush[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onOpenModal: () => void
}

function BrushFlyout({
  anchorRef, onClose, docBrushes, userBrushes, selectedId, onSelect, onOpenModal,
}: BrushFlyoutProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)

  // Position below the anchor button
  const rect = anchorRef.current?.getBoundingClientRect()
  const top  = rect ? rect.bottom + 6 : 80
  const left = rect ? rect.left      : 0

  // Close on outside mousedown
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (
        !panelRef.current?.contains(e.target as Node) &&
        !anchorRef.current?.contains(e.target as Node)
      ) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [anchorRef, onClose])

  const allBrushes = [...docBrushes, ...userBrushes]
  // 'none' kept as documentation of the implicit shape — clearing selection in the gallery resets to standard pencil

  return createPortal(
    <div
      ref={panelRef}
      style={{
        position:    'fixed',
        top,
        left,
        zIndex:      500,
        background:  '#2d2d2d',
        border:      '1px solid #191919',
        borderRadius: 6,
        boxShadow:   '0 4px 16px rgba(0,0,0,0.6)',
        padding:     8,
        minWidth:    220,
        maxWidth:    320,
      }}
    >
      <div style={{ fontSize: 11, color: '#aaa', marginBottom: 6 }}>Pixel Brushes</div>
      <div style={{ maxHeight: 200, overflowY: 'auto' }}>
        {/* "None" option — reverts to standard pencil */}
        <div
          onClick={() => { onSelect(null); onClose() }}
          style={{
            padding: '3px 6px',
            borderRadius: 4,
            cursor: 'pointer',
            background: selectedId === null ? 'rgba(82,130,255,0.25)' : 'transparent',
            fontSize: 11,
            color: '#ccc',
            marginBottom: 4,
          }}
        >
          ✕ None (standard pencil)
        </div>
        {allBrushes.length === 0 ? (
          <div style={{ fontSize: 11, color: '#777', padding: '4px 6px' }}>No brushes yet</div>
        ) : (
          <PixelBrushGallery
            brushes={allBrushes}
            selectedId={selectedId}
            onSelect={(id) => { onSelect(id); onClose() }}
          />
        )}
      </div>
      <div style={{ borderTop: '1px solid #191919', marginTop: 6, paddingTop: 6 }}>
        <button
          style={{
            fontSize: 11,
            background: '#3a3a3a',
            color: '#ccc',
            border: '1px solid #191919',
            borderRadius: 4,
            padding: '3px 10px',
            cursor: 'pointer',
            width: '100%',
          }}
          onClick={() => { onClose(); onOpenModal() }}
        >
          Manage Brushes…
        </button>
      </div>
    </div>,
    document.body,
  )
}

// ─── Options component ────────────────────────────────────────────────────────

function PencilOptions({ styles }: { styles: ToolOptionsStyles }): React.JSX.Element {
  const { state, dispatch } = useAppContext()
  const { primaryColor } = state

  const [size,         setSize]        = useState(pencilOptions.size)
  const [opacity,      setOpacity]     = useState(pencilOptions.opacity)
  const [shape,        setShape]       = useState<BrushShape>(pencilOptions.shape)
  const [pixelPerfect, setPixelPerfect] = useState(pencilOptions.pixelPerfect)
  const [antiAlias,    setAA]          = useState(pencilOptions.antiAlias)
  const [smoothing,    setSmoothing]   = useState(pencilOptions.smoothing)
  const [motionBlur,   setMotionBlur]  = useState(pencilOptions.motionBlur)
  const [activeBrush,  setActiveBrush] = useState<PixelBrush | null>(null)
  const [snapToBrush,  setSnapToBrush] = useState(pencilOptions.snapToBrush)
  const [flyoutOpen,   setFlyoutOpen]  = useState(false)
  const [modalOpen,    setModalOpen]   = useState(false)
  const [userBrushes,  setUserBrushes] = useState<PixelBrush[]>(() => pixelBrushStore.getUserBrushes())

  const flyoutBtnRef = useRef<HTMLButtonElement | null>(null)

  // Sync user brushes
  useEffect(() => {
    const update = (): void => setUserBrushes([...pixelBrushStore.getUserBrushes()])
    pixelBrushStore.subscribe(update)
    return () => pixelBrushStore.unsubscribe(update)
  }, [])

  const handleSize        = (v: number): void => { pencilOptions.size        = v; setSize(v) }
  const handleOpacity     = (v: number): void => { pencilOptions.opacity     = v; setOpacity(v) }
  const handleSmoothing   = (v: number): void => { pencilOptions.smoothing   = v; setSmoothing(v) }
  const handleMotionBlur  = (v: number): void => { pencilOptions.motionBlur  = v; setMotionBlur(v) }
  const handleAA          = (v: boolean): void => { pencilOptions.antiAlias  = v; setAA(v) }
  const handleShape = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const v = e.target.value as BrushShape
    pencilOptions.shape = v
    setShape(v)
  }
  const handlePixelPerfect = (e: React.ChangeEvent<HTMLInputElement>): void => {
    pencilOptions.pixelPerfect = e.target.checked
    setPixelPerfect(e.target.checked)
  }

  const handleSnapToBrush = (e: React.ChangeEvent<HTMLInputElement>): void => {
    pencilOptions.snapToBrush = e.target.checked
    setSnapToBrush(e.target.checked)
  }

  const handleSelectBrush = useCallback((id: string | null): void => {
    const all = [...state.pixelBrushes, ...userBrushes]
    const found = id ? (all.find(b => b.id === id) ?? null) : null
    pencilOptions.pixelBrush = found
    invalidatePencilBrushPreview()
    setActiveBrush(found)
  }, [state.pixelBrushes, userBrushes])

  const handleCapture = useCallback((): void => {
    captureSelectionAsBrush(dispatch)
  }, [dispatch])

  const shades = getColorShades(primaryColor.r, primaryColor.g, primaryColor.b, primaryColor.a)

  const brushBtnLabel = activeBrush ? activeBrush.name : 'Brushes'

  return (
    <>
      <label className={styles.optLabel}>Size:</label>
      <SliderInput value={size} min={1} max={100} inputWidth={42} onChange={handleSize} />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Opacity:</label>
      <SliderInput value={opacity} min={1} max={100} suffix="%" inputWidth={42} onChange={handleOpacity} />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Shape:</label>
      <select className={styles.optSelect} value={shape} onChange={handleShape} style={{ width: 70 }}>
        <option value="round">Round</option>
        <option value="square">Square</option>
      </select>
      <span className={styles.optSep} />
      {/* 5 shades of the current primary color */}
      {shades.map((shade, i) => (
        <button
          key={i}
          title={i === 2 ? 'Current color' : i < 2 ? 'Darker shade' : 'Lighter shade'}
          style={{
            width: 14,
            height: 14,
            background: `rgb(${shade.r},${shade.g},${shade.b})`,
            border: i === 2
              ? '2px solid rgba(255,255,255,0.85)'
              : '1px solid rgba(255,255,255,0.25)',
            borderRadius: 2,
            cursor: 'pointer',
            padding: 0,
            flexShrink: 0,
            outline: 'none',
            boxShadow: i === 2 ? '0 0 0 1px rgba(0,0,0,0.5)' : undefined,
          }}
          onClick={() => dispatch({ type: 'SET_PRIMARY_COLOR', payload: shade })}
        />
      ))}
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel} title="Remove L-corner pixels for clean pixel-art diagonals (1px only)">
        <input
          type="checkbox"
          checked={pixelPerfect}
          onChange={handlePixelPerfect}
        />
        Pixel perfect
      </label>
      <span className={styles.optSep} />
      <label className={styles.optLabel} title="Filter pointer noise — higher values smooth the path at the cost of slight lag">Smoothing:</label>
      <SliderInput value={smoothing} min={0} max={100} suffix="%" inputWidth={42} onChange={handleSmoothing} />
      <span className={styles.optSep} />
      <label className={styles.optLabel} title="Elongates dabs along the stroke direction for a calligraphic smear">Motion:</label>
      <SliderInput value={motionBlur} min={0} max={100} suffix="%" inputWidth={42} onChange={handleMotionBlur} />
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={antiAlias}
          onChange={(e) => handleAA(e.target.checked)}
        />
        Anti-alias
      </label>
      <span className={styles.optSep} />
      {/* Pixel brush flyout */}
      <button
        ref={flyoutBtnRef}
        className={styles.optBtn}
        onClick={() => setFlyoutOpen(o => !o)}
        title="Select a pixel brush"
      >
        {brushBtnLabel}
      </button>
      {flyoutOpen && (
        <BrushFlyout
          anchorRef={flyoutBtnRef as React.RefObject<HTMLButtonElement | null>}
          onClose={() => setFlyoutOpen(false)}
          docBrushes={state.pixelBrushes}
          userBrushes={userBrushes}
          selectedId={activeBrush?.id ?? null}
          onSelect={handleSelectBrush}
          onOpenModal={() => setModalOpen(true)}
        />
      )}
      <button
        className={styles.optBtn}
        onClick={handleCapture}
        title="Capture selection pixels as a new pixel brush"
        disabled={!_renderer}
      >
        Capture
      </button>
      {modalOpen && (
        <PixelBrushesModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
        />
      )}
      {activeBrush && (
        <>
          <label className={styles.optCheckLabel} title="Snap to brush grid — stamps tile perfectly without overlap">
            <input
              type="checkbox"
              checked={snapToBrush}
              onChange={handleSnapToBrush}
            />
            Snap to brush
          </label>
          <span className={styles.optSep} />
        </>
      )}
    </>
  )
}

export const pencilTool: ToolDefinition = {
  createHandler: createPencilHandler,
  Options: PencilOptions,
  modifiesPixels: true,
  paintsOntoPixelLayer: true,
}

// Expose for potential reuse by other tools
export { createPencilHandler }
