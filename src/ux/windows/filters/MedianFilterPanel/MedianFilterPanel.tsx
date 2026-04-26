import React from 'react'
import { useAppContext } from '@/core/store/AppContext'
import type { MedianFilterAdjustmentLayer } from '@/types'
import { ParentConnectorIcon } from '@/ux/windows/ToolWindowIcons'
import styles from '../filterPanel.module.scss'

interface Props { layer: MedianFilterAdjustmentLayer; parentLayerName: string }

export function MedianFilterPanel({ layer, parentLayerName }: Props): React.JSX.Element {
  const { dispatch } = useAppContext()
  const { radius } = layer.params
  const up = (r: number) =>
    dispatch({ type: 'UPDATE_ADJUSTMENT_LAYER', payload: { ...layer, params: { ...layer.params, radius: r } } })

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Radius</span>
        <div className={styles.trackWrap}>
          <input type="range" className={styles.track} min={1} max={10} step={1}
            value={radius} style={{ '--pct': String((radius - 1) / 9) } as React.CSSProperties}
            onChange={(e) => up(Number(e.target.value))} />
        </div>
        <input type="number" className={styles.numInput} min={1} max={10} step={1} value={radius}
          onChange={(e) => { const v = e.target.valueAsNumber; if (!isNaN(v)) up(Math.min(10, Math.max(1, Math.round(v)))) }} />
        <span className={styles.unitLabel}>px</span>
      </div>
      <div className={styles.footer}>
        <span className={styles.footerInfo}><ParentConnectorIcon />Adjusting <strong>{parentLayerName}</strong></span>
        <button className={styles.resetBtn} onClick={() => up(1)} title="Reset">Reset</button>
      </div>
    </div>
  )
}
