import React, { useState, useEffect, useCallback, useMemo } from 'react'
import type { BackgroundFill, PixelFormat } from '@/types'
import { DialogButton } from '../../widgets/DialogButton/DialogButton'
import { ModalDialog } from '../ModalDialog/ModalDialog'
import styles from './NewImageDialog.module.scss'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NewImageSettings {
  width: number
  height: number
  backgroundFill: BackgroundFill
  pixelFormat: PixelFormat
}

export interface NewImageDialogProps {
  open: boolean
  onConfirm: (settings: NewImageSettings) => void
  onCancel: () => void
}

type Unit = 'px' | 'in' | 'cm' | 'mm'

// ─── Presets ──────────────────────────────────────────────────────────────────

interface Preset {
  label: string
  sub: string
  width: number   // pixels
  height: number  // pixels
  ppi?: number    // if present, also sets the resolution field
}

const DIGITAL_PRESETS: Preset[] = [
  { label: '16 × 16',     sub: 'Icon',      width: 16,   height: 16   },
  { label: '32 × 32',     sub: 'Icon',      width: 32,   height: 32   },
  { label: '64 × 64',     sub: 'Icon',      width: 64,   height: 64   },
  { label: '128 × 128',   sub: 'Pixel art', width: 128,  height: 128  },
  { label: '256 × 256',   sub: 'Pixel art', width: 256,  height: 256  },
  { label: '512 × 512',   sub: 'Default',   width: 512,  height: 512  },
  { label: '1024 × 1024', sub: 'Large',     width: 1024, height: 1024 },
  { label: '1920 × 1080', sub: 'HD',        width: 1920, height: 1080 },
  { label: '3840 × 2160', sub: '4K',        width: 3840, height: 2160 },
]

// Portrait dimensions at 300 PPI
const mm = (mm_: number): number => Math.round((mm_ / 25.4) * 300)
const PRINT_PRESETS: Preset[] = [
  { label: 'A5',     sub: '148 × 210 mm', width: mm(148), height: mm(210),        ppi: 300 },
  { label: 'A4',     sub: '210 × 297 mm', width: mm(210), height: mm(297),        ppi: 300 },
  { label: 'A3',     sub: '297 × 420 mm', width: mm(297), height: mm(420),        ppi: 300 },
  { label: 'A2',     sub: '420 × 594 mm', width: mm(420), height: mm(594),        ppi: 300 },
  { label: 'A1',     sub: '594 × 841 mm', width: mm(594), height: mm(841),        ppi: 300 },
  { label: 'Letter', sub: '8.5 × 11 in',  width: 2550,    height: 3300,          ppi: 300 },
]

// ─── Unit helpers ─────────────────────────────────────────────────────────────

function pxToUnit(px: number, unit: Unit, ppi: number): number {
  if (unit === 'in') return px / ppi
  if (unit === 'cm') return (px / ppi) * 2.54
  if (unit === 'mm') return (px / ppi) * 25.4
  return px
}

function unitToPx(val: number, unit: Unit, ppi: number): number {
  if (unit === 'in') return Math.round(val * ppi)
  if (unit === 'cm') return Math.round((val / 2.54) * ppi)
  if (unit === 'mm') return Math.round((val / 25.4) * ppi)
  return Math.round(val)
}

function roundDisplay(val: number, unit: Unit): number {
  if (unit === 'px') return Math.round(val)
  if (unit === 'mm') return Math.round(val * 10) / 10
  return Math.round(val * 100) / 100
}

const UNIT_STEP:  Record<Unit, number> = { px: 1, in: 0.01, cm: 0.01, mm: 0.1 }
const UNIT_LABEL: Record<Unit, string> = { px: 'px', in: 'in', cm: 'cm', mm: 'mm' }

// ─── Icons ────────────────────────────────────────────────────────────────────

function DocIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 32 38" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M4 3 H20 L28 11 V35 A2 2 0 0 1 26 37 H6 A2 2 0 0 1 4 35 Z" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M20 3 V11 H28" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
    </svg>
  )
}

function ClipboardIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <rect x="1.5" y="3.5" width="10" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.5 3.5V2.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function NewImageDialog({ open, onConfirm, onCancel }: NewImageDialogProps): React.JSX.Element | null {
  const [widthPx, setWidthPx]         = useState(512)
  const [heightPx, setHeightPx]       = useState(512)
  const [ppi, setPpi]                 = useState(72)
  const [unit, setUnit]               = useState<Unit>('px')
  const [backgroundFill, setBg]       = useState<BackgroundFill>('white')
  const [selectedPreset, setPreset]   = useState('512 × 512')
  const [pixelFormat, setPixelFormat] = useState<PixelFormat>('rgba8')

  useEffect(() => {
    if (open) {
      setWidthPx(512); setHeightPx(512); setPpi(72)
      setUnit('px'); setBg('white'); setPreset('512 × 512'); setPixelFormat('rgba8')
    }
  }, [open])

  // ── Computed display values ───────────────────────────────────────
  const dispW    = ppi > 0 ? roundDisplay(pxToUnit(widthPx,  unit, ppi), unit) : 0
  const dispH    = ppi > 0 ? roundDisplay(pxToUnit(heightPx, unit, ppi), unit) : 0
  const maxDisp  = roundDisplay(pxToUnit(16384, unit, ppi), unit)
  const isPortrait = widthPx <= heightPx

  // ── Preset handlers ───────────────────────────────────────────────
  const handlePreset = useCallback((p: Preset): void => {
    setWidthPx(p.width)
    setHeightPx(p.height)
    setPreset(p.label)
    if (p.ppi) setPpi(p.ppi)
  }, [])

  const handleClipboardSize = useCallback(async (): Promise<void> => {
    try {
      const b64 = await window.api.clipboardReadImage()
      if (!b64) return
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload  = () => resolve(el)
        el.onerror = reject
        el.src = `data:image/png;base64,${b64}`
      })
      setWidthPx(img.naturalWidth)
      setHeightPx(img.naturalHeight)
      setPreset('Clipboard')
    } catch { /* clipboard empty or no image — silently ignore */ }
  }, [])

  // ── Dimension / resolution handlers ──────────────────────────────
  const handleWidthChange = useCallback((v: number): void => {
    setWidthPx(unitToPx(v, unit, ppi))
    setPreset('')
  }, [unit, ppi])

  const handleHeightChange = useCallback((v: number): void => {
    setHeightPx(unitToPx(v, unit, ppi))
    setPreset('')
  }, [unit, ppi])

  // When in a physical unit, changing PPI keeps physical size and rescales pixels
  const handlePpiChange = useCallback((newPpi: number): void => {
    if (newPpi < 1) return
    if (unit !== 'px') {
      setWidthPx(prev  => Math.max(1, Math.min(16384, Math.round(prev  * newPpi / ppi))))
      setHeightPx(prev => Math.max(1, Math.min(16384, Math.round(prev  * newPpi / ppi))))
    }
    setPpi(newPpi)
    setPreset('')
  }, [unit, ppi])

  const handlePortrait = useCallback((): void => {
    if (widthPx > heightPx) { setWidthPx(heightPx); setHeightPx(widthPx); setPreset('') }
  }, [widthPx, heightPx])

  const handleLandscape = useCallback((): void => {
    if (heightPx > widthPx) { setWidthPx(heightPx); setHeightPx(widthPx); setPreset('') }
  }, [widthPx, heightPx])

  const handleConfirm = useCallback((): void => {
    const w = Math.max(1, Math.min(16384, Math.round(widthPx  || 1)))
    const h = Math.max(1, Math.min(16384, Math.round(heightPx || 1)))
    onConfirm({ width: w, height: h, backgroundFill, pixelFormat })
  }, [widthPx, heightPx, backgroundFill, pixelFormat, onConfirm])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') { e.stopPropagation(); handleConfirm() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, handleConfirm])

  const sizeLabel  = useMemo(() => `${widthPx} × ${heightPx} px`, [widthPx, heightPx])
  const physLabel  = unit !== 'px' ? `${dispW} × ${dispH} ${UNIT_LABEL[unit]}` : null

  return (
    <ModalDialog open={open} title="New Document" width={640} onClose={onCancel}>

        {/* ── Body ─────────────────────────────────────────────────── */}
        <div className={styles.body}>

          {/* Left: preset panels */}
          <div className={styles.presetsPanel}>
            <p className={styles.sectionTitle}>PRESETS</p>

            <p className={styles.presetGroupLabel}>Digital</p>
            <div className={styles.presetsGrid}>
              {DIGITAL_PRESETS.map((p) => (
                <DialogButton
                  key={p.label}
                  className={`${styles.presetCard} ${selectedPreset === p.label ? styles.presetSelected : ''}`}
                  onClick={() => handlePreset(p)}
                  title={`${p.width} × ${p.height} px`}
                >
                  <DocIcon />
                  <span className={styles.presetDims}>{p.label}</span>
                  <span className={styles.presetSub}>{p.sub}</span>
                </DialogButton>
              ))}
            </div>

            <p className={styles.presetGroupLabel}>Print <span className={styles.presetGroupNote}>@ 300 ppi</span></p>
            <div className={styles.presetsGrid}>
              {PRINT_PRESETS.map((p) => (
                <DialogButton
                  key={p.label}
                  className={`${styles.presetCard} ${selectedPreset === p.label ? styles.presetSelected : ''}`}
                  onClick={() => handlePreset(p)}
                  title={`${p.width} × ${p.height} px`}
                >
                  <DocIcon />
                  <span className={styles.presetDims}>{p.label}</span>
                  <span className={styles.presetSub}>{p.sub}</span>
                </DialogButton>
              ))}
            </div>

            <button
              className={`${styles.clipboardBtn} ${selectedPreset === 'Clipboard' ? styles.clipboardBtnActive : ''}`}
              onClick={() => { void handleClipboardSize() }}
              title="Set dimensions from clipboard image"
            >
              <ClipboardIcon />
              Clipboard Size
            </button>
          </div>

          <div className={styles.divider} />

          {/* Right: detail form */}
          <div className={styles.detailsPanel}>
            <p className={styles.sectionTitle}>DOCUMENT DETAILS</p>
            <p className={styles.sizePreview}>{sizeLabel}</p>
            {physLabel && <p className={styles.sizePreviewPhys}>{physLabel}</p>}

            {/* Width */}
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel} htmlFor="ni-width">Width</label>
              <div className={styles.inputGroup}>
                <input
                  id="ni-width"
                  type="number"
                  className={styles.numInput}
                  value={dispW}
                  min={unit === 'px' ? 1 : 0.001}
                  max={maxDisp}
                  step={UNIT_STEP[unit]}
                  onChange={(e) => { const v = e.target.valueAsNumber; if (!isNaN(v) && v > 0) handleWidthChange(v) }}
                />
                <span className={styles.unit}>{UNIT_LABEL[unit]}</span>
              </div>
            </div>

            {/* Height */}
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel} htmlFor="ni-height">Height</label>
              <div className={styles.inputGroup}>
                <input
                  id="ni-height"
                  type="number"
                  className={styles.numInput}
                  value={dispH}
                  min={unit === 'px' ? 1 : 0.001}
                  max={maxDisp}
                  step={UNIT_STEP[unit]}
                  onChange={(e) => { const v = e.target.valueAsNumber; if (!isNaN(v) && v > 0) handleHeightChange(v) }}
                />
                <span className={styles.unit}>{UNIT_LABEL[unit]}</span>
              </div>
            </div>

            {/* Units */}
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel} htmlFor="ni-unit">Units</label>
              <select
                id="ni-unit"
                className={`${styles.select} ${styles.selectUnits}`}
                value={unit}
                onChange={(e) => setUnit(e.target.value as Unit)}
              >
                <option value="px">Pixels</option>
                <option value="in">Inches</option>
                <option value="cm">Centimeters</option>
                <option value="mm">Millimeters</option>
              </select>
            </div>

            {/* Orientation */}
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel}>Orientation</label>
              <div className={styles.orientGroup}>
                <DialogButton
                  className={`${styles.orientBtn} ${isPortrait ? styles.orientActive : ''}`}
                  onClick={handlePortrait}
                  title="Portrait"
                  aria-label="Portrait"
                  aria-pressed={isPortrait}
                >
                  <svg viewBox="0 0 12 16" width="12" height="16" aria-hidden="true">
                    <rect x="1.5" y="1.5" width="9" height="13" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
                  </svg>
                </DialogButton>
                <DialogButton
                  className={`${styles.orientBtn} ${!isPortrait ? styles.orientActive : ''}`}
                  onClick={handleLandscape}
                  title="Landscape"
                  aria-label="Landscape"
                  aria-pressed={!isPortrait}
                >
                  <svg viewBox="0 0 16 12" width="16" height="12" aria-hidden="true">
                    <rect x="1.5" y="1.5" width="13" height="9" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
                  </svg>
                </DialogButton>
              </div>
            </div>

            {/* Resolution */}
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel} htmlFor="ni-res">Resolution</label>
              <div className={styles.inputGroup}>
                <input
                  id="ni-res"
                  type="number"
                  className={styles.numInput}
                  value={ppi}
                  min={1}
                  max={1200}
                  step={1}
                  onChange={(e) => { const v = e.target.valueAsNumber; if (!isNaN(v) && v >= 1) handlePpiChange(v) }}
                />
                <span className={styles.unit}>px/in</span>
              </div>
            </div>

            {/* Color Mode */}
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel} htmlFor="ni-colormode">Color Mode</label>
              <select
                id="ni-colormode"
                className={styles.select}
                value={pixelFormat}
                onChange={(e) => setPixelFormat(e.target.value as PixelFormat)}
              >
                <option value="rgba8">RGB / 8 bit</option>
                <option value="rgba32f">RGB / 32 bit float</option>
                <option value="indexed8">Indexed / 8 bit</option>
              </select>
            </div>

            {/* Background Contents */}
            <div className={`${styles.fieldRow} ${styles.fieldRowBg}`}>
              <label className={styles.fieldLabel}>Background</label>
              <div className={styles.bgGroup}>
                {(['white', 'black', 'transparent'] as BackgroundFill[]).map((fill) => (
                  <label
                    key={fill}
                    className={`${styles.bgOption} ${backgroundFill === fill ? styles.bgOptionActive : ''}`}
                  >
                    <input
                      type="radio"
                      name="ni-bg"
                      value={fill}
                      checked={backgroundFill === fill}
                      onChange={() => setBg(fill)}
                      className={styles.srOnly}
                    />
                    <span
                      className={`${styles.bgSwatch} ${fill === 'transparent' ? styles.bgSwatchTransparent : ''}`}
                      style={fill === 'white' ? { background: '#fff' } : fill === 'black' ? { background: '#000' } : undefined}
                    />
                    {fill.charAt(0).toUpperCase() + fill.slice(1)}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ── Footer ───────────────────────────────────────────────── */}
        <div className={styles.footer}>
          <DialogButton onClick={onCancel}>Cancel</DialogButton>
          <DialogButton onClick={handleConfirm} primary>Create</DialogButton>
        </div>

    </ModalDialog>
  )
}
