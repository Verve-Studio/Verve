import React, { useEffect, useRef, useState } from 'react'
import { useAppContext } from '@/core/store/AppContext'
import type { ReduceColorsAdjustmentLayer, RGBAColor } from '@/types'
import type { CanvasHandle } from '@/ux/main/Canvas/Canvas'
import { quantize } from '@/wasm'
import { ParentConnectorIcon } from '@/ux/windows/ToolWindowIcons'
import styles from './ReduceColorsPanel.module.scss'

// ─── Props ────────────────────────────────────────────────────────────────────

interface ReduceColorsPanelProps {
  layer: ReduceColorsAdjustmentLayer
  parentLayerName: string
  canvasHandleRef?: { readonly current: CanvasHandle | null }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ReduceColorsPanel({ layer, parentLayerName, canvasHandleRef }: ReduceColorsPanelProps): React.JSX.Element {
  const { state, dispatch } = useAppContext()
  const { mode, colorCount } = layer.params
  const [isQuantizing, setIsQuantizing] = useState(false)
  const genRef = useRef(0)

  const pct = (v: number, min: number, max: number): string => String((v - min) / (max - min))

  useEffect(() => {
    if (mode !== 'reduce') return
    const gen = ++genRef.current

    const run = async (): Promise<void> => {
      const native = await canvasHandleRef?.current?.readAdjustmentInputPixels(layer.id)
      if (!native || gen !== genRef.current) return
      // quantize WASM expects 8-bit RGBA; convert HDR float pixels (clamped) at the boundary.
      const pixels: Uint8Array = native instanceof Float32Array
        ? (() => {
            const out = new Uint8Array(native.length)
            for (let i = 0; i < native.length; i++) {
              const v = native[i]
              out[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)
            }
            return out
          })()
        : native

      setIsQuantizing(true)
      try {
        const result = await quantize(pixels, colorCount)
        if (gen !== genRef.current) return
        const newPalette: RGBAColor[] = []
        for (let i = 0; i < result.count; i++) {
          newPalette.push({
            r: result.palette[i * 4 + 0],
            g: result.palette[i * 4 + 1],
            b: result.palette[i * 4 + 2],
            a: result.palette[i * 4 + 3],
          })
        }
        dispatch({
          type: 'UPDATE_ADJUSTMENT_LAYER',
          payload: { ...layer, params: { ...layer.params, colorCount, derivedPalette: newPalette } },
        })
      } finally {
        if (gen === genRef.current) setIsQuantizing(false)
      }
    }

    run()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.id, mode, colorCount])

  const swatchCount = state.swatches.length
  const paletteValid = swatchCount >= 2

  return (
    <div className={styles.content}>
      <div className={styles.modeRow}>
        <div className={styles.segmented}>
          <button
            className={`${styles.segBtn} ${mode === 'reduce' ? styles.segBtnActive : ''}`}
            onClick={() => dispatch({
              type: 'UPDATE_ADJUSTMENT_LAYER',
              payload: { ...layer, params: { ...layer.params, mode: 'reduce' } },
            })}
          >
            Reduce to N
          </button>
          <button
            className={`${styles.segBtn} ${mode === 'palette' ? styles.segBtnActive : ''}`}
            onClick={() => dispatch({
              type: 'UPDATE_ADJUSTMENT_LAYER',
              payload: { ...layer, params: { ...layer.params, mode: 'palette' } },
            })}
          >
            Map to Palette
          </button>
        </div>
      </div>

      {mode === 'reduce' && (
        <div className={styles.row}>
          <span className={styles.label}>Colors</span>
          <div className={styles.trackWrap}>
            <input
              type="range"
              className={styles.track}
              min={2} max={256} step={1}
              value={colorCount}
              style={{ '--pct': pct(colorCount, 2, 256) } as React.CSSProperties}
              onChange={(e) => dispatch({
                type: 'UPDATE_ADJUSTMENT_LAYER',
                payload: { ...layer, params: { ...layer.params, colorCount: Number(e.target.value), derivedPalette: null } },
              })}
            />
          </div>
          <input
            type="number"
            className={styles.numInput}
            min={2} max={256} step={1}
            value={colorCount}
            onChange={(e) => {
              const v = e.target.valueAsNumber
              if (!isNaN(v)) dispatch({
                type: 'UPDATE_ADJUSTMENT_LAYER',
                payload: { ...layer, params: { ...layer.params, colorCount: Math.min(256, Math.max(2, Math.round(v))), derivedPalette: null } },
              })
            }}
          />
        </div>
      )}

      {mode === 'reduce' && isQuantizing && (
        <p className={styles.computing}>Computing…</p>
      )}

      {mode === 'palette' && (
        <div className={styles.paletteInfo}>
          {paletteValid ? (
            <p className={styles.paletteCount}>{swatchCount} color{swatchCount !== 1 ? 's' : ''} in palette</p>
          ) : (
            <div className={styles.warning}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
                <path d="M6 1.5L10.5 9.5H1.5L6 1.5Z" />
                <line x1="6" y1="5" x2="6" y2="7.2" />
                <circle cx="6" cy="8.5" r="0.6" fill="currentColor" stroke="none" />
              </svg>
              <span>Palette must have at least 2 colors</span>
            </div>
          )}
        </div>
      )}

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() => dispatch({
            type: 'UPDATE_ADJUSTMENT_LAYER',
            payload: { ...layer, params: { mode: 'reduce', colorCount: 16, derivedPalette: null } },
          })}
          title="Reset to defaults"
        >
          Reset
        </button>
      </div>
    </div>
  )
}
