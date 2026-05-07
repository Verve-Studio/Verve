import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { GaussianBlurEffectLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "@/core/effects/_shared/filterPanel.module.scss";

interface Props {
  layer: GaussianBlurEffectLayer;
  parentLayerName: string;
}

export function GaussianBlurPanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { radius } = layer.params;
  const pct = String((radius - 1) / (250 - 1));
  const update = (r: number) =>
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, radius: r } },
    });

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Radius</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={1}
            max={250}
            step={1}
            value={radius}
            style={{ "--pct": pct } as React.CSSProperties}
            onChange={(e) => update(Number(e.target.value))}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={1}
          max={250}
          step={1}
          value={radius}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v)) update(Math.min(250, Math.max(1, Math.round(v))));
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
          onClick={() => update(2)}
          title="Reset to defaults"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
