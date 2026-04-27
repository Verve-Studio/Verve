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

// ─── Presets ──────────────────────────────────────────────────────────────────

interface Preset {
  label: string
  sub: string
  width: number
  height: number
}

const PRESETS: Preset[] = [
  { label: '16 × 16',    sub: 'Pixel art',   width: 16,   height: 16   },
  { label: '32 × 32',    sub: 'Pixel art',   width: 32,   height: 32   },
  { label: '64 × 64',    sub: 'Pixel art',   width: 64,   height: 64   },
  { label: '128 × 128',  sub: 'Pixel art',   width: 128,  height: 128  },
  { label: '256 × 256',  sub: 'Pixel art',   width: 256,  height: 256  },
  { label: '512 × 512',  sub: 'Default',     width: 512,  height: 512  },
  { label: '1024 × 1024',sub: 'Large',       width: 1024, height: 1024 },
  { label: '1920 × 1080',sub: 'HD',          width: 1920, height: 1080 },
  { label: '3840 × 2160',sub: '4K',          width: 3840, height: 2160 },
]

// ─── Document icon ────────────────────────────────────────────────────────────

function DocIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 32 38" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M4 3 H20 L28 11 V35 A2 2 0 0 1 26 37 H6 A2 2 0 0 1 4 35 Z"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
      />
      <path d="M20 3 V11 H28" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
    </svg>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function NewImageDialog({ open, onConfirm, onCancel }: NewImageDialogProps): React.JSX.Element | null {
  const [width, setWidth]               = useState(512)
  const [height, setHeight]             = useState(512)
  const [resolution, setResolution]     = useState(72)
  const [backgroundFill, setBg]         = useState<BackgroundFill>('white')
  const [selectedPreset, setPreset]     = useState('512 × 512')
  const [pixelFormat, setPixelFormat]   = useState<PixelFormat>('rgba8')

  // Reset to default 512×512 each time dialog opens
  useEffect(() => {
    if (open) {
      setWidth(512); setHeight(512); setResolution(72)
      setBg('white'); setPreset('512 × 512'); setPixelFormat('rgba8')
    }
  }, [open])

  const handlePreset = useCallback((p: Preset): void => {
    setWidth(p.width)
    setHeight(p.height)
    setPreset(p.label)
  }, [])

  const handleWidthChange = useCallback((v: number): void => {
    setWidth(v)
    setPreset('')
  }, [])

  const handleHeightChange = useCallback((v: number): void => {
    setHeight(v)
    setPreset('')
  }, [])

  const handlePortrait = useCallback((): void => {
    if (width > height) { setWidth(height); setHeight(width); setPreset('') }
  }, [width, height])

  const handleLandscape = useCallback((): void => {
    if (height > width) { setWidth(height); setHeight(width); setPreset('') }
  }, [width, height])

  const handleConfirm = useCallback((): void => {
    const w = Math.max(1, Math.min(8192, Math.round(width  || 1)))
    const h = Math.max(1, Math.min(8192, Math.round(height || 1)))
    onConfirm({ width: w, height: h, backgroundFill, pixelFormat })
  }, [width, height, backgroundFill, pixelFormat, onConfirm])

  const isPortrait = width <= height

  // Enter = confirm (Escape handled by ModalDialog)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') { e.stopPropagation(); handleConfirm() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, handleConfirm])

  // Memoised size string shown in details header
  const sizeLabel = useMemo(
    () => `${width} × ${height} px`,
    [width, height]
  )

  return (
    <ModalDialog open={open} title="New Document" width={560} onClose={onCancel}>

        {/* ── Body ─────────────────────────────────────────────────── */}
        <div className={styles.body}>

          {/* Left: preset grid */}
          <div className={styles.presetsPanel}>
            <p className={styles.sectionTitle}>PRESETS</p>
            <div className={styles.presetsGrid}>
              {PRESETS.map((p) => (
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
          </div>

          <div className={styles.divider} />

          {/* Right: detail form */}
          <div className={styles.detailsPanel}>
            <p className={styles.sectionTitle}>DOCUMENT DETAILS</p>
            <p className={styles.sizePreview}>{sizeLabel}</p>

            {/* Width */}
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel} htmlFor="ni-width">Width</label>
              <div className={styles.inputGroup}>
                <input
                  id="ni-width"
                  type="number"
                  className={styles.numInput}
                  value={width}
                  min={1}
                  max={8192}
                  onChange={(e) => { const v = e.target.valueAsNumber; if (!isNaN(v)) handleWidthChange(v) }}
                />
                <span className={styles.unit}>px</span>
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
                  value={height}
                  min={1}
                  max={8192}
                  onChange={(e) => { const v = e.target.valueAsNumber; if (!isNaN(v)) handleHeightChange(v) }}
                />
                <span className={styles.unit}>px</span>
              </div>
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
                  value={resolution}
                  min={1}
                  max={1200}
                  onChange={(e) => { const v = e.target.valueAsNumber; if (!isNaN(v)) setResolution(v) }}
                />
                <span className={styles.unit}>Pixels/Inch</span>
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
                <option value="rgba8">RGB Color / 8 bit</option>
                <option value="rgba32f">RGB Color / 32 bit float</option>
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
