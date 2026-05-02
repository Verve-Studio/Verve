import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { RGBAColor } from '@/types'
import { SliderInput } from '@/ux/widgets/SliderInput/SliderInput'
import styles from './EmbedColorPicker.module.scss'

// ─── Color math ───────────────────────────────────────────────────────────────

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h / 60) % 6
  const f = h / 60 - Math.floor(h / 60)
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s)
  const table: [number, number, number][] = [
    [v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q],
  ]
  const [r, g, b] = table[i]
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min
  const v = max, s = max === 0 ? 0 : d / max
  let h = 0
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d + 6) % 6)
    else if (max === gn) h = 60 * ((bn - rn) / d + 2)
    else h = 60 * ((rn - gn) / d + 4)
  }
  return [h, s, v]
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ]
}

export function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// ─── Canvas draw helpers ──────────────────────────────────────────────────────

function drawSvGradient(
  canvas: HTMLCanvasElement,
  hue: number,
  sat: number,
  val: number,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width: w, height: h } = canvas
  ctx.fillStyle = `hsl(${hue}, 100%, 50%)`
  ctx.fillRect(0, 0, w, h)
  const wg = ctx.createLinearGradient(0, 0, w, 0)
  wg.addColorStop(0, 'rgba(255,255,255,1)')
  wg.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = wg; ctx.fillRect(0, 0, w, h)
  const bg = ctx.createLinearGradient(0, 0, 0, h)
  bg.addColorStop(0, 'rgba(0,0,0,0)')
  bg.addColorStop(1, 'rgba(0,0,0,1)')
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h)
  // crosshair
  const cx = sat * w
  const cy = (1 - val) * h
  ctx.save()
  ctx.strokeStyle = val > 0.55 ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.8)'
  ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.stroke()
  ctx.restore()
}

function drawHueStrip(canvas: HTMLCanvasElement, hue: number): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width: w, height: h } = canvas
  const g = ctx.createLinearGradient(0, 0, 0, h)
  for (let deg = 0; deg <= 360; deg += 30) g.addColorStop(deg / 360, `hsl(${deg},100%,50%)`)
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h)
  const cy = (hue / 360) * h
  ctx.save()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1.5
  ctx.shadowColor = 'rgba(0,0,0,0.5)'
  ctx.shadowBlur = 2
  ctx.strokeRect(1, cy - 3, w - 2, 6)
  ctx.restore()
}

// ─── Mode tabs ────────────────────────────────────────────────────────────────

type PickerMode = 'RGB' | 'HSV' | 'HEX'
const MODES: PickerMode[] = ['RGB', 'HSV', 'HEX']

// ─── Component ────────────────────────────────────────────────────────────────

export interface EmbedColorPickerProps {
  /** Float RGBA color: r/g/b ∈ [0,∞) (>1 = HDR), a ∈ [0,1]. */
  value: RGBAColor
  onChange: (color: RGBAColor) => void
  /**
   * When true, restricts the picker to grayscale only.
   * Used when painting on a layer mask.
   */
  grayscaleOnly?: boolean
  /** When true, shows HDR intensity field and float channel readout. */
  isHdrMode?: boolean
}

/**
 * Inline color picker: SV gradient square, hue strip, color preview, and
 * switchable input modes (RGB / HSV / HEX). Contains no portal or positioning
 * logic — wrap it in whatever container / popup you need.
 */
