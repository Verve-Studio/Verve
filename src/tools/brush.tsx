import React, { useState } from 'react'
import { walkQuadBezier } from './algorithm/brushStroke'
import type { BrushShape } from './algorithm/brushStroke'
import { SliderInput } from '@/ux/widgets/SliderInput/SliderInput'
import type { ToolDefinition, ToolHandler, ToolPointerPos, ToolContext, ToolOptionsStyles } from './types'

// ─── Shared options ───────────────────────────────────────────────────────────

export const brushOptions = {
  size:             20,
  opacity:          100,
  hardness:         100,
  shape:            'round' as BrushShape,
  antiAlias:        true,
  smoothing:        50,  // 0 = raw coords, 100 = maximum stabilizer
  motionBlur:       5,   // 0 = round dabs, 100 = dabs elongated 1× brush-width along stroke
  velocityTracking: true,
}

/**
 * Map the 0-100 smoothing slider to an EMA alpha (fraction of the *new* sample
 * to mix in each event). alpha=1 → instantaneous (no filter); alpha↓0 → heavy lag.
 * We clamp to 0.05 so the brush never completely stops tracking.
 */
function smoothingToAlpha(s: number): number {
  return Math.max(0.05, 1 - s / 100 * 0.92)
}

// ── Velocity dynamics ─────────────────────────────────────────────────────────
const MAX_TRACKING_SPEED  = 5    // px/ms — speed at which dynamics hit their floor
const MIN_SIZE_FACTOR     = 0.55 // fast stroke → 55% of set size
const MIN_OPACITY_FACTOR  = 0.65 // fast stroke → 65% of set opacity
const SPEED_SMOOTHING     = 0.25 // EMA weight; higher = snappier but jitterier

// ─── Midpoint B-spline brush handler ─────────────────────────────────────────
// Positions are smoothed with an EMA stabilizer feeding into a midpoint
// B-spline (approximating spline). The rendered path is a series of quadratic
// Bézier arcs — P0→P1 drawn through the previous stabilised control point —
// giving true curvature. A per-stroke touched-map prevents opacity accumulation
// at segment joints without the ring/ball stamp artifacts.

type Point = { x: number; y: number }

