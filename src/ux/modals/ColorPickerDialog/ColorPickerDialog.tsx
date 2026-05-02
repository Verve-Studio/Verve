import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { RGBAColor } from '@/types'
import { DialogButton } from '../../widgets/DialogButton/DialogButton'
import { ModalDialog } from '../ModalDialog/ModalDialog'
import styles from './ColorPickerDialog.module.scss'

interface DialogButtonRowProps {
  onConfirm: () => void
  onCancel: () => void
  onAddSwatch?: () => void
}

export function DialogButtonRow({ onConfirm, onCancel, onAddSwatch }: DialogButtonRowProps): React.JSX.Element {
  return (
    <div className={styles.buttonRow}>
      <DialogButton onClick={onConfirm}>OK</DialogButton>
      <DialogButton onClick={onCancel}>Cancel</DialogButton>
      {onAddSwatch && (
        <DialogButton onClick={onAddSwatch} title="Add current color to Swatches">
          Add to Swatches
        </DialogButton>
      )}
    </div>
  )
}


// ─── Types ────────────────────────────────────────────────────────────────────

// LL = Lab-Lightness, La = Lab-a, Lb = Lab-b  (CMYK has no gradient mode)
type Mode = 'H' | 'S' | 'B' | 'R' | 'G' | 'Bl' | 'LL' | 'La' | 'Lb'

export interface ColorPickerDialogProps {
  open: boolean
  title: string
  initialColor: RGBAColor
  onConfirm: (color: RGBAColor) => void
  onCancel: () => void
  onAddSwatch?: (color: RGBAColor) => void
  pixelFormat?: 'rgba8' | 'rgba32f' | 'indexed8'
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GRAD_W = 240
const GRAD_H = 240
const STRIP_W = 18
const STRIP_H = 240

// ─── Color math ───────────────────────────────────────────────────────────────

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h / 60) % 6
  const f = h / 60 - Math.floor(h / 60)
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s)
  const table: [number, number, number][] = [
    [v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q],
  ]
  return table[i] // returns [0,1] floats
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  const v = max, s = max === 0 ? 0 : d / max
  let h = 0
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d + 6) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  return [h, s, v]
}

