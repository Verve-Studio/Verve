import React, { useState } from 'react'
import type { RGBAColor } from '@/types'
import { useAppContext } from '@/core/store/AppContext'
import { EmbedColorPicker, toHex } from '@/ux/widgets/EmbedColorPicker/EmbedColorPicker'
import styles from './ColorPicker.module.scss'

// ─── Component ────────────────────────────────────────────────────────────────

export function ColorPicker(): React.JSX.Element {
  const { state, dispatch } = useAppContext()
  const primaryColor = state.primaryColor ?? { r: 0, g: 0, b: 0, a: 1 }
  const secondaryColor = state.secondaryColor ?? { r: 1, g: 1, b: 1, a: 1 }
  const activeLayerData = state.layers.find(l => l.id === state.activeLayerId)
  const grayscaleOnly = !!(activeLayerData && 'type' in activeLayerData && activeLayerData.type === 'mask')

  const onPrimaryChange = (c: RGBAColor): void => { dispatch({ type: 'SET_PRIMARY_COLOR', payload: c }) }
  const onSecondaryChange = (c: RGBAColor): void => { dispatch({ type: 'SET_SECONDARY_COLOR', payload: c }) }
  const [active, setActive] = useState<'fg' | 'bg'>('fg')

  // Convert float [0,1] to CSS hex for swatch display
  const fgHex = toHex(Math.round(Math.min(primaryColor.r, 1) * 255), Math.round(Math.min(primaryColor.g, 1) * 255), Math.round(Math.min(primaryColor.b, 1) * 255))
  const bgHex = toHex(Math.round(Math.min(secondaryColor.r, 1) * 255), Math.round(Math.min(secondaryColor.g, 1) * 255), Math.round(Math.min(secondaryColor.b, 1) * 255))

  const activeColor = active === 'fg' ? primaryColor : secondaryColor

  const handleChange = (color: RGBAColor): void => {
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
        value={activeColor}
        onChange={handleChange}
        grayscaleOnly={grayscaleOnly}
        isHdrMode={state.pixelFormat === 'rgba32f'}
      />
    </div>
  )
}