function createBrushHandler(): ToolHandler {
  let lastRendered: Point | null = null  // endpoint of the last drawn Bézier arc
  let lastCtrl:     Point | null = null  // last stabilised pointer (B-spline ctrl pt)
  let touched: Map<number, number> | null = null
  let smoothSpeed = 0
  let stabX = 0, stabY = 0
  let prevTime = 0

  /**
   * Paint a quadratic Bézier arc from (p0x,p0y) to (p1x,p1y) using (cpx,cpy)
   * as the attractor. Stamps along the arc via walkQuadBezier; the shared
   * per-stroke touched map ensures no pixel accumulates more alpha than it
   * should, preventing dark blobs where consecutive arcs share endpoints.
   */
  function paint(
    p0x: number, p0y: number,
    cpx: number, cpy: number,
    p1x: number, p1y: number,
    size: number, opacity: number,
    ctx: ToolContext,
  ): void {
    const { renderer, layer, layers, primaryColor, selectionMask, render, growLayerToFit } = ctx
    const { r, g, b, a } = primaryColor
    const padR = Math.ceil(size / 2) + 2
    growLayerToFit(Math.round(p0x), Math.round(p0y), padR)
    growLayerToFit(Math.round(cpx),  Math.round(cpy),  padR)
    growLayerToFit(Math.round(p1x), Math.round(p1y), padR)
    const sel = selectionMask ? { mask: selectionMask, width: renderer.pixelWidth } : undefined
    walkQuadBezier(
      renderer, layer,
      p0x, p0y, cpx, cpy, p1x, p1y,
      size, r, g, b, a, opacity,
      brushOptions.hardness, brushOptions.shape, brushOptions.antiAlias,
      brushOptions.motionBlur / 100,
      touched ?? undefined, sel,
    )

    // Expand the accumulated dirty rect so flushLayer only uploads the touched area.
    // Coordinates are layer-local (origin at layer.offsetX, layer.offsetY).
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

    renderer.flushLayer(layer)
    render(layers)
  }

  function resolveStrokeParams(speed: number): { size: number; opacity: number } {
    if (!brushOptions.velocityTracking || speed <= 0) {
      return { size: brushOptions.size, opacity: brushOptions.opacity }
    }
    const t = Math.min(1, speed / MAX_TRACKING_SPEED)
    return {
      size:    brushOptions.size    * Math.max(MIN_SIZE_FACTOR,    1 - t * (1 - MIN_SIZE_FACTOR)),
      opacity: brushOptions.opacity * Math.max(MIN_OPACITY_FACTOR, 1 - t * (1 - MIN_OPACITY_FACTOR)),
    }
  }

  return {
    onPointerDown({ x, y, timeStamp }: ToolPointerPos, ctx: ToolContext) {
      touched      = new Map()
      smoothSpeed  = 0
      stabX = x; stabY = y
      prevTime     = timeStamp
      lastRendered = { x, y }
      lastCtrl     = { x, y }
      // Initial dot: degenerate Bézier at a single point
      paint(x, y, x, y, x, y, brushOptions.size, brushOptions.opacity, ctx)
    },

    onPointerMove({ x, y, timeStamp }: ToolPointerPos, ctx: ToolContext) {
      if (!lastRendered || !lastCtrl) return
      const now = timeStamp

      // EMA spatial stabilizer — low-pass filters sub-pixel hardware jitter
      const alpha = smoothingToAlpha(brushOptions.smoothing)
      stabX = stabX * (1 - alpha) + x * alpha
      stabY = stabY * (1 - alpha) + y * alpha

      // Velocity (px/ms)
      const dt = now - prevTime
      const d  = Math.hypot(stabX - lastCtrl.x, stabY - lastCtrl.y)
      smoothSpeed = smoothSpeed * (1 - SPEED_SMOOTHING) + (dt > 0 ? d / dt : 0) * SPEED_SMOOTHING
      prevTime = now

      const { size, opacity } = resolveStrokeParams(smoothSpeed)

      // Spacing: minimum arc travel before we commit a new Bézier segment.
      // size * 0.2 keeps dab density consistent with the pencil tool.
      const spacing = Math.max(1, size * 0.2)

      // Midpoint B-spline: the rendered tip advances to mid(lastCtrl, stab).
      // lastCtrl becomes the quadratic Bézier control point — the curve is
      // "attracted" toward the actual pointer without passing through it,
      // giving automatic rounded corners with zero overshoot.
      const tipX = (lastCtrl.x + stabX) * 0.5
      const tipY = (lastCtrl.y + stabY) * 0.5

      if (Math.hypot(tipX - lastRendered.x, tipY - lastRendered.y) >= spacing) {
        paint(
          lastRendered.x, lastRendered.y,
          lastCtrl.x, lastCtrl.y,  // B-spline attractor → Bézier control point
          tipX, tipY,
          size, opacity, ctx,
        )
        lastRendered = { x: tipX, y: tipY }
      }

      lastCtrl = { x: stabX, y: stabY }
    },

    onPointerUp(_pos: ToolPointerPos, ctx: ToolContext) {
      if (lastRendered && lastCtrl) {
        const { size, opacity } = resolveStrokeParams(smoothSpeed)
        if (Math.hypot(lastCtrl.x - lastRendered.x, lastCtrl.y - lastRendered.y) >= 1) {
          // Close deferred tail — draw from lastRendered → lastCtrl with lastCtrl
          // duplicated as the end point (zero-length tail eases cleanly)
          paint(
            lastRendered.x, lastRendered.y,
            lastCtrl.x, lastCtrl.y,
            lastCtrl.x, lastCtrl.y,
            size, opacity, ctx,
          )
        }
      }
      lastRendered = null
      lastCtrl     = null
      touched      = null
      smoothSpeed  = 0
    },
  }
}


// ─── Options UI ────────────────────────────────────────────────────────────────

