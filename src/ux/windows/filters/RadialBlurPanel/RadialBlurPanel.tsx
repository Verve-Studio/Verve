import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { RadialBlurAdjustmentLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "../filterPanel.module.scss";

interface Props {
  layer: RadialBlurAdjustmentLayer;
  parentLayerName: string;
}

export function RadialBlurPanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { mode, amount, quality } = layer.params;
  const pctAmount = String((amount - 1) / 99);
  const up = (partial: Partial<typeof layer.params>) =>
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...partial } },
    });

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Mode</span>
        <div className={styles.segmented}>
          {([0, 1] as const).map((m) => (
            <button
              key={m}
              className={`${styles.segBtn} ${mode === m ? styles.segBtnActive : ""}`}
              onClick={() => up({ mode: m })}
            >
              {m === 0 ? "Spin" : "Zoom"}
            </button>
          ))}
        </div>
        <span className={styles.unitSpacer} />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Amount</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={1}
            max={100}
            step={1}
            value={amount}
            style={{ "--pct": pctAmount } as React.CSSProperties}
            onChange={(e) => up({ amount: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={1}
          max={100}
          step={1}
          value={amount}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ amount: Math.min(100, Math.max(1, Math.round(v))) });
          }}
        />
        <span className={styles.unitSpacer} />
      </div>
      <div className={styles.sep} />
      <div className={styles.row}>
        <span className={styles.label}>Quality</span>
        <div className={styles.segmented}>
          {([0, 1, 2] as const).map((q) => (
            <button
              key={q}
              className={`${styles.segBtn} ${quality === q ? styles.segBtnActive : ""}`}
              onClick={() => up({ quality: q })}
            >
              {q === 0 ? "Draft" : q === 1 ? "Good" : "Best"}
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
            up({ mode: 0, amount: 10, centerX: 0.5, centerY: 0.5, quality: 1 })
          }
          title="Reset"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
