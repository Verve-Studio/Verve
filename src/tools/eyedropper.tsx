import React from 'react'
import type { GpuLayer, WebGPURenderer } from '@/graphicspipeline/webgpu/rendering/WebGPURenderer'
import type { RGBAColor } from '@/types'
import type { ToolDefinition, ToolHandler, ToolOptionsStyles, ToolContext, ToolPointerPos } from './types'

// ─── Module-level options (read synchronously inside pointer events) ──────────

export const eyedropperOptions = {
  sampleSize: 1 as 1 | 3 | 5,
}

// ─── Composited pixel sampling ────────────────────────────────────────────────

function sampleCompositedPixel(
  layers: GpuLayer[],
  renderer: WebGPURenderer,
  cx: number,
  cy: number,
): [number, number, number, number] {
  // Porter-Duff "over" compositing, bottom-to-top through all visible layers
  let dstR = 0, dstG = 0, dstB = 0, dstA = 0

  for (const layer of layers) {
    if (!layer.visible || layer.opacity === 0) continue
    const [sr, sg, sb, sa] = renderer.sampleCanvasPixel(layer, cx, cy)
    if (sa === 0) continue

    const srcA = (sa / 255) * layer.opacity
    const outA = srcA + dstA * (1 - srcA)
    if (outA === 0) continue

    dstR = (sr * srcA + dstR * dstA * (1 - srcA)) / outA
    dstG = (sg * srcA + dstG * dstA * (1 - srcA)) / outA
    dstB = (sb * srcA + dstB * dstA * (1 - srcA)) / outA
    dstA = outA
  }

  return [Math.round(dstR), Math.round(dstG), Math.round(dstB), Math.round(dstA * 255)]
}

function sampleArea(
  layers: GpuLayer[],
  renderer: WebGPURenderer,
  cx: number,
  cy: number,
  sampleSize: 1 | 3 | 5,
): RGBAColor {
  const half = Math.floor(sampleSize / 2)
  let totalR = 0, totalG = 0, totalB = 0, totalA = 0
  let count = 0

  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const [r, g, b, a] = sampleCompositedPixel(layers, renderer, cx + dx, cy + dy)
      totalR += r; totalG += g; totalB += b; totalA += a
      count++
    }
  }

  return {
    r: Math.round(totalR / count),
    g: Math.round(totalG / count),
    b: Math.round(totalB / count),
    a: Math.round(totalA / count),
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function createEyedropperHandler(): ToolHandler {
  function sampleIndexedPixel(ctx: ToolContext, canvasX: number, canvasY: number): { index: number; color: RGBAColor | null } | null {
    for (let i = ctx.layers.length - 1; i >= 0; i--) {
      const layer = ctx.layers[i]
      if (!layer.visible || layer.format !== 'indexed8') continue
      const lx = canvasX - layer.offsetX
      const ly = canvasY - layer.offsetY
      if (lx < 0 || lx >= layer.layerWidth || ly < 0 || ly >= layer.layerHeight) continue
      const index = (layer.data as Uint8Array)[ly * layer.layerWidth + lx]
      const color = index < ctx.swatches.length ? { r: ctx.swatches[index].r, g: ctx.swatches[index].g, b: ctx.swatches[index].b, a: ctx.swatches[index].a } : null
      return { index, color }
    }
    return null
  }

  function pick(pos: ToolPointerPos, ctx: ToolContext): void {
    if (ctx.pixelFormat === 'indexed8') {
      const result = sampleIndexedPixel(ctx, Math.floor(pos.x), Math.floor(pos.y))
      if (result && result.color) {
        ctx.setSwatch(result.index)
        ctx.setColor(result.color)
      }
      return
    }
    const color = sampleArea(ctx.layers, ctx.renderer, Math.floor(pos.x), Math.floor(pos.y), eyedropperOptions.sampleSize)
    if (ctx.pixelFormat === 'rgba32f') {
      // Check raw float values for HDR overflow before clamping to 8-bit
      const sampledRaw = sampleCompositedPixel(ctx.layers, ctx.renderer, Math.floor(pos.x), Math.floor(pos.y))
      const overflow = sampledRaw[0] > 255 || sampledRaw[1] > 255 || sampledRaw[2] > 255
      ctx.setEyedropperHdrOverflow(overflow)
    } else {
      ctx.setEyedropperHdrOverflow(false)
    }
    ctx.setColor(color)
  }

  return {
    onPointerDown(pos, ctx) { pick(pos, ctx) },
    onPointerMove(pos, ctx) {
      // Only sample while button is held (pressure > 0)
      if (pos.pressure > 0) pick(pos, ctx)
    },
    onPointerUp() {},
  }
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function EyedropperOptions({ styles }: { styles: ToolOptionsStyles }): React.JSX.Element {
  return (
    <>
      <label className={styles.optLabel}>Sample:</label>
      <select
        className={styles.optSelect}
        defaultValue="1"
        onChange={(e) => {
          eyedropperOptions.sampleSize = parseInt(e.target.value, 10) as 1 | 3 | 5
        }}
      >
        <option value="1">Point</option>
        <option value="3">3×3 Average</option>
        <option value="5">5×5 Average</option>
      </select>
    </>
  )
}

export const eyedropperTool: ToolDefinition = {
  createHandler: createEyedropperHandler,
  Options: EyedropperOptions,
}