const SHAPE_LABELS: { value: BrushShape; label: string }[] = [
  { value: 'round',   label: 'Round'   },
  { value: 'square',  label: 'Square'  },
  { value: 'diamond', label: 'Diamond' },
]

function BrushOptions({ styles }: { styles: ToolOptionsStyles }): React.JSX.Element {
  const [size,             setSize]             = useState(brushOptions.size)
  const [opacity,          setOpacity]          = useState(brushOptions.opacity)
  const [hardness,         setHardness]         = useState(brushOptions.hardness)
  const [shape,            setShape]            = useState<BrushShape>(brushOptions.shape)
  const [antiAlias,        setAntiAlias]        = useState(brushOptions.antiAlias)
  const [smoothing,        setSmoothing]        = useState(brushOptions.smoothing)
  const [motionBlur,       setMotionBlur]       = useState(brushOptions.motionBlur)
  const [velocityTracking, setVelocityTracking] = useState(brushOptions.velocityTracking)

  const handleSize      = (v: number): void => { brushOptions.size       = v; setSize(v) }
  const handleOpacity   = (v: number): void => { brushOptions.opacity    = v; setOpacity(v) }
  const handleHardness  = (v: number): void => { brushOptions.hardness   = v; setHardness(v) }
  const handleSmoothing = (v: number): void => { brushOptions.smoothing  = v; setSmoothing(v) }
  const handleMotionBlur = (v: number): void => { brushOptions.motionBlur = v; setMotionBlur(v) }

  const handleShape = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const v = e.target.value as BrushShape
    brushOptions.shape = v
    setShape(v)
  }
  const handleAntiAlias = (e: React.ChangeEvent<HTMLInputElement>): void => {
    brushOptions.antiAlias = e.target.checked
    setAntiAlias(e.target.checked)
  }
  const handleVelocity = (e: React.ChangeEvent<HTMLInputElement>): void => {
    brushOptions.velocityTracking = e.target.checked
    setVelocityTracking(e.target.checked)
  }

  return (
    <>
      <label className={styles.optLabel}>Size:</label>
      <SliderInput value={size} min={1} max={300} inputWidth={42} onChange={handleSize} />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Opacity:</label>
      <SliderInput value={opacity} min={1} max={100} suffix="%" inputWidth={42} onChange={handleOpacity} />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Hardness:</label>
      <SliderInput value={hardness} min={0} max={100} suffix="%" inputWidth={42} onChange={handleHardness} />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Shape:</label>
      <select className={styles.optSelect} value={shape} onChange={handleShape}>
        {SHAPE_LABELS.map(({ value, label }) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>
      <span className={styles.optSep} />
      <label className={styles.optLabel} title="Filter out pointer noise — higher values produce cleaner edges at the cost of slight lag">Smoothing:</label>
      <SliderInput value={smoothing} min={0} max={100} suffix="%" inputWidth={42} onChange={handleSmoothing} />
      <span className={styles.optSep} />
      <label className={styles.optLabel} title="Elongates each dab along the stroke direction — higher values give a smeared/calligraphic feel">Motion:</label>
      <SliderInput value={motionBlur} min={0} max={100} suffix="%" inputWidth={42} onChange={handleMotionBlur} />
      <span className={styles.optSep} />
      <label
        className={styles.optCheckLabel}
        title="Sub-pixel edge feathering for smoother strokes"
      >
        <input type="checkbox" checked={antiAlias} onChange={handleAntiAlias} />
        Anti-alias
      </label>
      <span className={styles.optSep} />
      <label
        className={styles.optCheckLabel}
        title="Fast strokes produce a thinner, lighter line — simulates drawing pressure dynamics"
      >
        <input type="checkbox" checked={velocityTracking} onChange={handleVelocity} />
        Velocity
      </label>
    </>
  )
}

export const brushTool: ToolDefinition = {
  createHandler: createBrushHandler,
  Options: BrushOptions,
  modifiesPixels: true,
  paintsOntoPixelLayer: true,
}