export function EmbedColorPicker({ value, onChange, grayscaleOnly = false, isHdrMode = false }: EmbedColorPickerProps): React.JSX.Element {
  const gradRef = useRef<HTMLCanvasElement>(null)
  const hueRef  = useRef<HTMLCanvasElement>(null)

  const [mode, setMode] = useState<PickerMode>('RGB')

  // intensity: HDR multiplier (≥1). rgb is the SDR color direction (0-255).
  const initIntensity = Math.max(1.0, value.r, value.g, value.b)
  const initR255 = Math.round(Math.min(value.r / initIntensity, 1) * 255)
  const initG255 = Math.round(Math.min(value.g / initIntensity, 1) * 255)
  const initB255 = Math.round(Math.min(value.b / initIntensity, 1) * 255)
  const [rgb, setRgb] = useState<[number, number, number]>(() => [initR255, initG255, initB255])
  const [intensity, setIntensity] = useState(() => initIntensity)
  const initHsv = rgbToHsv(initR255, initG255, initB255)
  const [hue, setHue] = useState(initHsv[0])
  const [sat, setSat] = useState(initHsv[1])
  const [val, setVal] = useState(initHsv[2])

  // Draw gradient — re-runs whenever hue/sat/val change, or when the canvas
  // is newly mounted after switching away from grayscaleOnly mode.
  useEffect(() => {
    const c = gradRef.current; if (!c) return
    drawSvGradient(c, hue, sat, val)
  }, [hue, sat, val, grayscaleOnly])

  // Draw hue strip — same: re-runs when canvas is newly mounted.
  useEffect(() => {
    const c = hueRef.current; if (!c) return
    drawHueStrip(c, hue)
  }, [hue, grayscaleOnly])

  const fire = useCallback((r: number, g: number, b: number, currentIntensity: number): void => {
    setRgb([r, g, b])
    onChange({ r: (r / 255) * currentIntensity, g: (g / 255) * currentIntensity, b: (b / 255) * currentIntensity, a: 1 })
  }, [onChange])

  const onGradPointer = useCallback((e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.type === 'pointerdown') e.currentTarget.setPointerCapture(e.pointerId)
    if (e.buttons === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const s = clamp((e.clientX - rect.left) / rect.width, 0, 1)
    const v = clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1)
    setSat(s); setVal(v)
    fire(...hsvToRgb(hue, s, v), intensity)
  }, [hue, fire, intensity])

  const onHuePointer = useCallback((e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.type === 'pointerdown') e.currentTarget.setPointerCapture(e.pointerId)
    if (e.buttons === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const h = clamp((e.clientY - rect.top) / rect.height, 0, 1) * 360
    setHue(h)
    fire(...hsvToRgb(h, sat, val), intensity)
  }, [sat, val, fire, intensity])

  // ── RGB mode ────────────────────────────────────────────────────────────────

  const onRgbChannelChange = (ch: number, n: number): void => {
    const c = clamp(n, 0, 255)
    const nr = ch === 0 ? c : rgb[0]
    const ng = ch === 1 ? c : rgb[1]
    const nb = ch === 2 ? c : rgb[2]
    const [h, s, v] = rgbToHsv(nr, ng, nb)
    setHue(h); setSat(s); setVal(v)
    fire(nr, ng, nb, intensity)
  }

  // ── HSV mode ────────────────────────────────────────────────────────────────

  const onHsvChannelChange = (ch: number, n: number): void => {
    const nh = ch === 0 ? clamp(n, 0, 360) : hue
    const ns = ch === 1 ? clamp(n / 100, 0, 1) : sat
    const nv = ch === 2 ? clamp(n / 100, 0, 1) : val
    setHue(nh); setSat(ns); setVal(nv)
    fire(...hsvToRgb(nh, ns, nv), intensity)
  }

  // Contextual gradients for HSV sliders
  const hsvGradients = [
    // H: full hue rainbow
    'linear-gradient(to right, hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%))',
    // S: desaturated → saturated at current hue+val
    `linear-gradient(to right, rgb(${hsvToRgb(hue, 0, val).join(',')}), rgb(${hsvToRgb(hue, 1, val).join(',')}))`,
    // V: black → full-brightness at current hue+sat
    `linear-gradient(to right, #000, rgb(${hsvToRgb(hue, sat, 1).join(',')}))`,
  ]

  // ── HEX mode ────────────────────────────────────────────────────────────────

  const onHexInput = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const hex = e.target.value.replace(/[^0-9a-f]/gi, '').slice(0, 6)
    if (hex.length === 6) {
      const [r, g, b] = hexToRgb('#' + hex)
      const [h, s, v] = rgbToHsv(r, g, b)
      setHue(h); setSat(s); setVal(v)
      fire(r, g, b, intensity)
    }
  }

  const hexVal = toHex(rgb[0], rgb[1], rgb[2])

  // ── Grayscale-only mode (mask layers) ───────────────────────────────────────

  const onGraySlider = (v: number): void => {
    const g = Math.max(0, Math.min(255, v))
    onChange({ r: g / 255, g: g / 255, b: g / 255, a: 1 })
  }

  if (grayscaleOnly) {
    const grayValue = Math.round(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2])
    const grayHex = toHex(grayValue, grayValue, grayValue)
    return (
      <div className={styles.picker}>
        <div className={styles.previewRow}>
          <div className={styles.preview} style={{ background: grayHex }} />
          <span className={styles.maskModeHint}>Mask — grayscale only</span>
        </div>
        <div className={styles.channels}>
          <div className={styles.channelRow}>
            <span className={styles.chLabel}>G</span>
            <input
              type="range" min={0} max={255} value={grayValue}
              className={styles.chSlider}
              style={{ background: 'linear-gradient(to right, #000, #fff)' }}
              onChange={(e) => onGraySlider(parseInt(e.target.value))}
            />
            <SliderInput
              min={0} max={255} value={grayValue} inputWidth={34}
              onChange={onGraySlider}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.picker}>
      {/* SV gradient + hue strip */}
      <div className={styles.gradientArea}>
        <canvas
          ref={gradRef}
          className={styles.gradCanvas}
          width={166}
          height={120}
          onPointerDown={onGradPointer}
          onPointerMove={onGradPointer}
        />
        <canvas
          ref={hueRef}
          className={styles.hueCanvas}
          width={14}
          height={120}
          onPointerDown={onHuePointer}
          onPointerMove={onHuePointer}
        />
      </div>

      {/* Preview + mode tabs */}
      <div className={styles.previewRow}>
        <div className={styles.preview} style={{ background: hexVal }} />
        <div className={styles.modeTabs}>
          {MODES.map((m) => (
            <button
              key={m}
              className={[styles.modeTab, m === mode ? styles.modeTabActive : ''].join(' ')}
              onClick={() => setMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* Mode-specific inputs */}
      {mode === 'RGB' && (
        <div className={styles.channels}>
          {(['R', 'G', 'B'] as const).map((ch, i) => {
            const n = rgb[i]
            const endColors = ['#f00', '#0f0', '#00f']
            return (
              <div key={ch} className={styles.channelRow}>
                <span className={styles.chLabel}>{ch}</span>
                <input
                  type="range" min={0} max={255} value={n}
                  className={styles.chSlider}
                  style={{ '--ch-end': endColors[i] } as React.CSSProperties}
                  onChange={(e) => onRgbChannelChange(i, parseInt(e.target.value))}
                />
                <SliderInput
                  min={0} max={255} value={n} inputWidth={34}
                  onChange={(v) => onRgbChannelChange(i, v)}
                />
              </div>
            )
          })}
        </div>
      )}

      {mode === 'HSV' && (
        <div className={styles.channels}>
          {([
            { label: 'H', value: Math.round(hue),       min: 0, max: 360, ch: 0 },
            { label: 'S', value: Math.round(sat * 100), min: 0, max: 100, ch: 1 },
            { label: 'V', value: Math.round(val * 100), min: 0, max: 100, ch: 2 },
          ]).map(({ label, value: n, min, max, ch }) => (
            <div key={label} className={styles.channelRow}>
              <span className={styles.chLabel}>{label}</span>
              <input
                type="range" min={min} max={max} value={n}
                className={styles.chSlider}
                style={{ background: hsvGradients[ch] }}
                onChange={(e) => onHsvChannelChange(ch, parseInt(e.target.value))}
              />
              <SliderInput
                min={min} max={max} value={n} inputWidth={34}
                onChange={(v) => onHsvChannelChange(ch, v)}
              />
            </div>
          ))}
        </div>
      )}

      {mode === 'HEX' && (
        <div className={styles.hexRow}>
          <span className={styles.hexLabel}>#</span>
          <input
            type="text"
            className={styles.hexInput}
            maxLength={6}
            defaultValue={hexVal.slice(1).toUpperCase()}
            key={hexVal}
            onChange={onHexInput}
            spellCheck={false}
          />
        </div>
      )}

      {isHdrMode && (
        <>
          <div className={styles.hdrIntensityRow}>
            <span className={styles.hdrLabel}>Intensity</span>
            <SliderInput
              min={0}
              max={16}
              step={0.01}
              value={intensity}
              inputWidth={48}
              onChange={(v) => {
                const newI = Math.max(0, Math.min(16, v))
                setIntensity(newI)
                onChange({ r: (rgb[0] / 255) * newI, g: (rgb[1] / 255) * newI, b: (rgb[2] / 255) * newI, a: 1 })
              }}
            />
          </div>
          <div className={styles.hdrFloatReadout}>
            {(() => {
              const fr = (rgb[0] / 255) * intensity
              const fg = (rgb[1] / 255) * intensity
              const fb = (rgb[2] / 255) * intensity
              const isOverflow = fr > 1.0 || fg > 1.0 || fb > 1.0
              return (
                <>
                  <span className={styles.hdrChannels}>
                    R:{fr.toFixed(2)} G:{fg.toFixed(2)} B:{fb.toFixed(2)}
                  </span>
                  {isOverflow && <span className={styles.hdrBadge}>HDR</span>}
                </>
              )
            })()}
          </div>
        </>
      )}
    </div>
  )
}
