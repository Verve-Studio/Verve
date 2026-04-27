import React, { useState } from 'react'
import { SliderInput } from '@/ux/widgets/SliderInput/SliderInput'
import type { ToolDefinition, ToolHandler, ToolPointerPos, ToolContext, ToolOptionsStyles } from './types'
import type { RGBAColor } from '@/types'

// ─── Module-level options ─────────────────────────────────────────────────────

export const gradientOptions = {
  type: 'linear' as 'linear' | 'radial',
  repeat: 'none' as 'none' | 'repeat' | 'reflect',
  opacity: 100,
}

// ─── Colour interpolation ─────────────────────────────────────────────────────

function lerpColor(a: RGBAColor, b: RGBAColor, t: number): [number, number, number, number] {
  return [
    Math.round(a.r + (b.r - a.r) * t),
    Math.round(a.g + (b.g - a.g) * t),
    Math.round(a.b + (b.b - a.b) * t),
    Math.round(a.a + (b.a - a.a) * t),
  ]
}

function applyRepeat(t: number, repeat: typeof gradientOptions.repeat): number {
  if (repeat === 'none') return Math.max(0, Math.min(1, t))
  const wrapped = ((t % 1) + 1) % 1
  if (repeat === 'repeat') return wrapped
  // reflect: 0→1→0 pattern
  const cycle = ((t % 2) + 2) % 2
  return cycle <= 1 ? cycle : 2 - cycle
}

// ─── Gradient rasteriser ──────────────────────────────────────────────────────

function renderGradient(
  ctx: ToolContext,
  x0: number, y0: number,
  x1: number, y1: number,
): void {
  const { renderer, layer, layers, primaryColor, secondaryColor, selectionMask, render, growLayerToFit } = ctx
  const { type, repeat, opacity } = gradientOptions

  // Grow layer to full canvas coverage
  const cw = renderer.pixelWidth
  const ch = renderer.pixelHeight
  growLayerToFit(0, 0)
  growLayerToFit(cw - 1, 0)
  growLayerToFit(0, ch - 1)
  growLayerToFit(cw - 1, ch - 1)

  const dx = x1 - x0
  const dy = y1 - y0
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return
  const len = Math.sqrt(lenSq)

  const alpha = opacity / 100

  for (let ly = 0; ly < layer.layerHeight; ly++) {
    for (let lx = 0; lx < layer.layerWidth; lx++) {
      const cx = lx + layer.offsetX
      const cy = ly + layer.offsetY

      // Skip pixels outside the active selection
      if (selectionMask && selectionMask[cy * cw + cx] === 0) continue

      let t: number
      if (type === 'linear') {
        // Project pixel onto the gradient direction vector
        t = ((cx - x0) * dx + (cy - y0) * dy) / lenSq
      } else {
        // Radial: distance from center / radius
        const ddx = cx - x0
        const ddy = cy - y0
        t = Math.sqrt(ddx * ddx + ddy * ddy) / len
      }

      t = applyRepeat(t, repeat)

      const [gr, gg, gb, ga] = lerpColor(primaryColor, secondaryColor, t)
      const srcA = (ga / 255) * alpha

      if (srcA <= 0) continue

      // Porter-Duff "over" composite onto existing pixel
      const i = (ly * layer.layerWidth + lx) * 4
      if (layer.format === 'rgba32f') {
        // layer.data is Float32Array, values 0.0–1.0; gr/gg/gb/ga are 0–255
        const sr = gr / 255, sg = gg / 255, sb = gb / 255
        const dstR = layer.data[i], dstG = layer.data[i + 1], dstB = layer.data[i + 2]
        const dstA = layer.data[i + 3]  // already 0.0–1.0
        const outA = srcA + dstA * (1 - srcA)
        if (outA <= 0) {
          layer.data[i] = 0; layer.data[i + 1] = 0; layer.data[i + 2] = 0; layer.data[i + 3] = 0
        } else {
          const blend = dstA * (1 - srcA)
          layer.data[i]     = (sr * srcA + dstR * blend) / outA
          layer.data[i + 1] = (sg * srcA + dstG * blend) / outA
          layer.data[i + 2] = (sb * srcA + dstB * blend) / outA
          layer.data[i + 3] = outA
        }
      } else {
        const dstR = layer.data[i]
        const dstG = layer.data[i + 1]
        const dstB = layer.data[i + 2]
        const dstA = layer.data[i + 3] / 255
        const outA = srcA + dstA * (1 - srcA)
        if (outA <= 0) {
          layer.data[i] = 0; layer.data[i + 1] = 0; layer.data[i + 2] = 0; layer.data[i + 3] = 0
        } else {
          const blend = dstA * (1 - srcA)
          layer.data[i]     = Math.round((gr * srcA + dstR * blend) / outA)
          layer.data[i + 1] = Math.round((gg * srcA + dstG * blend) / outA)
          layer.data[i + 2] = Math.round((gb * srcA + dstB * blend) / outA)
          layer.data[i + 3] = Math.round(outA * 255)
        }
      }
    }
  }

  renderer.flushLayer(layer)
  render(layers)
}

// ─── Overlay preview ──────────────────────────────────────────────────────────