function toHex6(r: number, g: number, b: number): string {
  return [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
}

function clamp01(v: number): number { return Math.max(0, Math.min(1, v)) }

// ─── Lab color math ───────────────────────────────────────────────────────────
// sRGB → CIE Lab via D65 illuminant

function linearize(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function delinearize(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return clamp01(v)
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = linearize(r), gl = linearize(g), bl = linearize(b)
  // sRGB → XYZ D65
  const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750
  const z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041
  // XYZ → Lab (D65 white: 0.95047, 1.00000, 1.08883)
  const f = (t: number): number => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116)
  const fx = f(x / 0.95047), fy = f(y / 1.00000), fz = f(z / 1.08883)
  const L = 116 * fy - 16
  const a = 500 * (fx - fy)
  const bv = 200 * (fy - fz)
  return [Math.round(L * 10) / 10, Math.round(a * 10) / 10, Math.round(bv * 10) / 10]
}

function labToRgb(L: number, a: number, bv: number): [number, number, number] {
  const fy = (L + 16) / 116
  const fx = a / 500 + fy
  const fz = fy - bv / 200
  const cube = (t: number): number => t * t * t
  const xr = cube(fx) > 0.008856 ? cube(fx) : (fx - 16 / 116) / 7.787
  const yr = cube(fy) > 0.008856 ? cube(fy) : (fy - 16 / 116) / 7.787
  const zr = cube(fz) > 0.008856 ? cube(fz) : (fz - 16 / 116) / 7.787
  const x = xr * 0.95047, y = yr * 1.00000, z = zr * 1.08883
  const rl =  x * 3.2404542 - y * 1.5371385 - z * 0.4985314
  const gl = -x * 0.9692660 + y * 1.8760108 + z * 0.0415560
  const bl =  x * 0.0556434 - y * 0.2040259 + z * 1.0572252
  return [delinearize(Math.max(0, rl)), delinearize(Math.max(0, gl)), delinearize(Math.max(0, bl))]
}

// ─── CMYK color math ──────────────────────────────────────────────────────────

function rgbToCmyk(r: number, g: number, b: number): [number, number, number, number] {
  const k = 1 - Math.max(r, g, b)
  if (k === 1) return [0, 0, 0, 100]
  const c = (1 - r - k) / (1 - k)
  const m = (1 - g - k) / (1 - k)
  const y = (1 - b - k) / (1 - k)
  return [Math.round(c * 100), Math.round(m * 100), Math.round(y * 100), Math.round(k * 100)]
}

function cmykToRgb(c: number, m: number, y: number, k: number): [number, number, number] {
  const cn = c / 100, mn = m / 100, yn = y / 100, kn = k / 100
  return [
    clamp01((1 - cn) * (1 - kn)),
    clamp01((1 - mn) * (1 - kn)),
    clamp01((1 - yn) * (1 - kn)),
  ]
}

// ─── Canvas drawing ───────────────────────────────────────────────────────────

function drawGradient(
  canvas: HTMLCanvasElement,
  mode: Mode,
  h: number, s: number, v: number,
  r: number, g: number, b: number,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width, H = canvas.height

  if (mode === 'H') {
    // SV plane — fast CSS gradient
    ctx.fillStyle = `hsl(${h}, 100%, 50%)`
    ctx.fillRect(0, 0, W, H)
    const wg = ctx.createLinearGradient(0, 0, W, 0)
    wg.addColorStop(0, 'rgba(255,255,255,1)')
    wg.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = wg; ctx.fillRect(0, 0, W, H)
    const bg = ctx.createLinearGradient(0, 0, 0, H)
    bg.addColorStop(0, 'rgba(0,0,0,0)')
    bg.addColorStop(1, 'rgba(0,0,0,1)')
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H)
    return
  }

  // Pixel-by-pixel for other modes
  const img = ctx.createImageData(W, H)
  const d = img.data
  for (let py = 0; py < H; py++) {
    const t = 1 - py / (H - 1) // t=1 at top, t=0 at bottom
    for (let px = 0; px < W; px++) {
      const u = px / (W - 1)
      let pr = 0, pg = 0, pb = 0
      switch (mode) {
        case 'S': [pr, pg, pb] = hsvToRgb(u * 360, s, t); break       // x=hue y=val
        case 'B': [pr, pg, pb] = hsvToRgb(u * 360, t, v); break       // x=hue y=sat
        case 'R': pr = r; pg = u; pb = t; break // x=G y=B
        case 'G': pr = u; pg = g; pb = t; break // x=R y=B
        case 'Bl': pr = u; pg = t; pb = b; break // x=R y=G
        // Lab gradient: x and y are the OTHER two Lab channels, fixed channel is current
        case 'LL': { const [lL] = rgbToLab(r, g, b); [pr,pg,pb] = labToRgb(lL, u*254-127, t*254-127); break } // x=a, y=b
        case 'La': { const [,la] = rgbToLab(r, g, b); [pr,pg,pb] = labToRgb(t*100, la, u*254-127); break }    // x=b, y=L
        case 'Lb': { const [,,lb] = rgbToLab(r, g, b); [pr,pg,pb] = labToRgb(t*100, u*254-127, lb); break }   // x=a, y=L
      }
      const i = (py * W + px) * 4
      d[i] = Math.round(pr * 255); d[i + 1] = Math.round(pg * 255); d[i + 2] = Math.round(pb * 255); d[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
}

function drawStrip(
  canvas: HTMLCanvasElement,
  mode: Mode,
  h: number, s: number, v: number,
  r: number, g: number, b: number,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width, H = canvas.height

  if (mode === 'H') {
    const grad = ctx.createLinearGradient(0, 0, 0, H)
    for (let deg = 0; deg <= 360; deg += 30) grad.addColorStop(deg / 360, `hsl(${deg},100%,50%)`)
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H)
    return
  }

  const img = ctx.createImageData(W, H)
  const d = img.data
  for (let py = 0; py < H; py++) {
    const t = 1 - py / (H - 1) // t=1 at top
    let pr = 0, pg = 0, pb = 0
    switch (mode) {
      case 'S':  [pr, pg, pb] = hsvToRgb(h, t, v); break             // S varies top→bottom
      case 'B':  [pr, pg, pb] = hsvToRgb(h, s, t); break             // V varies
      case 'R':  pr = t; pg = g; pb = b; break        // R varies
      case 'G':  pr = r; pg = t; pb = b; break        // G varies
      case 'Bl': pr = r; pg = g; pb = t; break        // B varies
      // Lab strips: the selected channel varies top→bottom
      case 'LL': { const [,la,lbv] = rgbToLab(r,g,b); [pr,pg,pb] = labToRgb(t*100, la, lbv); break }
      case 'La': { const [lL,,lbv] = rgbToLab(r,g,b); [pr,pg,pb] = labToRgb(lL, t*254-127, lbv); break }
      case 'Lb': { const [lL,la]   = rgbToLab(r,g,b); [pr,pg,pb] = labToRgb(lL, la, t*254-127); break }
    }
    for (let px = 0; px < W; px++) {
      const i = (py * W + px) * 4
      d[i] = Math.round(pr * 255); d[i + 1] = Math.round(pg * 255); d[i + 2] = Math.round(pb * 255); d[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
}

// Gradient crosshair: returns [xFrac, yFrac] both in [0,1], origin top-left
function getGradXY(mode: Mode, h: number, s: number, v: number, r: number, g: number, b: number): [number, number] {
  const [lL, la, lbv] = rgbToLab(r, g, b)
  switch (mode) {
    case 'H':  return [s,       1 - v      ]
    case 'S':  return [h / 360, 1 - v      ]
    case 'B':  return [h / 360, 1 - s      ]
    case 'R':  return [g,       1 - b      ]
    case 'G':  return [r,       1 - b      ]
    case 'Bl': return [r,       1 - g      ]
    // Lab: x=a(-127→127), y=L(100→0) for LL; x=b, y=L for La; x=a, y=L for Lb
    case 'LL': return [(la + 127) / 254, 1 - (lbv + 127) / 254]
    case 'La': return [(lbv + 127) / 254, 1 - lL / 100          ]
    case 'Lb': return [(la + 127) / 254,  1 - lL / 100          ]
  }
}

// Strip marker: returns yFrac in [0,1], 0=top
function getStripY(mode: Mode, h: number, s: number, v: number, r: number, g: number, b: number): number {
  const [lL, la, lbv] = rgbToLab(r, g, b)
  switch (mode) {
    case 'H':  return h / 360
    case 'S':  return 1 - s
    case 'B':  return 1 - v
    case 'R':  return 1 - r
    case 'G':  return 1 - g
    case 'Bl': return 1 - b
    case 'LL': return 1 - lL / 100
    case 'La': return 1 - (la + 127) / 254
    case 'Lb': return 1 - (lbv + 127) / 254
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ColorPickerDialog({
  open,
  title,
  initialColor,
  onConfirm,
  onCancel,
  onAddSwatch,
  pixelFormat = 'rgba8',
}: ColorPickerDialogProps): React.JSX.Element | null {
  const gradRef  = useRef<HTMLCanvasElement>(null)
  const stripRef = useRef<HTMLCanvasElement>(null)

  const [hue, setHue] = useState(0)
  const [sat, setSat] = useState(0)
  const [val, setVal] = useState(0)
  const [mode, setMode] = useState<Mode>('H')
  const [hexText, setHexText] = useState('')
  const [intensity, setIntensity] = useState(1)

  // Derive [0,1] float RGB from HSV
  const [r, g, b] = hsvToRgb(hue, sat, val)

  // Reset to initialColor whenever dialog opens
  useEffect(() => {
    if (!open) return
    const initIntensity = Math.max(1, initialColor.r, initialColor.g, initialColor.b)
    const ir = Math.min(initialColor.r / initIntensity, 1)
    const ig = Math.min(initialColor.g / initIntensity, 1)
    const ib = Math.min(initialColor.b / initIntensity, 1)
    const [nh, ns, nv] = rgbToHsv(ir, ig, ib)
    setHue(nh); setSat(ns); setVal(nv)
    setIntensity(initIntensity)
    setMode('H')
    setHexText(toHex6(ir, ig, ib))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Keep hex text in sync with canvas / numeric field changes
  useEffect(() => { setHexText(toHex6(r, g, b)) }, [r, g, b])

  // Escape / Enter keyboard handling (Escape delegated to ModalDialog)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') onConfirm({ r: r * intensity, g: g * intensity, b: b * intensity, a: 1 })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onConfirm, r, g, b])

  // Redraw gradient canvas
  useEffect(() => {
    if (!open || !gradRef.current) return
    drawGradient(gradRef.current, mode, hue, sat, val, r, g, b)
    const ctx = gradRef.current.getContext('2d')!
    const [gx, gy] = getGradXY(mode, hue, sat, val, r, g, b)
    const cx = gx * GRAD_W, cy = gy * GRAD_H
    ctx.save()
    const light = mode === 'H' ? (val > 0.55 && sat < 0.55) : false
    ctx.strokeStyle = light ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)'
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
  }, [open, mode, hue, sat, val, r, g, b])

  // Redraw strip canvas
  useEffect(() => {
    if (!open || !stripRef.current) return
    drawStrip(stripRef.current, mode, hue, sat, val, r, g, b)
    const ctx = stripRef.current.getContext('2d')!
    const sy = getStripY(mode, hue, sat, val, r, g, b) * STRIP_H
    ctx.save()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.5
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur = 2
    ctx.strokeRect(1, sy - 3, STRIP_W - 2, 6)
    ctx.restore()
  }, [open, mode, hue, sat, val, r, g, b])

  // Gradient pointer interaction
  const onGradPointer = useCallback((e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.type === 'pointerdown') e.currentTarget.setPointerCapture(e.pointerId)
    if (!(e.buttons & 1)) return
    const rect = e.currentTarget.getBoundingClientRect()
    const u = clamp01((e.clientX - rect.left) / rect.width)
    const y = clamp01((e.clientY - rect.top)  / rect.height)
    switch (mode) {
      case 'H':  setSat(u); setVal(1 - y); break
      case 'S':  setHue(u * 360); setVal(1 - y); break
      case 'B':  setHue(u * 360); setSat(1 - y); break
      case 'R': { const ng = u, nb = 1-y; const [nh,ns,nv] = rgbToHsv(r,ng,nb); setHue(nh);setSat(ns);setVal(nv); break }
      case 'G': { const nr = u, nb = 1-y; const [nh,ns,nv] = rgbToHsv(nr,g,nb); setHue(nh);setSat(ns);setVal(nv); break }
      case 'Bl':{ const nr = u, ng = 1-y; const [nh,ns,nv] = rgbToHsv(nr,ng,b); setHue(nh);setSat(ns);setVal(nv); break }
      case 'LL': { const [lL] = rgbToLab(r,g,b); const [nr,ng,nb] = labToRgb(lL, u*254-127, (1-y)*254-127); const [nh,ns,nv] = rgbToHsv(nr,ng,nb); setHue(nh);setSat(ns);setVal(nv); break }
      case 'La': { const [,la] = rgbToLab(r,g,b); const [nr,ng,nb] = labToRgb((1-y)*100, la, u*254-127); const [nh,ns,nv] = rgbToHsv(nr,ng,nb); setHue(nh);setSat(ns);setVal(nv); break }
      case 'Lb': { const [,,lbv] = rgbToLab(r,g,b); const [nr,ng,nb] = labToRgb((1-y)*100, u*254-127, lbv); const [nh,ns,nv] = rgbToHsv(nr,ng,nb); setHue(nh);setSat(ns);setVal(nv); break }
    }
  }, [mode, r, g, b])

  // Strip pointer interaction
  const onStripPointer = useCallback((e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.type === 'pointerdown') e.currentTarget.setPointerCapture(e.pointerId)
    if (!(e.buttons & 1)) return
    const rect = e.currentTarget.getBoundingClientRect()
    const y = clamp01((e.clientY - rect.top) / rect.height)
    switch (mode) {
      case 'H':  setHue(y * 360); break
      case 'S':  setSat(1 - y); break
      case 'B':  setVal(1 - y); break
      case 'R': { const nr = 1-y; const [nh,ns,nv] = rgbToHsv(nr,g,b); setHue(nh);setSat(ns);setVal(nv); break }
      case 'G': { const ng = 1-y; const [nh,ns,nv] = rgbToHsv(r,ng,b); setHue(nh);setSat(ns);setVal(nv); break }
      case 'Bl':{ const nb = 1-y; const [nh,ns,nv] = rgbToHsv(r,g,nb); setHue(nh);setSat(ns);setVal(nv); break }
      case 'LL': { const [,la,lbv] = rgbToLab(r,g,b); const [nr,ng,nb] = labToRgb((1-y)*100, la, lbv); const [nh,ns,nv] = rgbToHsv(nr,ng,nb); setHue(nh);setSat(ns);setVal(nv); break }
      case 'La': { const [lL,,lbv] = rgbToLab(r,g,b); const [nr,ng,nb] = labToRgb(lL, (1-y)*254-127, lbv); const [nh,ns,nv] = rgbToHsv(nr,ng,nb); setHue(nh);setSat(ns);setVal(nv); break }
      case 'Lb': { const [lL,la]   = rgbToLab(r,g,b); const [nr,ng,nb] = labToRgb(lL, la, (1-y)*254-127); const [nh,ns,nv] = rgbToHsv(nr,ng,nb); setHue(nh);setSat(ns);setVal(nv); break }
    }
  }, [mode, r, g, b])

  // Numeric field helpers
  const setH = (v: number): void => { setHue(Math.max(0, Math.min(360, v))) }
  const setS = (v: number): void => { setSat(Math.max(0, Math.min(100, v)) / 100) }
  const setV = (v: number): void => { setVal(Math.max(0, Math.min(100, v)) / 100) }
  const setR = (v: number): void => { const [nh,ns,nv] = rgbToHsv(clamp01(v),g,b); setHue(nh);setSat(ns);setVal(nv) }
  const setG = (v: number): void => { const [nh,ns,nv] = rgbToHsv(r,clamp01(v),b); setHue(nh);setSat(ns);setVal(nv) }
  const setB = (v: number): void => { const [nh,ns,nv] = rgbToHsv(r,g,clamp01(v)); setHue(nh);setSat(ns);setVal(nv) }

  const [labL, labA, labB] = rgbToLab(r, g, b)
  const [cmykC, cmykM, cmykY, cmykK] = rgbToCmyk(r, g, b)

  const setLabL = (v: number): void => { const [nr,ng,nb] = labToRgb(Math.max(0,Math.min(100,v)), labA, labB); const [nh,ns,nv] = rgbToHsv(nr,ng,nb); setHue(nh);setSat(ns);setVal(nv) }
  const setLabA = (v: number): void => { const [nr,ng,nb] = labToRgb(labL, Math.max(-127,Math.min(127,v)), labB); const [nh,ns,nv] = rgbToHsv(nr,ng,nb); setHue(nh);setSat(ns);setVal(nv) }
  const setLabB = (v: number): void => { const [nr,ng,nb] = labToRgb(labL, labA, Math.max(-127,Math.min(127,v))); const [nh,ns,nv] = rgbToHsv(nr,ng,nb); setHue(nh);setSat(ns);setVal(nv) }
  const setCmykC = (v: number): void => { const [nr,ng,nb] = cmykToRgb(Math.max(0,Math.min(100,v)), cmykM, cmykY, cmykK); const [nh,ns,nv] = rgbToHsv(nr,ng,nb); setHue(nh);setSat(ns);setVal(nv) }
  const setCmykM = (v: number): void => { const [nr,ng,nb] = cmykToRgb(cmykC, Math.max(0,Math.min(100,v)), cmykY, cmykK); const [nh,ns,nv] = rgbToHsv(nr,ng,nb); setHue(nh);setSat(ns);setVal(nv) }
  const setCmykY = (v: number): void => { const [nr,ng,nb] = cmykToRgb(cmykC, cmykM, Math.max(0,Math.min(100,v)), cmykK); const [nh,ns,nv] = rgbToHsv(nr,ng,nb); setHue(nh);setSat(ns);setVal(nv) }
  const setCmykK = (v: number): void => { const [nr,ng,nb] = cmykToRgb(cmykC, cmykM, cmykY, Math.max(0,Math.min(100,v))); const [nh,ns,nv] = rgbToHsv(nr,ng,nb); setHue(nh);setSat(ns);setVal(nv) }

  const onHexChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const raw = e.target.value.replace(/[^0-9a-f]/gi, '').slice(0, 6).toUpperCase()
    setHexText(raw)
    if (raw.length === 6) {
      const rv = parseInt(raw.slice(0, 2), 16) / 255
      const gv = parseInt(raw.slice(2, 4), 16) / 255
      const bv = parseInt(raw.slice(4, 6), 16) / 255
      const [nh, ns, nv] = rgbToHsv(rv, gv, bv)
      setHue(nh); setSat(ns); setVal(nv)
    }
  }

  const currentHex = `#${toHex6(Math.min(initialColor.r, 1), Math.min(initialColor.g, 1), Math.min(initialColor.b, 1))}`
  const newHex     = `#${toHex6(r, g, b)}`

  if (!open) return null

  return (
    <ModalDialog open={open} title={title} width={520} onClose={onCancel}>

        {/* Body */}
        <div className={styles.body}>

          {/* ── Left: gradient + strip + HSV sliders ─────────────────── */}
          <div className={styles.leftColumn}>
            <div className={styles.gradientArea}>
              <canvas
                ref={gradRef}
                className={styles.gradCanvas}
                width={GRAD_W}
                height={GRAD_H}
                onPointerDown={onGradPointer}
                onPointerMove={onGradPointer}
              />
              <canvas
                ref={stripRef}
                className={styles.stripCanvas}
                width={STRIP_W}
                height={STRIP_H}
                onPointerDown={onStripPointer}
                onPointerMove={onStripPointer}
              />
            </div>

            {/* HSV sliders */}
            <div className={styles.hsvSliders}>
              {/* H */}
              <div className={styles.hsvRow}>
                <span className={styles.hsvLabel}>H</span>
                <input
                  type="range" min={0} max={360} step={1}
                  value={Math.round(hue)}
                  className={styles.hsvSlider}
                  style={{ background: 'linear-gradient(to right, hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%))' }}
                  onChange={(e) => setHue(+e.target.value)}
                />
                <span className={styles.hsvValue}>{Math.round(hue)}°</span>
              </div>
              {/* S */}
              <div className={styles.hsvRow}>
                <span className={styles.hsvLabel}>S</span>
                <input
                  type="range" min={0} max={100} step={1}
                  value={Math.round(sat * 100)}
                  className={styles.hsvSlider}
                  style={{ background: `linear-gradient(to right, rgb(${hsvToRgb(hue, 0, val).map(v => Math.round(v*255)).join(',')}), rgb(${hsvToRgb(hue, 1, val).map(v => Math.round(v*255)).join(',')}))`  }}
                  onChange={(e) => setSat(+e.target.value / 100)}
                />
                <span className={styles.hsvValue}>{Math.round(sat * 100)}%</span>
              </div>
              {/* B */}
              <div className={styles.hsvRow}>
                <span className={styles.hsvLabel}>B</span>
                <input
                  type="range" min={0} max={100} step={1}
                  value={Math.round(val * 100)}
                  className={styles.hsvSlider}
                  style={{ background: `linear-gradient(to right, #000, rgb(${hsvToRgb(hue, sat, 1).map(v => Math.round(v*255)).join(',')}))`  }}
                  onChange={(e) => setVal(+e.target.value / 100)}
                />
                <span className={styles.hsvValue}>{Math.round(val * 100)}%</span>
              </div>
              {/* Intensity (HDR only) */}
              {pixelFormat === 'rgba32f' && (
                <div className={styles.hsvRow}>
                  <span className={styles.hsvLabel}>I</span>
                  <input
                    type="range" min={1} max={16} step={0.01}
                    value={intensity}
                    className={styles.hsvSlider}
                    style={{ background: `linear-gradient(to right, rgb(${hsvToRgb(hue, sat, val).map(v => Math.round(v*255)).join(',')}), rgb(255,255,255))` }}
                    onChange={(e) => setIntensity(+e.target.value)}
                  />
                  <span className={styles.hsvValue}>{intensity.toFixed(2)}×</span>
                </div>
              )}
            </div>
          </div>

          {/* ── Right: buttons + preview + inputs ─────────────────────── */}
          <div className={styles.rightPanel}>

            {/* OK / Cancel / Add to Swatches */}
            <DialogButtonRow
              onConfirm={() => onConfirm({ r: r * intensity, g: g * intensity, b: b * intensity, a: 1 })}
              onCancel={onCancel}
              onAddSwatch={onAddSwatch ? () => onAddSwatch({ r: r * intensity, g: g * intensity, b: b * intensity, a: 1 }) : undefined}
            />

            {/* New / Current color preview */}
            <div className={styles.preview}>
              <span className={styles.previewLabel}>new</span>
              <div className={styles.previewSwatch}>
                <div className={styles.previewNew}     style={{ background: newHex }} />
                <div className={styles.previewCurrent} style={{ background: currentHex }} />
              </div>
              <span className={styles.previewLabel}>current</span>
            </div>

            {/* HSB + RGB + Lab + CMYK fields — two columns */}
            <div className={styles.fieldsRow}>

              {/* ── Left column: HSB + RGB ──────────────────────────── */}
              <div className={styles.fields}>

                {/* H */}
                <label className={styles.fieldRow}>
                  <input type="radio" name="cpMode" className={styles.radio} checked={mode === 'H'} onChange={() => setMode('H')} />
                  <span className={styles.fieldLabel}>H:</span>
                  <input type="number" className={styles.numInput} min={0} max={360} value={Math.round(hue)} onChange={(e) => setH(+e.target.value)} />
                  <span className={styles.unit}>°</span>
                </label>

                {/* S */}
                <label className={styles.fieldRow}>
                  <input type="radio" name="cpMode" className={styles.radio} checked={mode === 'S'} onChange={() => setMode('S')} />
                  <span className={styles.fieldLabel}>S:</span>
                  <input type="number" className={styles.numInput} min={0} max={100} value={Math.round(sat * 100)} onChange={(e) => setS(+e.target.value)} />
                  <span className={styles.unit}>%</span>
                </label>

                {/* B (brightness/value) */}
                <label className={styles.fieldRow}>
                  <input type="radio" name="cpMode" className={styles.radio} checked={mode === 'B'} onChange={() => setMode('B')} />
                  <span className={styles.fieldLabel}>B:</span>
                  <input type="number" className={styles.numInput} min={0} max={100} value={Math.round(val * 100)} onChange={(e) => setV(+e.target.value)} />
                  <span className={styles.unit}>%</span>
                </label>

                <div className={styles.fieldDivider} />

                {/* R */}
                <label className={styles.fieldRow}>
                  <input type="radio" name="cpMode" className={styles.radio} checked={mode === 'R'} onChange={() => setMode('R')} />
                  <span className={styles.fieldLabel}>R:</span>
                  {pixelFormat === 'rgba32f'
                    ? <input type="number" className={styles.numInput} min={0} max={1} step={0.001} value={parseFloat(r.toFixed(4))} onChange={(e) => setR(+e.target.value)} />
                    : <input type="number" className={styles.numInput} min={0} max={255} value={Math.round(r * 255)} onChange={(e) => setR(+e.target.value / 255)} />}
                </label>

                {/* G */}
                <label className={styles.fieldRow}>
                  <input type="radio" name="cpMode" className={styles.radio} checked={mode === 'G'} onChange={() => setMode('G')} />
                  <span className={styles.fieldLabel}>G:</span>
                  {pixelFormat === 'rgba32f'
                    ? <input type="number" className={styles.numInput} min={0} max={1} step={0.001} value={parseFloat(g.toFixed(4))} onChange={(e) => setG(+e.target.value)} />
                    : <input type="number" className={styles.numInput} min={0} max={255} value={Math.round(g * 255)} onChange={(e) => setG(+e.target.value / 255)} />}
                </label>

                {/* Blue */}
                <label className={styles.fieldRow}>
                  <input type="radio" name="cpMode" className={styles.radio} checked={mode === 'Bl'} onChange={() => setMode('Bl')} />
                  <span className={styles.fieldLabel}>B:</span>
                  {pixelFormat === 'rgba32f'
                    ? <input type="number" className={styles.numInput} min={0} max={1} step={0.001} value={parseFloat(b.toFixed(4))} onChange={(e) => setB(+e.target.value)} />
                    : <input type="number" className={styles.numInput} min={0} max={255} value={Math.round(b * 255)} onChange={(e) => setB(+e.target.value / 255)} />}
                </label>

                {/* Hex */}
                <div className={styles.hexRow}>
                  <span className={styles.hexHash}>#</span>
                  <input
                    type="text"
                    className={styles.hexInput}
                    maxLength={6}
                    value={hexText}
                    onChange={onHexChange}
                    spellCheck={false}
                  />
                </div>

              </div>

              {/* ── Right column: Lab + CMYK ────────────────────────── */}
              <div className={styles.fields}>

                {/* L* */}
                <label className={styles.fieldRow}>
                  <input type="radio" name="cpMode" className={styles.radio} checked={mode === 'LL'} onChange={() => setMode('LL')} />
                  <span className={styles.fieldLabel}>L:</span>
                  <input type="number" className={styles.numInput} min={0} max={100} value={Math.round(labL)} onChange={(e) => setLabL(+e.target.value)} />
                </label>

                {/* a* */}
                <label className={styles.fieldRow}>
                  <input type="radio" name="cpMode" className={styles.radio} checked={mode === 'La'} onChange={() => setMode('La')} />
                  <span className={styles.fieldLabel}>a:</span>
                  <input type="number" className={styles.numInput} min={-127} max={127} value={Math.round(labA)} onChange={(e) => setLabA(+e.target.value)} />
                </label>

                {/* b* */}
                <label className={styles.fieldRow}>
                  <input type="radio" name="cpMode" className={styles.radio} checked={mode === 'Lb'} onChange={() => setMode('Lb')} />
                  <span className={styles.fieldLabel}>b:</span>
                  <input type="number" className={styles.numInput} min={-127} max={127} value={Math.round(labB)} onChange={(e) => setLabB(+e.target.value)} />
                </label>

                <div className={styles.fieldDivider} />

                {/* C */}
                <div className={styles.fieldRow}>
                  <span className={styles.radioSpacer} />
                  <span className={styles.fieldLabel}>C:</span>
                  <input type="number" className={styles.numInput} min={0} max={100} value={cmykC} onChange={(e) => setCmykC(+e.target.value)} />
                  <span className={styles.unit}>%</span>
                </div>

                {/* M */}
                <div className={styles.fieldRow}>
                  <span className={styles.radioSpacer} />
                  <span className={styles.fieldLabel}>M:</span>
                  <input type="number" className={styles.numInput} min={0} max={100} value={cmykM} onChange={(e) => setCmykM(+e.target.value)} />
                  <span className={styles.unit}>%</span>
                </div>

                {/* Y */}
                <div className={styles.fieldRow}>
                  <span className={styles.radioSpacer} />
                  <span className={styles.fieldLabel}>Y:</span>
                  <input type="number" className={styles.numInput} min={0} max={100} value={cmykY} onChange={(e) => setCmykY(+e.target.value)} />
                  <span className={styles.unit}>%</span>
                </div>

                {/* K */}
                <div className={styles.fieldRow}>
                  <span className={styles.radioSpacer} />
                  <span className={styles.fieldLabel}>K:</span>
                  <input type="number" className={styles.numInput} min={0} max={100} value={cmykK} onChange={(e) => setCmykK(+e.target.value)} />
                  <span className={styles.unit}>%</span>
                </div>

              </div>
            </div>
          </div>
        </div>
    </ModalDialog>
  )
}
