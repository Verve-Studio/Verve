import React, { useState } from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { ColorBalanceEffectLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./ColorBalancePanel.module.scss";

// ─── Props ────────────────────────────────────────────────────────────────────

interface ColorBalancePanelProps {
  layer: ColorBalanceEffectLayer;
  parentLayerName: string;
}

type ToneRange = "shadows" | "midtones" | "highlights";

// ─── Component ────────────────────────────────────────────────────────────────

export function ColorBalancePanel({
  layer,
  parentLayerName,
}: ColorBalancePanelProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const [activeRange, setActiveRange] = useState<ToneRange>("midtones");

  const rangeParams = layer.params[activeRange];
  const { cr, mg, yb } = rangeParams;

  const pct = (v: number, min: number, max: number): string =>
    String((v - min) / (max - min));

  const updateCR = (value: number): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: {
        ...layer,
        params: {
          ...layer.params,
          [activeRange]: { ...rangeParams, cr: value },
        },
      },
    });
  };

  const updateMG = (value: number): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: {
        ...layer,
        params: {
          ...layer.params,
          [activeRange]: { ...rangeParams, mg: value },
        },
      },
    });
  };

  const updateYB = (value: number): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: {
        ...layer,
        params: {
          ...layer.params,
          [activeRange]: { ...rangeParams, yb: value },
        },
      },
    });
  };

  return (
    <div className={styles.content}>
      <div className={styles.tabs}>
        {(["shadows", "midtones", "highlights"] as const).map((range) => (
          <button
            key={range}
            className={`${styles.tab}${activeRange === range ? ` ${styles.tabActive}` : ""}`}
            onClick={() => setActiveRange(range)}
          >
            {range.charAt(0).toUpperCase() + range.slice(1)}
          </button>
        ))}
      </div>

      <div className={styles.row}>
        <span className={styles.leftLabel}>Cyan</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={`${styles.track} ${styles.trackCR}`}
            min={-100}
            max={100}
            step={1}
            value={cr}
            style={{ "--pct": pct(cr, -100, 100) } as React.CSSProperties}
            onChange={(e) => updateCR(Number(e.target.value))}
          />
          <div className={styles.zeroTick} />
        </div>
        <span className={styles.rightLabel}>Red</span>
        <input
          type="number"
          className={styles.numInput}
          min={-100}
          max={100}
          step={1}
          value={cr}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              updateCR(Math.min(100, Math.max(-100, Math.round(v))));
          }}
        />
      </div>

      <div className={styles.sep} />

      <div className={styles.row}>
        <span className={styles.leftLabel}>Magenta</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={`${styles.track} ${styles.trackMG}`}
            min={-100}
            max={100}
            step={1}
            value={mg}
            style={{ "--pct": pct(mg, -100, 100) } as React.CSSProperties}
            onChange={(e) => updateMG(Number(e.target.value))}
          />
          <div className={styles.zeroTick} />
        </div>
        <span className={styles.rightLabel}>Green</span>
        <input
          type="number"
          className={styles.numInput}
          min={-100}
          max={100}
          step={1}
          value={mg}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              updateMG(Math.min(100, Math.max(-100, Math.round(v))));
          }}
        />
      </div>

      <div className={styles.sep} />

      <div className={styles.row}>
        <span className={styles.leftLabel}>Yellow</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={`${styles.track} ${styles.trackYB}`}
            min={-100}
            max={100}
            step={1}
            value={yb}
            style={{ "--pct": pct(yb, -100, 100) } as React.CSSProperties}
            onChange={(e) => updateYB(Number(e.target.value))}
          />
          <div className={styles.zeroTick} />
        </div>
        <span className={styles.rightLabel}>Blue</span>
        <input
          type="number"
          className={styles.numInput}
          min={-100}
          max={100}
          step={1}
          value={yb}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              updateYB(Math.min(100, Math.max(-100, Math.round(v))));
          }}
        />
      </div>

      <div className={styles.checkRow}>
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={layer.params.preserveLuminosity}
            onChange={(e) =>
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    preserveLuminosity: e.target.checked,
                  },
                },
              })
            }
          />
          Preserve Luminosity
        </label>
      </div>

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            dispatch({
              type: "UPDATE_ADJUSTMENT_LAYER",
              payload: {
                ...layer,
                params: {
                  ...layer.params,
                  [activeRange]: { cr: 0, mg: 0, yb: 0 },
                },
              },
            })
          }
          title="Reset current range to defaults"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