function drawOverlayPreview(
  canvas: HTMLCanvasElement,
  x0: number, y0: number,
  x1: number, y1: number,
  type: typeof gradientOptions.type,
): void {
  const ctx2d = canvas.getContext('2d')
  if (!ctx2d) return
  ctx2d.clearRect(0, 0, canvas.width, canvas.height)

  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < 1) return

  ctx2d.save()
  ctx2d.strokeStyle = '#ffffff'
  ctx2d.lineWidth = 1
  ctx2d.setLineDash([4, 3])
  ctx2d.lineDashOffset = 0
  ctx2d.shadowColor = '#000000'
  ctx2d.shadowBlur = 2

  if (type === 'linear') {
    // Dashed line with perpendicular ticks at start and end
    ctx2d.beginPath()
    ctx2d.moveTo(x0, y0)
    ctx2d.lineTo(x1, y1)
    ctx2d.stroke()

    // Draw perpendicular ticks (8px each side)
    const nx = -dy / len, ny = dx / len
    const tickLen = 8
    for (const [tx, ty] of [[x0, y0], [x1, y1]]) {
      ctx2d.beginPath()
      ctx2d.moveTo(tx + nx * tickLen, ty + ny * tickLen)
      ctx2d.lineTo(tx - nx * tickLen, ty - ny * tickLen)
      ctx2d.stroke()
    }
  } else {
    // Circle at radius + line from center
    ctx2d.beginPath()
    ctx2d.arc(x0, y0, len, 0, Math.PI * 2)
    ctx2d.stroke()

    ctx2d.beginPath()
    ctx2d.moveTo(x0, y0)
    ctx2d.lineTo(x1, y1)
    ctx2d.stroke()
  }

  // Arrow head at end
  const angle = Math.atan2(dy, dx)
  const arrowLen = 8
  ctx2d.setLineDash([])
  ctx2d.beginPath()
  ctx2d.moveTo(x1, y1)
  ctx2d.lineTo(x1 - arrowLen * Math.cos(angle - 0.4), y1 - arrowLen * Math.sin(angle - 0.4))
  ctx2d.moveTo(x1, y1)
  ctx2d.lineTo(x1 - arrowLen * Math.cos(angle + 0.4), y1 - arrowLen * Math.sin(angle + 0.4))
  ctx2d.stroke()

  ctx2d.restore()
}

function clearOverlay(canvas: HTMLCanvasElement): void {
  const ctx2d = canvas.getContext('2d')
  if (ctx2d) ctx2d.clearRect(0, 0, canvas.width, canvas.height)
}

// ─── Handler ─────────────────────────────────────────────────────────────────

function createGradientHandler(): ToolHandler {
  let startPos: { x: number; y: number } | null = null

  return {
    onPointerDown({ x, y }: ToolPointerPos, ctx: ToolContext) {
      startPos = { x, y }
      if (ctx.overlayCanvas) drawOverlayPreview(ctx.overlayCanvas, x, y, x, y, gradientOptions.type)
    },

    onPointerMove({ x, y }: ToolPointerPos, ctx: ToolContext) {
      if (!startPos) return
      if (ctx.overlayCanvas) {
        drawOverlayPreview(ctx.overlayCanvas, startPos.x, startPos.y, x, y, gradientOptions.type)
      }
    },

    onPointerUp({ x, y }: ToolPointerPos, ctx: ToolContext) {
      if (!startPos) return
      const s = startPos
      startPos = null

      if (ctx.overlayCanvas) clearOverlay(ctx.overlayCanvas)

      renderGradient(ctx, s.x, s.y, x, y)
    },
  }
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function GradientOptions({ styles }: { styles: ToolOptionsStyles }): React.JSX.Element {
  const [type, setType]       = useState(gradientOptions.type)
  const [repeat, setRepeat]   = useState(gradientOptions.repeat)
  const [opacity, setOpacity] = useState(gradientOptions.opacity)

  const handleType = (v: typeof gradientOptions.type): void => { gradientOptions.type = v; setType(v) }
  const handleRepeat = (v: typeof gradientOptions.repeat): void => { gradientOptions.repeat = v; setRepeat(v) }
  const handleOpacity = (v: number): void => { gradientOptions.opacity = v; setOpacity(v) }

  return (
    <>
      <label className={styles.optLabel}>Type:</label>
      <select
        className={styles.optSelect}
        value={type}
        onChange={(e) => handleType(e.target.value as typeof gradientOptions.type)}
      >
        <option value="linear">Linear</option>
        <option value="radial">Radial</option>
      </select>
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Repeat:</label>
      <select
        className={styles.optSelect}
        value={repeat}
        onChange={(e) => handleRepeat(e.target.value as typeof gradientOptions.repeat)}
      >
        <option value="none">None</option>
        <option value="repeat">Repeat</option>
        <option value="reflect">Reflect</option>
      </select>
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Opacity:</label>
      <SliderInput value={opacity} min={1} max={100} suffix="%" inputWidth={42} onChange={handleOpacity} />
    </>
  )
}

export const gradientTool: ToolDefinition = {
  createHandler: createGradientHandler,
  Options: GradientOptions,
  modifiesPixels: true,
  paintsOntoPixelLayer: true,
}
