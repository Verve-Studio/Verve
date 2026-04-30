import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ModalDialog } from '../ModalDialog/ModalDialog'
import { DialogButton } from '../../widgets/DialogButton/DialogButton'
import { sortSwatchesByHue } from '@/utils/swatchSort'
import { generateColorWheel, generateNightColor, hslToRgba } from '@/utils/paletteGenerators'
import type { SchemeType } from '@/utils/paletteGenerators'
import { DEVICE_PALETTES, DEVICE_KEYS, DEVICE_LABELS } from '@/utils/devicePalettes'
import type { DevicePaletteKey } from '@/utils/devicePalettes'
import { quantize } from '@/wasm'
import type { RGBAColor } from '@/types'
import type { CanvasHandle } from '@/ux/main/Canvas/Canvas'
import styles from './GeneratePaletteDialog.module.scss'

// ─── Types ────────────────────────────────────────────────────────────────────

type Mode = 'color-wheel' | 'extract' | 'device' | 'night-color'

export interface GeneratePaletteDialogProps {
  open: boolean
  onClose: () => void
  canvasHandleRef: { readonly current: CanvasHandle | null }
  swatches: RGBAColor[]
  hasActiveDocument: boolean
  onApply: (palette: RGBAColor[]) => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sliderPct(value: number, min: number, max: number): string {
  return `${((value - min) / (max - min)) * 100}%`
}

function rgbaToHex(c: RGBAColor): string {
  return `#${[c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GeneratePaletteDialog({
  open,
  onClose,
  canvasHandleRef,
  swatches,
  hasActiveDocument,
  onApply,
}: GeneratePaletteDialogProps): React.JSX.Element | null {
  // ── Shared state ─────────────────────────────────────────────────
  const [mode, setMode] = useState<Mode>('color-wheel')

  // ── Color Wheel state ─────────────────────────────────────────────
  const [baseHue, setBaseHue]       = useState(200)
  const [scheme, setScheme]         = useState<SchemeType>('analogous')
  const [colorCount, setColorCount] = useState(8)
  const [saturation, setSaturation] = useState(0.65)
  const [lightness, setLightness]   = useState(0.52)

  // ── Extract state ─────────────────────────────────────────────────
  const [extractCount, setExtractCount]     = useState(32)
  const [extractPalette, setExtractPalette] = useState<RGBAColor[]>([])
  const [extractPending, setExtractPending] = useState(false)

  // ── Device state ──────────────────────────────────────────────────
  const [deviceKey, setDeviceKey] = useState<DevicePaletteKey>('cga')

  // ── Night Color state ─────────────────────────────────────────────
  const [nightSteps, setNightSteps] = useState(3)

  // ── Reset on open ─────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    setMode('color-wheel')
    setBaseHue(200)
    setScheme('analogous')
    setColorCount(8)
    setSaturation(0.65)
    setLightness(0.52)
    setExtractCount(32)
    setExtractPalette([])
    setExtractPending(false)
    setDeviceKey('cga')
    setNightSteps(3)
  }, [open])

  // ── Auto-switch disabled modes ────────────────────────────────────
  useEffect(() => {
    if (mode === 'extract' && !hasActiveDocument) setMode('color-wheel')
    if (mode === 'night-color' && swatches.length === 0) setMode('color-wheel')
  }, [mode, hasActiveDocument, swatches.length])

  // ── Synchronous preview ───────────────────────────────────────────
  const syncPreview = useMemo<RGBAColor[]>(() => {
    switch (mode) {
      case 'color-wheel':
        return generateColorWheel({ baseHue, scheme, count: colorCount, saturation, lightness })
      case 'device':
        return DEVICE_PALETTES[deviceKey]
      case 'night-color':
        return swatches.length > 0
          ? generateNightColor({ sourceSwatches: swatches, steps: nightSteps })
          : []
      default:
        return []
    }
  }, [mode, baseHue, scheme, colorCount, saturation, lightness, deviceKey, nightSteps, swatches])

  // ── Async extract preview (debounced) ─────────────────────────────
  const extractTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (mode !== 'extract' || !hasActiveDocument) return

    if (extractTimerRef.current) clearTimeout(extractTimerRef.current)
    extractTimerRef.current = setTimeout(() => {
      void (async () => {
        setExtractPending(true)
        try {
          const handle = canvasHandleRef.current
          if (!handle) return
          const result = await handle.rasterizeComposite('export')
          const { palette, count } = await quantize(result.data as Uint8Array, extractCount)
          const seen = new Set<number>()
          const colors: RGBAColor[] = []
          for (let i = 0; i < count; i++) {
            const r = palette[i * 4], g = palette[i * 4 + 1], b = palette[i * 4 + 2], a = palette[i * 4 + 3]
            const key = (r << 24) | (g << 16) | (b << 8) | a
            if (!seen.has(key)) {
              seen.add(key)
              colors.push({ r, g, b, a })
            }
          }
          setExtractPalette(colors)
        } finally {
          setExtractPending(false)
        }
      })()
    }, 150)

    return () => {
      if (extractTimerRef.current) clearTimeout(extractTimerRef.current)
    }
  }, [mode, extractCount, hasActiveDocument, canvasHandleRef])

  // ── Combined sorted preview ───────────────────────────────────────
  const preview = useMemo<RGBAColor[]>(() => {
    const raw = mode === 'extract' ? extractPalette : syncPreview
    return sortSwatchesByHue(raw).map(e => e.color)
  }, [mode, syncPreview, extractPalette])

  // ── Apply ─────────────────────────────────────────────────────────
  function handleApply(): void {
    const raw = mode === 'extract' ? extractPalette : syncPreview
    onApply(sortSwatchesByHue(raw).map(e => e.color))
    onClose()
  }

  // ── Night legend example swatches (static red example) ───────────
  const legendSource = { r: 201, g: 48, b: 48, a: 255 }
  const nightLegendSteps = useMemo(() => {
    return Array.from({ length: nightSteps }, (_, i) => {
      const f = (i + 1) / (nightSteps + 1)
      return hslToRgba(0, 0.62 * (1 - f * 0.45), 0.49 * (1 - f * 0.72))
    })
  }, [nightSteps])

  // ── Render ────────────────────────────────────────────────────────
  const extractDisabled = !hasActiveDocument
  const nightDisabled   = swatches.length === 0
  const applyDisabled   = mode === 'extract' && extractPalette.length === 0

  return (
    <ModalDialog open={open} title="Generate Palette" width={472} onClose={onClose}>

      {/* ── Tab strip ──────────────────────────────────────────────── */}
      <div className={styles.tabStrip} role="tablist">
        {(
          [
            { id: 'color-wheel' as Mode, label: 'Color Wheel',        disabled: false },
            { id: 'extract'    as Mode, label: 'Extract from Image',  disabled: extractDisabled },
            { id: 'device'     as Mode, label: 'Device Emulation',    disabled: false },
            { id: 'night-color'as Mode, label: 'Night Color',         disabled: nightDisabled },
          ] as { id: Mode; label: string; disabled: boolean }[]
        ).map(tab => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={mode === tab.id}
            aria-disabled={tab.disabled}
            className={[
              styles.tab,
              mode === tab.id ? styles.tabActive   : '',
              tab.disabled    ? styles.tabDisabled : '',
            ].join(' ')}
            onClick={() => { if (!tab.disabled) setMode(tab.id) }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Mode body ──────────────────────────────────────────────── */}
      <div className={styles.modeBody}>

        {/* ── Color Wheel ─────────────────────────────────────── */}
        {mode === 'color-wheel' && (
          <div className={styles.modePanel}>
            {/* Base Hue */}
            <div className={styles.sliderRow}>
              <span className={styles.sliderLabel}>Base Hue</span>
              <div
                className={styles.hueSwatch}
                style={{ background: `hsl(${baseHue}, ${Math.round(saturation * 100)}%, ${Math.round(lightness * 100)}%)` }}
              />
              <div className={styles.sliderTrack}>
                <input
                  type="range"
                  className={styles.hueSlider}
                  min={0}
                  max={360}
                  value={baseHue}
                  onChange={e => setBaseHue(Number(e.target.value))}
                />
              </div>
              <input
                type="number"
                className={styles.numInput}
                min={0}
                max={360}
                value={baseHue}
                onChange={e => setBaseHue(Math.max(0, Math.min(360, Number(e.target.value))))}
              />
              <span className={styles.unit}>°</span>
            </div>

            {/* Scheme */}
            <div className={styles.sliderRow}>
              <span className={styles.sliderLabel}>Scheme</span>
              <select
                className={styles.psSelect}
                value={scheme}
                onChange={e => setScheme(e.target.value as SchemeType)}
              >
                <option value="analogous">Analogous</option>
                <option value="complementary">Complementary</option>
                <option value="triadic">Triadic</option>
                <option value="tetradic">Tetradic</option>
                <option value="split-complementary">Split-Complementary</option>
              </select>
            </div>

            {/* Colors count */}
            <div className={styles.sliderRow}>
              <span className={styles.sliderLabel}>Colors</span>
              <div className={styles.sliderTrack}>
                <input
                  type="range"
                  className={styles.psSlider}
                  style={{ '--pct': sliderPct(colorCount, 2, 24) } as React.CSSProperties}
                  min={2}
                  max={24}
                  value={colorCount}
                  onChange={e => setColorCount(Number(e.target.value))}
                />
              </div>
              <input
                type="number"
                className={styles.numInput}
                min={2}
                max={24}
                value={colorCount}
                onChange={e => setColorCount(Math.max(2, Math.min(24, Number(e.target.value))))}
              />
            </div>

            {/* Saturation */}
            <div className={styles.sliderRow}>
              <span className={styles.sliderLabel}>Saturation</span>
              <div className={styles.sliderTrack}>
                <input
                  type="range"
                  className={styles.psSlider}
                  style={{ '--pct': sliderPct(saturation * 100, 0, 100) } as React.CSSProperties}
                  min={0}
                  max={100}
                  value={Math.round(saturation * 100)}
                  onChange={e => setSaturation(Number(e.target.value) / 100)}
                />
              </div>
              <input
                type="number"
                className={styles.numInput}
                min={0}
                max={100}
                value={Math.round(saturation * 100)}
                onChange={e => setSaturation(Math.max(0, Math.min(100, Number(e.target.value))) / 100)}
              />
              <span className={styles.unit}>%</span>
            </div>

            {/* Lightness */}
            <div className={styles.sliderRow}>
              <span className={styles.sliderLabel}>Lightness</span>
              <div className={styles.sliderTrack}>
                <input
                  type="range"
                  className={styles.psSlider}
                  style={{ '--pct': sliderPct(lightness * 100, 0, 100) } as React.CSSProperties}
                  min={0}
                  max={100}
                  value={Math.round(lightness * 100)}
                  onChange={e => setLightness(Number(e.target.value) / 100)}
                />
              </div>
              <input
                type="number"
                className={styles.numInput}
                min={0}
                max={100}
                value={Math.round(lightness * 100)}
                onChange={e => setLightness(Math.max(0, Math.min(100, Number(e.target.value))) / 100)}
              />
              <span className={styles.unit}>%</span>
            </div>
          </div>
        )}

        {/* ── Extract from Image ──────────────────────────────── */}
        {mode === 'extract' && (
          <div className={styles.modePanel}>
            {!hasActiveDocument && (
              <div className={styles.infoBanner}>
                <span className={styles.infoBannerIcon}>⚠</span>
                <span className={styles.infoBannerText}>
                  No document is currently open. Open an image to use Extract from Image.
                </span>
              </div>
            )}
            <div className={styles.sliderRow}>
              <span className={styles.sliderLabel}>Colors</span>
              <div className={styles.sliderTrack}>
                <input
                  type="range"
                  className={styles.psSlider}
                  style={{ '--pct': sliderPct(extractCount, 2, 256) } as React.CSSProperties}
                  min={2}
                  max={256}
                  value={extractCount}
                  disabled={!hasActiveDocument}
                  onChange={e => setExtractCount(Number(e.target.value))}
                />
              </div>
              <input
                type="number"
                className={styles.numInput}
                min={2}
                max={256}
                value={extractCount}
                disabled={!hasActiveDocument}
                onChange={e => setExtractCount(Math.max(2, Math.min(256, Number(e.target.value))))}
              />
            </div>
          </div>
        )}

        {/* ── Device Emulation ────────────────────────────────── */}
        {mode === 'device' && (
          <div className={styles.modePanel}>
            <div className={styles.deviceList} role="listbox" aria-label="Device palette">
              {DEVICE_KEYS.map(key => (
                <div
                  key={key}
                  role="option"
                  aria-selected={deviceKey === key}
                  className={[
                    styles.deviceRow,
                    deviceKey === key ? styles.deviceRowSelected : '',
                  ].join(' ')}
                  onClick={() => setDeviceKey(key)}
                >
                  <div className={styles.deviceRadio} />
                  <span className={styles.deviceName}>{DEVICE_LABELS[key]}</span>
                  <span className={styles.deviceCount}>
                    {DEVICE_PALETTES[key].length} colors
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Night Color ─────────────────────────────────────── */}
        {mode === 'night-color' && (
          <div className={styles.modePanel}>
            {nightDisabled ? (
              <div className={styles.infoBanner}>
                <span className={styles.infoBannerIcon}>⚠</span>
                <span className={styles.infoBannerText}>
                  Your swatch collection is empty. Add some colors before using Night Color.
                </span>
              </div>
            ) : (
              <>
                <div className={styles.sliderRow}>
                  <span className={styles.sliderLabel}>Night steps</span>
                  <div className={styles.sliderTrack}>
                    <input
                      type="range"
                      className={styles.psSlider}
                      style={{ '--pct': sliderPct(nightSteps, 2, 4) } as React.CSSProperties}
                      min={2}
                      max={4}
                      value={nightSteps}
                      onChange={e => setNightSteps(Number(e.target.value))}
                    />
                  </div>
                  <input
                    type="number"
                    className={styles.numInput}
                    style={{ width: 36 }}
                    min={2}
                    max={4}
                    value={nightSteps}
                    onChange={e => setNightSteps(Math.max(2, Math.min(4, Number(e.target.value))))}
                  />
                  <span className={styles.unit} style={{ width: 56, color: 'var(--color-text-muted)' }}>per color</span>
                </div>

                <div className={styles.nightInfo}>
                  <span className={styles.nightInfoText}>
                    Based on{' '}
                    <span className={styles.nightInfoHl}>{swatches.length}</span>
                    {' '}existing swatches
                    &thinsp;·&thinsp;
                    <span className={styles.nightInfoHl}>
                      {swatches.length * (1 + nightSteps)}
                    </span>
                    {' '}colors total
                  </span>
                </div>

                <div className={styles.nightLegend}>
                  <div className={styles.legendItem}>
                    <div
                      className={styles.legendSwatch}
                      style={{ background: rgbaToHex(legendSource) }}
                    />
                    <span className={styles.legendLabel}>Source</span>
                  </div>
                  <span className={styles.legendSep}>→</span>
                  {nightLegendSteps.map((c, i) => (
                    <div key={i} className={styles.legendItem}>
                      <div
                        className={styles.legendSwatch}
                        style={{ background: rgbaToHex(c) }}
                      />
                      <span className={styles.legendLabel}>Step {i + 1}</span>
                    </div>
                  ))}
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: 9, color: '#444' }}>example: red swatch</span>
                </div>
              </>
            )}
          </div>
        )}

      </div>{/* /modeBody */}

      {/* ── Preview section ────────────────────────────────────────── */}
      <div className={styles.previewSection}>
        <div className={styles.previewHeader}>
          <span className={styles.previewTitle}>Preview</span>
          <span className={styles.previewCount}>
            {mode === 'extract' && extractPending
              ? 'Analyzing…'
              : `${preview.length} color${preview.length !== 1 ? 's' : ''}`}
          </span>
        </div>

        {mode === 'extract' && extractPending ? (
          <div className={styles.extractLoading}>Analyzing image…</div>
        ) : preview.length === 0 ? (
          <div className={styles.previewGrid}>
            <span className={styles.previewEmpty}>No colors to preview.</span>
          </div>
        ) : (
          <div className={styles.previewGrid} role="list" aria-label="Color preview">
            {preview.map((c, i) => {
              const hex = rgbaToHex(c)
              return (
                <div
                  key={`${hex}-${i}`}
                  role="listitem"
                  className={styles.colorChip}
                  style={{ background: hex }}
                  title={hex}
                  aria-label={hex}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <div className={styles.footer}>
        <DialogButton onClick={onClose}>Cancel</DialogButton>
        <DialogButton primary disabled={applyDisabled} onClick={handleApply}>Apply</DialogButton>
      </div>

    </ModalDialog>
  )
}
