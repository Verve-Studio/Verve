import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { SmartSharpenAdjustmentLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "../filterPanel.module.scss";

interface Props {
  layer: SmartSharpenAdjustmentLayer;
  parentLayerName: string;
}

export function SmartSharpenPanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { amount, radius, reduceNoise, remove } = layer.params;
  const up = (partial: Partial<typeof layer.params>) =>
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...partial } },
    });

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Amount</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={1}
            max={500}
            step={1}
            value={amount}
            style={
              { "--pct": String((amount - 1) / 499) } as React.CSSProperties
            }
            onChange={(e) => up({ amount: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={1}
          max={500}
          step={1}
          value={amount}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ amount: Math.min(500, Math.max(1, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>%</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Radius</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={1}
            max={64}
            step={1}
            value={radius}
            style={
              { "--pct": String((radius - 1) / 63) } as React.CSSProperties
            }
            onChange={(e) => up({ radius: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={1}
          max={64}
          step={1}
          value={radius}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ radius: Math.min(64, Math.max(1, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Reduce Noise</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={100}
            step={1}
            value={reduceNoise}
            style={
              { "--pct": String(reduceNoise / 100) } as React.CSSProperties
            }
            onChange={(e) => up({ reduceNoise: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={reduceNoise}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ reduceNoise: Math.min(100, Math.max(0, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>%</span>
      </div>
      <div className={styles.sep} />
      <div className={styles.row}>
        <span className={styles.label}>Remove</span>
        <div className={styles.segmented}>
          {(["gaussian", "lens-blur"] as const).map((r) => (
            <button
              key={r}
              className={`${styles.segBtn} ${remove === r ? styles.segBtnActive : ""}`}
              onClick={() => up({ remove: r })}
            >
              {r === "gaussian" ? "Gaussian" : "Lens Blur"}
            </button>
          ))}
        </div>
        <span className={styles.unitSpacer} />
      </div>
      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            up({ amount: 100, radius: 2, reduceNoise: 10, remove: "gaussian" })
          }
          title="Reset"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
