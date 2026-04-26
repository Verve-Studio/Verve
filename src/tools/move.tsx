import React, { useEffect, useState } from 'react'
import { selectionStore } from '@/core/store/selectionStore'
import type { TextLayerState, ShapeLayerState } from '@/types'
import type { ToolDefinition, ToolHandler, ToolPointerPos, ToolContext, ToolOptionsStyles } from './types'

// ─── Display store (live position/size for options bar) ───────────────────────

const moveDisplay = {
  x: null as number | null,
  y: null as number | null,
  w: null as number | null,
  h: null as number | null,
  listeners: new Set<() => void>(),
  subscribe(fn: () => void): void { this.listeners.add(fn) },
  unsubscribe(fn: () => void): void { this.listeners.delete(fn) },
  /**
   * X/Y: top-left of the layer in canvas-space (origin = canvas top-left).
   * W/H: pixel dimensions of the layer content.
   */
  set(offsetX: number, offsetY: number, layerW: number, layerH: number): void {
    this.x = offsetX
    this.y = offsetY
    this.w = layerW
    this.h = layerH
    this.listeners.forEach(fn => fn())
  },
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function translateShapeLayer(ls: ShapeLayerState, dx: number, dy: number): ShapeLayerState {
  if (ls.shapeType === 'line') {
    return { ...ls, x1: ls.x1 + dx, y1: ls.y1 + dy, x2: ls.x2 + dx, y2: ls.y2 + dy }
  }
  return { ...ls, cx: ls.cx + dx, cy: ls.cy + dy }
}

function createMoveHandler(): ToolHandler {
  let startX = 0
  let startY = 0
  let lastDx = 0
  let lastDy = 0
  // For selection move: full pixel copy per-drag
  let originalPixels: Uint8Array | null = null
  let originalMask: Uint8Array | null = null
  // For whole-layer move: store original offset
  let originalOffsetX = 0
  let originalOffsetY = 0
  // For text layer move: track original ls.x / ls.y
  let textLayerSnapshot: TextLayerState | null = null
  let textLayerOrigX = 0
  let textLayerOrigY = 0
  // For shape layer move: track original parametric coords
  let shapeLayerSnapshot: ShapeLayerState | null = null
  let isDown = false

  function applySelectionMove(dx: number, dy: number, ctx: ToolContext): void {
    const { renderer, layer, layers, render } = ctx
    const w = renderer.pixelWidth
    const h = renderer.pixelHeight
    const lw = layer.layerWidth
    const lh = layer.layerHeight
    const src = originalPixels!
    const dst = layer.data

    // Step 1: restore original pixels
    dst.set(src)
    // Step 2: erase selected pixels from their original position (in layer-local coords)
    for (let i = 0; i < w * h; i++) {
      const a = originalMask![i]
      if (a === 0) continue
      const cx = i % w
      const cy = Math.floor(i / w)
      const lx = cx - layer.offsetX
      const ly = cy - layer.offsetY
      if (lx < 0 || ly < 0 || lx >= lw || ly >= lh) continue
      const pi = (ly * lw + lx) * 4
      const f = 1 - a / 255
      dst[pi]     = Math.round(dst[pi]     * f)
      dst[pi + 1] = Math.round(dst[pi + 1] * f)
      dst[pi + 2] = Math.round(dst[pi + 2] * f)
      dst[pi + 3] = Math.round(dst[pi + 3] * f)
    }
    // Step 3: composite selected pixels at the new position (over)
    for (let sy = 0; sy < h; sy++) {
      const ty = sy + dy
      if (ty < 0 || ty >= h) continue
      for (let sx = 0; sx < w; sx++) {
        const tx = sx + dx
        if (tx < 0 || tx >= w) continue
        const mi = sy * w + sx
        const a = originalMask![mi]
        if (a === 0) continue
        const slx = sx - layer.offsetX
        const sly = sy - layer.offsetY
        if (slx < 0 || sly < 0 || slx >= lw || sly >= lh) continue
        const si = (sly * lw + slx) * 4
        const tlx = tx - layer.offsetX
        const tly = ty - layer.offsetY
        if (tlx < 0 || tly < 0 || tlx >= lw || tly >= lh) continue
        const di = (tly * lw + tlx) * 4
        const srcA = src[si + 3] * a / 255
        const dstA = dst[di + 3]
        const outA = srcA + dstA * (1 - srcA / 255)
        if (outA === 0) continue
        dst[di]     = Math.round((src[si]     * srcA + dst[di]     * dstA * (1 - srcA / 255)) / outA)
        dst[di + 1] = Math.round((src[si + 1] * srcA + dst[di + 1] * dstA * (1 - srcA / 255)) / outA)
        dst[di + 2] = Math.round((src[si + 2] * srcA + dst[di + 2] * dstA * (1 - srcA / 255)) / outA)
        dst[di + 3] = Math.min(255, Math.round(outA))
      }
    }

    renderer.flushLayer(layer)
    render(layers)
  }

  return {
    onPointerDown({ x, y }: ToolPointerPos, ctx: ToolContext) {
      startX = Math.round(x)
      startY = Math.round(y)
      lastDx = 0
      lastDy = 0
      isDown = true
      textLayerSnapshot = ctx.textLayers.find((t) => t.id === ctx.layer.id) ?? null
      shapeLayerSnapshot = ctx.shapeLayers.find((s) => s.id === ctx.layer.id) ?? null

      if (selectionStore.mask) {
        // Selection move: pixel-copy approach (selection moves pixels, offset unchanged)
        originalPixels = ctx.layer.data.slice()
        originalMask   = selectionStore.mask.slice()
        originalOffsetX = 0
        originalOffsetY = 0
      } else {
        // Whole-layer move: just update the offset
        originalPixels = null
        originalMask   = null
        originalOffsetX = ctx.layer.offsetX
        originalOffsetY = ctx.layer.offsetY
        if (textLayerSnapshot) {
          textLayerOrigX = textLayerSnapshot.x
          textLayerOrigY = textLayerSnapshot.y
        }
      }
      moveDisplay.set(ctx.layer.offsetX, ctx.layer.offsetY, ctx.layer.layerWidth, ctx.layer.layerHeight)
    },

    onPointerMove({ x, y }: ToolPointerPos, ctx: ToolContext) {
      if (!isDown) return
      const dx = Math.round(x) - startX
      const dy = Math.round(y) - startY
      if (dx === lastDx && dy === lastDy) return
      lastDx = dx
      lastDy = dy

      if (originalPixels) {
        applySelectionMove(dx, dy, ctx)
      } else if (textLayerSnapshot) {
        // Text layer: shift via GPU offset (same as pixel layers) to avoid
        // re-rasterizing on every frame. Final rasterize happens on pointer-up.
        ctx.renderer.setPreviewMode(true)
        ctx.layer.offsetX = dx
        ctx.layer.offsetY = dy
        ctx.render(ctx.layers)
      } else if (shapeLayerSnapshot) {
        // Shape layer: shift via GPU offset (same as pixel layers) to avoid
        // re-rasterizing on every frame. Final rasterize happens on pointer-up.
        ctx.renderer.setPreviewMode(true)
        ctx.layer.offsetX = dx
        ctx.layer.offsetY = dy
        ctx.render(ctx.layers)
      } else {
        // Update offset in-place (no pixel data change).
        // Enable preview mode so expensive standalone effects (bloom, halation, etc.)
        // are skipped during the drag — they rerun at full quality on pointer-up.
        ctx.renderer.setPreviewMode(true)
        ctx.layer.offsetX = originalOffsetX + dx
        ctx.layer.offsetY = originalOffsetY + dy
        ctx.render(ctx.layers)
      }
      moveDisplay.set(ctx.layer.offsetX, ctx.layer.offsetY, ctx.layer.layerWidth, ctx.layer.layerHeight)
    },

    onPointerUp({ x, y }: ToolPointerPos, ctx: ToolContext) {
      if (!isDown) return
      isDown = false
      const dx = Math.round(x) - startX
      const dy = Math.round(y) - startY

      if (originalPixels) {
        if (dx !== lastDx || dy !== lastDy) applySelectionMove(dx, dy, ctx)
        if (originalMask && (dx !== 0 || dy !== 0)) selectionStore.translateMask(dx, dy)
        originalPixels = null
        originalMask   = null
      } else if (textLayerSnapshot) {
        // Reset offset before rasterizing so the text bakes its position into
        // pixel data at offset (0, 0), matching the normal text layer invariant.
        ctx.layer.offsetX = 0
        ctx.layer.offsetY = 0
        ctx.renderer.setPreviewMode(false)
        ctx.previewTextAt(textLayerSnapshot, textLayerOrigX + dx, textLayerOrigY + dy)
        ctx.updateTextLayer({ ...textLayerSnapshot, x: textLayerOrigX + dx, y: textLayerOrigY + dy })
        textLayerSnapshot = null
      } else if (shapeLayerSnapshot) {
        const moved = translateShapeLayer(shapeLayerSnapshot, dx, dy)
        // Reset offset before rasterizing so the shape bakes its position into
        // pixel data at offset (0, 0), matching the normal shape layer invariant.
        ctx.layer.offsetX = 0
        ctx.layer.offsetY = 0
        ctx.renderer.setPreviewMode(false)
        ctx.previewShapeLayer(moved)
        ctx.updateShapeLayer(moved)
        shapeLayerSnapshot = null
      } else {
        if (dx !== lastDx || dy !== lastDy) {
          ctx.layer.offsetX = originalOffsetX + dx
          ctx.layer.offsetY = originalOffsetY + dy
        }
        // Always exit preview mode and do a full-quality rerender on pointer-up
        // so standalone effects (bloom, halation, etc.) render at the final position.
        ctx.renderer.setPreviewMode(false)
        ctx.render(ctx.layers)
      }
    },
  }
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function MoveOptions({ styles }: { styles: ToolOptionsStyles }): React.JSX.Element {
  const [pos, setPos] = useState({ x: moveDisplay.x, y: moveDisplay.y, w: moveDisplay.w, h: moveDisplay.h })

  useEffect(() => {
    const sync = (): void => setPos({ x: moveDisplay.x, y: moveDisplay.y, w: moveDisplay.w, h: moveDisplay.h })
    moveDisplay.subscribe(sync)
    return () => moveDisplay.unsubscribe(sync)
  }, [])

  const fmt = (v: number | null): string => v !== null ? String(v) : '—'

  return (
    <>
      <label className={styles.optLabel}>X:</label>
      <span className={styles.optText}>{fmt(pos.x)}</span>
      <label className={styles.optLabel}>Y:</label>
      <span className={styles.optText}>{fmt(pos.y)}</span>
      <span className={styles.optSep} />
      <label className={styles.optLabel}>W:</label>
      <span className={styles.optText}>{fmt(pos.w)}</span>
      <label className={styles.optLabel}>H:</label>
      <span className={styles.optText}>{fmt(pos.h)}</span>
    </>
  )
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const moveTool: ToolDefinition = {
  createHandler: createMoveHandler,
  Options: MoveOptions,
  modifiesPixels: true,
  worksOnAllLayers: true,
}
