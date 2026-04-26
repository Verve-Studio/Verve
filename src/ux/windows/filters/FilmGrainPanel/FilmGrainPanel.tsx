import React from 'react'
import { useAppContext } from '@/core/store/AppContext'
import type { FilmGrainAdjustmentLayer } from '@/types'
import { ParentConnectorIcon } from '@/ux/windows/ToolWindowIcons'
import styles from '../filterPanel.module.scss'

interface Props { layer: FilmGrainAdjustmentLayer; parentLayerName: string }

export function FilmGrainPanel({ layer, parentLayerName }: Props): React.JSX.Element {
  const { dispatch } = useAppContext()
  const { grainSize, intensity, roughness, seed } = layer.params
  const up = (partial: Partial<typeof layer.params>) =>
    dispatch({ type: 'UPDATE_ADJUSTMENT_LAYER', payload: { ...layer, params: { ...layer.params, ...partial } } })

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Grain Size</span>
        <div className={styles.trackWrap}>
          <input type="range" className={styles.track} min={1} max={100} step={1}
            value={grainSize} style={{ '--pct': String((grainSize - 1) / 99) } as React.CSSProperties}
            onChange={(e) => up({ grainSize: Number(e.target.value) })} />
        </div>
        <input type="number" className={styles.numInput} min={1} max={100} step={1} value={grainSize}
          onChange={(e) => { const v = e.target.valueAsNumber; if (!isNaN(v)) up({ grainSize: Math.min(100, Math.max(1, Math.round(v))) }) }} />
        <span className={styles.unitSpacer} />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Intensity</span>
        <div className={styles.trackWrap}>
          <input type="range" className={styles.track} min={1} max={200} step={1}
            value={intensity} style={{ '--pct': String((intensity - 1) / 199) } as React.CSSProperties}
            onChange={(e) => up({ intensity: Number(e.target.value) })} />
        </div>
        <input type="number" className={styles.numInput} min={1} max={200} step={1} value={intensity}
          onChange={(e) => { const v = e.target.valueAsNumber; if (!isNaN(v)) up({ intensity: Math.min(200, Math.max(1, Math.round(v))) }) }} />
        <span className={styles.unitSpacer} />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Roughness</span>
        <div className={styles.trackWrap}>
          <input type="range" className={styles.track} min={0} max={100} step={1}
            value={roughness} style={{ '--pct': String(roughness / 100) } as React.CSSProperties}
            onChange={(e) => up({ roughness: Number(e.target.value) })} />
        </div>
        <input type="number" className={styles.numInput} min={0} max={100} step={1} value={roughness}
          onChange={(e) => { const v = e.target.valueAsNumber; if (!isNaN(v)) up({ roughness: Math.min(100, Math.max(0, Math.round(v))) }) }} />
        <span className={styles.unitLabel}>%</span>
      </div>
      <div className={styles.sep} />
      <div className={styles.seedRow}>
        <span className={styles.label}>Seed</span>
        <span className={styles.seedValue}>{seed}</span>
        <button className={styles.seedBtn} onClick={() => up({ seed: (Math.random() * 0xFFFFFFFF) >>> 0 })}>Randomize</button>
      </div>
      <div className={styles.footer}>
        <span className={styles.footerInfo}><ParentConnectorIcon />Adjusting <strong>{parentLayerName}</strong></span>
        <button className={styles.resetBtn} onClick={() => up({ grainSize: 5, intensity: 35, roughness: 50 })} title="Reset">Reset</button>
      </div>
    </div>
  )
}
