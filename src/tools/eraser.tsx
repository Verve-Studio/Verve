import React, { useState } from 'react'
import { eraseThickLine } from './algorithm/eraseStroke'
import { SliderInput } from '@/ux/widgets/SliderInput/SliderInput'
import type { ToolDefinition, ToolHandler, ToolPointerPos, ToolContext, ToolOptionsStyles } from './types'

// ─── Module-level options ────────────────────────────────────────────────────

export const eraserOptions = {
  size: 20,
  strength: 100,
  antiAlias: true,
  alphaMode: false,
}

// ─── Handler ─────────────────────────────────────────────────────────────────

function createEraserHandler(): ToolHandler {
  let lastPos: { x: number; y: number } | null = null
  let touched: Map<number, number> | null = null

  function stamp(
    x0: number, y0: number, x1: number, y1: number,
    ctx: ToolContext
  ): void {
    const { renderer, layer, layers, secondaryColor, selectionMask, render, growLayerToFit } = ctx
    const { r: secR, g: secG, b: secB } = secondaryColor
    const radius = eraserOptions.size / 2
    growLayerToFit(x0, y0, Math.ceil(radius))
    if (x1 !== x0 || y1 !== y0) growLayerToFit(x1, y1, Math.ceil(radius))
    const sel = selectionMask ? { mask: selectionMask, width: renderer.pixelWidth } : undefined
    const tiledW = ctx.tiledMode ? renderer.pixelWidth : undefined
    const tiledH = ctx.tiledMode ? renderer.pixelHeight : undefined
    eraseThickLine(
      renderer, layer,
      x0, y0, x1, y1,
      eraserOptions.size,
      secR, secG, secB,
      eraserOptions.strength,
      eraserOptions.alphaMode,
      eraserOptions.antiAlias,
      touched ?? undefined,
      sel,
      tiledW, tiledH,
    )
    renderer.flushLayer(layer)
    render(layers)
  }

  return {
    onPointerDown({ x, y }: ToolPointerPos, ctx: ToolContext) {
      touched = new Map()
      lastPos = null
      stamp(x, y, x, y, ctx)
      lastPos = { x, y }
    },

    onPointerMove({ x, y }: ToolPointerPos, ctx: ToolContext) {
      if (!lastPos) return
      stamp(lastPos.x, lastPos.y, x, y, ctx)
      lastPos = { x, y }
    },

    onPointerUp() {
      lastPos = null
      touched = null
    },
  }
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function EraserOptions({ styles }: { styles: ToolOptionsStyles }): React.JSX.Element {
  const [size, setSize]         = useState(eraserOptions.size)
  const [strength, setStrength] = useState(eraserOptions.strength)
  const [antiAlias, setAA]      = useState(eraserOptions.antiAlias)
  const [alphaMode, setAlpha]   = useState(eraserOptions.alphaMode)

  const handleSize = (v: number): void => { eraserOptions.size = v; setSize(v) }
  const handleStrength = (v: number): void => { eraserOptions.strength = v; setStrength(v) }
  const handleAA = (v: boolean): void => { eraserOptions.antiAlias = v; setAA(v) }
  const handleAlpha = (v: boolean): void => { eraserOptions.alphaMode = v; setAlpha(v) }

  return (
    <>
      <label className={styles.optLabel}>Size:</label>
      <SliderInput value={size} min={1} max={200} inputWidth={42} onChange={handleSize} />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Strength:</label>
      <SliderInput value={strength} min={0} max={100} suffix="%" inputWidth={42} onChange={handleStrength} />
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
      <label className={styles.optCheckLabel} title="When checked, erases alpha (transparency). When unchecked, replaces RGB with background color.">
        <input
          type="checkbox"
          checked={alphaMode}
          onChange={(e) => handleAlpha(e.target.checked)}
        />
        Erase alpha
      </label>
    </>
  )
}

export const eraserTool: ToolDefinition = {
  createHandler: createEraserHandler,
  Options: EraserOptions,
  modifiesPixels: true,
}
