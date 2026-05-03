import React from 'react'
import { useAppContext } from '@/core/store/AppContext'
import type { BevelAdjustmentLayer } from '@/types'
import { ParentConnectorIcon } from '@/ux/windows/ToolWindowIcons'
import styles from './BevelOptions.module.scss'

interface BevelOptionsProps {
  layer:           BevelAdjustmentLayer
  parentLayerName: string
}

function pct(v: number, lo: number, hi: number): string {
  return String((v - lo) / (hi - lo))
}

export function BevelOptions({ layer, parentLayerName }: BevelOptionsProps): React.JSX.Element {
  const { dispatch } = useAppContext()
  const p = layer.params

  const update = (patch: Partial<typeof p>): void => {
    dispatch({ type: 'UPDATE_ADJUSTMENT_LAYER', payload: { ...layer, params: { ...p, ...patch } } })
  }

  return (
    <div className={styles.content}>

      {/* Width */}
      <div className={styles.row}>
        <span className={styles.label}>Width</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={1} max={50} step={1}
            value={p.width}
            style={{ '--pct': pct(p.width, 1, 50) } as React.CSSProperties}
            onChange={(e) => update({ width: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={1} max={50} step={1}
          value={p.width}
          onChange={(e) => {
            const v = e.target.valueAsNumber
            if (!isNaN(v)) update({ width: Math.min(50, Math.max(1, Math.round(v))) })
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>

      {/* Softness */}
      <div className={styles.row}>
        <span className={styles.label}>Softness</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0} max={50} step={1}
            value={p.softness}
            style={{ '--pct': pct(p.softness, 0, 50) } as React.CSSProperties}
            onChange={(e) => update({ softness: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0} max={50} step={1}
          value={p.softness}
          onChange={(e) => {
            const v = e.target.valueAsNumber
            if (!isNaN(v)) update({ softness: Math.min(50, Math.max(0, Math.round(v))) })
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>

      {/* Light Direction */}
      <div className={styles.row}>
        <span className={styles.label}>Light Dir</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0} max={360} step={1}
            value={p.angle}
            style={{ '--pct': pct(p.angle, 0, 360) } as React.CSSProperties}
            onChange={(e) => update({ angle: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0} max={360} step={1}
          value={p.angle}
          onChange={(e) => {
            const v = e.target.valueAsNumber
            if (!isNaN(v)) update({ angle: Math.min(360, Math.max(0, Math.round(v))) })
          }}
        />
        <span className={styles.unitLabel}>°</span>
      </div>

      {/* Strength */}
      <div className={styles.row}>
        <span className={styles.label}>Strength</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0} max={100} step={1}
            value={p.strength}
            style={{ '--pct': pct(p.strength, 0, 100) } as React.CSSProperties}
            onChange={(e) => update({ strength: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0} max={100} step={1}
          value={p.strength}
          onChange={(e) => {
            const v = e.target.valueAsNumber
            if (!isNaN(v)) update({ strength: Math.min(100, Math.max(0, v)) })
          }}
        />
        <span className={styles.unitLabel}>%</span>
      </div>

      <div className={styles.footer}>
        <div className={styles.footerInfo}>
          <ParentConnectorIcon />
          <strong>{parentLayerName}</strong>
        </div>
        <button
          className={styles.resetBtn}
          onClick={() => update({ width: 5, softness: 3, angle: 135, strength: 80 })}
        >
          Reset
        </button>
      </div>

    </div>
  )
}
