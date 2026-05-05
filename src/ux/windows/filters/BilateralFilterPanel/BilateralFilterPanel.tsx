import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { BilateralFilterAdjustmentLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "../filterPanel.module.scss";

interface Props {
  layer: BilateralFilterAdjustmentLayer;
  parentLayerName: string;
}

export function BilateralFilterPanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { radius, sigmaSpatial, sigmaColor } = layer.params;
  const up = (partial: Partial<typeof layer.params>) =>
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...partial } },
    });

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Spatial Radius</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={1}
            max={20}
            step={1}
            value={radius}
            style={
              { "--pct": String((radius - 1) / 19) } as React.CSSProperties
            }
            onChange={(e) => up({ radius: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={1}
          max={20}
          step={1}
          value={radius}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ radius: Math.min(20, Math.max(1, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Sigma Spatial</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={1}
            max={50}
            step={1}
            value={sigmaSpatial}
            style={
              {
                "--pct": String((sigmaSpatial - 1) / 49),
              } as React.CSSProperties
            }
            onChange={(e) => up({ sigmaSpatial: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={1}
          max={50}
          step={1}
          value={sigmaSpatial}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ sigmaSpatial: Math.min(50, Math.max(1, Math.round(v))) });
          }}
        />
        <span className={styles.unitSpacer} />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Color Sigma</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={1}
            max={150}
            step={1}
            value={sigmaColor}
            style={
              { "--pct": String((sigmaColor - 1) / 149) } as React.CSSProperties
            }
            onChange={(e) => up({ sigmaColor: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={1}
          max={150}
          step={1}
          value={sigmaColor}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ sigmaColor: Math.min(150, Math.max(1, Math.round(v))) });
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
          onClick={() => up({ radius: 5, sigmaSpatial: 5, sigmaColor: 25 })}
          title="Reset"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
