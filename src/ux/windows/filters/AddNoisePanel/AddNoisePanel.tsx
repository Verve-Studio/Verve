import React from 'react'
import { useAppContext } from '@/core/store/AppContext'
import type { AddNoiseAdjustmentLayer } from '@/types'
import { ParentConnectorIcon } from '@/ux/windows/ToolWindowIcons'
import styles from '../filterPanel.module.scss'

interface Props { layer: AddNoiseAdjustmentLayer; parentLayerName: string }

export function AddNoisePanel({ layer, parentLayerName }: Props): React.JSX.Element {
  const { dispatch } = useAppContext()
  const { amount, distribution, monochromatic, seed } = layer.params
  const up = (partial: Partial<typeof layer.params>) =>
    dispatch({ type: 'UPDATE_ADJUSTMENT_LAYER', payload: { ...layer, params: { ...layer.params, ...partial } } })

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Amount</span>
        <div className={styles.trackWrap}>
          <input type="range" className={styles.track} min={1} max={400} step={1}
            value={amount} style={{ '--pct': String((amount - 1) / 399) } as React.CSSProperties}
            onChange={(e) => up({ amount: Number(e.target.value) })} />
        </div>
        <input type="number" className={styles.numInput} min={1} max={400} step={1} value={amount}
          onChange={(e) => { const v = e.target.valueAsNumber; if (!isNaN(v)) up({ amount: Math.min(400, Math.max(1, Math.round(v))) }) }} />
        <span className={styles.unitSpacer} />
      </div>
      <div className={styles.sep} />
      <div className={styles.row}>
        <span className={styles.label}>Distribution</span>
        <div className={styles.segmented}>
          {(['uniform', 'gaussian'] as const).map((d) => (
            <button key={d} className={`${styles.segBtn} ${distribution === d ? styles.segBtnActive : ''}`} onClick={() => up({ distribution: d })}>
              {d === 'uniform' ? 'Uniform' : 'Gaussian'}
            </button>
          ))}
        </div>
        <span className={styles.unitSpacer} />
      </div>
      <div className={styles.toggleRow}>
        <span className={styles.label}>Monochromatic</span>
        <input type="checkbox" className={styles.checkbox} checked={monochromatic}
          onChange={(e) => up({ monochromatic: e.target.checked })} />
        <span className={styles.unitSpacer} />
      </div>
      <div className={styles.sep} />
      <div className={styles.seedRow}>
        <span className={styles.label}>Seed</span>
        <span className={styles.seedValue}>{seed}</span>
        <button className={styles.seedBtn} onClick={() => up({ seed: (Math.random() * 0xFFFFFFFF) >>> 0 })}>Randomize</button>
      </div>
      <div className={styles.footer}>
        <span className={styles.footerInfo}><ParentConnectorIcon />Adjusting <strong>{parentLayerName}</strong></span>
        <button className={styles.resetBtn} onClick={() => up({ amount: 25, distribution: 'gaussian', monochromatic: false })} title="Reset">Reset</button>
      </div>
    </div>
  )
}
