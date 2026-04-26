import React from 'react'
import { useAppContext } from '@/core/store/AppContext'
import type { CloudsAdjustmentLayer } from '@/types'
import { ParentConnectorIcon } from '@/ux/windows/ToolWindowIcons'
import styles from '../filterPanel.module.scss'

interface Props { layer: CloudsAdjustmentLayer; parentLayerName: string }

export function CloudsPanel({ layer, parentLayerName }: Props): React.JSX.Element {
  const { dispatch } = useAppContext()
  const { scale, opacity, colorMode, fgR, fgG, fgB, bgR, bgG, bgB, seed } = layer.params
  const up = (partial: Partial<typeof layer.params>) =>
    dispatch({ type: 'UPDATE_ADJUSTMENT_LAYER', payload: { ...layer, params: { ...layer.params, ...partial } } })

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Scale</span>
        <div className={styles.trackWrap}>
          <input type="range" className={styles.track} min={1} max={1000} step={1}
            value={scale} style={{ '--pct': String((scale - 1) / 999) } as React.CSSProperties}
            onChange={(e) => up({ scale: Number(e.target.value) })} />
        </div>
        <input type="number" className={styles.numInput} min={1} max={1000} step={1} value={scale}
          onChange={(e) => { const v = e.target.valueAsNumber; if (!isNaN(v)) up({ scale: Math.min(1000, Math.max(1, Math.round(v))) }) }} />
        <span className={styles.unitSpacer} />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Opacity</span>
        <div className={styles.trackWrap}>
          <input type="range" className={styles.track} min={0} max={100} step={1}
            value={opacity} style={{ '--pct': String(opacity / 100) } as React.CSSProperties}
            onChange={(e) => up({ opacity: Number(e.target.value) })} />
        </div>
        <input type="number" className={styles.numInput} min={0} max={100} step={1} value={opacity}
          onChange={(e) => { const v = e.target.valueAsNumber; if (!isNaN(v)) up({ opacity: Math.min(100, Math.max(0, Math.round(v))) }) }} />
        <span className={styles.unitLabel}>%</span>
      </div>
      <div className={styles.sep} />
      <div className={styles.row}>
        <span className={styles.label}>Color Mode</span>
        <div className={styles.segmented}>
          {(['grayscale', 'color'] as const).map((m) => (
            <button key={m} className={`${styles.segBtn} ${colorMode === m ? styles.segBtnActive : ''}`} onClick={() => up({ colorMode: m })}>
              {m === 'grayscale' ? 'Grayscale' : 'Color'}
            </button>
          ))}
        </div>
        <span className={styles.unitSpacer} />
      </div>
      {colorMode === 'color' && (
        <>
          <div className={styles.row}>
            <span className={styles.label}>Foreground</span>
            <div className={styles.colorSwatch} style={{ backgroundColor: `rgb(${fgR},${fgG},${fgB})` }} title={`rgb(${fgR}, ${fgG}, ${fgB})`} />
            <span className={styles.unitSpacer} />
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Background</span>
            <div className={styles.colorSwatch} style={{ backgroundColor: `rgb(${bgR},${bgG},${bgB})` }} title={`rgb(${bgR}, ${bgG}, ${bgB})`} />
            <span className={styles.unitSpacer} />
          </div>
        </>
      )}
      <div className={styles.sep} />
      <div className={styles.seedRow}>
        <span className={styles.label}>Seed</span>
        <span className={styles.seedValue}>{seed}</span>
        <button className={styles.seedBtn} onClick={() => up({ seed: (Math.random() * 0xFFFFFFFF) >>> 0 })}>Randomize</button>
      </div>
      <div className={styles.footer}>
        <span className={styles.footerInfo}><ParentConnectorIcon />Adjusting <strong>{parentLayerName}</strong></span>
        <button className={styles.resetBtn} onClick={() => up({ scale: 50, opacity: 100, colorMode: 'grayscale' })} title="Reset">Reset</button>
      </div>
    </div>
  )
}
