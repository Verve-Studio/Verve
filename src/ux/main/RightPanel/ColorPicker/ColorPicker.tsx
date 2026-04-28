import React, { useState } from 'react'
import type { RGBAColor } from '@/types'
import { useAppContext } from '@/core/store/AppContext'
import { EmbedColorPicker, hexToRgb, toHex } from '@/ux/widgets/EmbedColorPicker/EmbedColorPicker'
import styles from './ColorPicker.module.scss'

// ─── Component ────────────────────────────────────────────────────────────────

export function ColorPicker(): React.JSX.Element {
  const { state, dispatch } = useAppContext()
  const primaryColor = state.primaryColor ?? { r: 0, g: 0, b: 0, a: 255 }
  const secondaryColor = state.secondaryColor ?? { r: 255, g: 255, b: 255, a: 255 }
  const activeLayerData = state.layers.find(l => l.id === state.activeLayerId)
  const grayscaleOnly = !!(activeLayerData && 'type' in activeLayerData && activeLayerData.type === 'mask')

  const onPrimaryChange = (c: RGBAColor): void => { dispatch({ type: 'SET_PRIMARY_COLOR', payload: c }) }
  const onSecondaryChange = (c: RGBAColor): void => { dispatch({ type: 'SET_SECONDARY_COLOR', payload: c }) }
  const [active, setActive] = useState<'fg' | 'bg'>('fg')

  const fgHex = toHex(primaryColor.r, primaryColor.g, primaryColor.b)
  const bgHex = toHex(secondaryColor.r, secondaryColor.g, secondaryColor.b)
  const activeHex = active === 'fg' ? fgHex : bgHex

  const handleChange = (hex: string): void => {
    const [r, g, b] = hexToRgb(hex)
    const color: RGBAColor = { r, g, b, a: 255 }
    if (active === 'fg') onPrimaryChange(color)
    else onSecondaryChange(color)
  }

  return (
    <div className={styles.picker}>
      {/* FG / BG swatches */}
      <div className={styles.swatchRow}>
        <div className={styles.swatchStack}>
          {!grayscaleOnly && (
            <button
              className={`${styles.swatch} ${styles.swatchBack} ${active === 'bg' ? styles.swatchSel : ''}`}
              style={{ background: bgHex }}
              onClick={() => setActive('bg')}
              aria-label="Background color"
              title="Background (click to edit)"
            />
          )}
          <button
            className={`${styles.swatch} ${styles.swatchFront} ${active === 'fg' ? styles.swatchSel : ''}`}
            style={{ background: fgHex }}
            onClick={() => { setActive('fg') }}
            aria-label="Foreground color"
            title="Foreground (click to edit)"
          />
        </div>
        <span className={styles.swatchLabel}>{active === 'fg' ? 'Foreground' : 'Background'}</span>
      </div>

      <EmbedColorPicker
        value={activeHex}
        onChange={handleChange}
        grayscaleOnly={grayscaleOnly}
        isHdrMode={state.pixelFormat === 'rgba32f'}
        hdrIntensity={state.hdrIntensity}
        onHdrIntensityChange={(v) => {
          dispatch({ type: 'SET_HDR_INTENSITY', payload: v })
          dispatch({ type: 'SET_EYEDROPPER_HDR_OVERFLOW', payload: false })
        }}
        eyedropperHdrOverflow={state.eyedropperHdrOverflow}
      />
    </div>
  )
}
