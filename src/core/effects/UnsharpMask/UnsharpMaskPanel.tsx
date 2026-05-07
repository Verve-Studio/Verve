import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { UnsharpMaskAdjustmentLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "@/core/effects/_shared/filterPanel.module.scss";

interface Props {
  layer: UnsharpMaskAdjustmentLayer;
  parentLayerName: string;
}

export function UnsharpMaskPanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { amount, radius, threshold } = layer.params;
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
        <span className={styles.label}>Threshold</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={255}
            step={1}
            value={threshold}
            style={{ "--pct": String(threshold / 255) } as React.CSSProperties}
            onChange={(e) => up({ threshold: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={255}
          step={1}
          value={threshold}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ threshold: Math.min(255, Math.max(0, Math.round(v))) });
          }}
        />
        <span className={styles.unitSpacer} />
      </div>
      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() => up({ amount: 100, radius: 2, threshold: 0 })}
          title="Reset"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
