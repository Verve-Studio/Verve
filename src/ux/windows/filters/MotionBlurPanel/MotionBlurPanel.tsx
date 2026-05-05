import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { MotionBlurAdjustmentLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "../filterPanel.module.scss";

interface Props {
  layer: MotionBlurAdjustmentLayer;
  parentLayerName: string;
}

export function MotionBlurPanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { angle, distance } = layer.params;
  const up = (partial: Partial<typeof layer.params>) =>
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...partial } },
    });

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Angle</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={360}
            step={1}
            value={angle}
            style={{ "--pct": String(angle / 360) } as React.CSSProperties}
            onChange={(e) => up({ angle: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={360}
          step={1}
          value={angle}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ angle: Math.min(360, Math.max(0, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>°</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Distance</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={1}
            max={999}
            step={1}
            value={distance}
            style={
              { "--pct": String((distance - 1) / 998) } as React.CSSProperties
            }
            onChange={(e) => up({ distance: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={1}
          max={999}
          step={1}
          value={distance}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ distance: Math.min(999, Math.max(1, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>
      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() => up({ angle: 0, distance: 10 })}
          title="Reset"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
