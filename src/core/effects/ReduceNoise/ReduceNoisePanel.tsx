import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { ReduceNoiseAdjustmentLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "@/core/effects/_shared/filterPanel.module.scss";

interface Props {
  layer: ReduceNoiseAdjustmentLayer;
  parentLayerName: string;
}

export function ReduceNoisePanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { strength, preserveDetails, reduceColorNoise, sharpenDetails } =
    layer.params;
  const up = (partial: Partial<typeof layer.params>) =>
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...partial } },
    });

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Strength</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={10}
            step={1}
            value={strength}
            style={{ "--pct": String(strength / 10) } as React.CSSProperties}
            onChange={(e) => up({ strength: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={10}
          step={1}
          value={strength}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ strength: Math.min(10, Math.max(0, Math.round(v))) });
          }}
        />
        <span className={styles.unitSpacer} />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Preserve Details</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={100}
            step={1}
            value={preserveDetails}
            style={
              { "--pct": String(preserveDetails / 100) } as React.CSSProperties
            }
            onChange={(e) => up({ preserveDetails: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={preserveDetails}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({
                preserveDetails: Math.min(100, Math.max(0, Math.round(v))),
              });
          }}
        />
        <span className={styles.unitLabel}>%</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Color Noise</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={100}
            step={1}
            value={reduceColorNoise}
            style={
              { "--pct": String(reduceColorNoise / 100) } as React.CSSProperties
            }
            onChange={(e) => up({ reduceColorNoise: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={reduceColorNoise}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({
                reduceColorNoise: Math.min(100, Math.max(0, Math.round(v))),
              });
          }}
        />
        <span className={styles.unitLabel}>%</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Sharpen Details</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={100}
            step={1}
            value={sharpenDetails}
            style={
              { "--pct": String(sharpenDetails / 100) } as React.CSSProperties
            }
            onChange={(e) => up({ sharpenDetails: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={sharpenDetails}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ sharpenDetails: Math.min(100, Math.max(0, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>%</span>
      </div>
      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            up({
              strength: 6,
              preserveDetails: 60,
              reduceColorNoise: 25,
              sharpenDetails: 0,
            })
          }
          title="Reset"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
