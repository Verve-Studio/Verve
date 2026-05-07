import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { LensBlurAdjustmentLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "../filterPanel.module.scss";

interface Props {
  layer: LensBlurAdjustmentLayer;
  parentLayerName: string;
}

export function LensBlurPanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { radius, bladeCount, bladeCurvature, rotation } = layer.params;
  const up = (partial: Partial<typeof layer.params>) =>
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...partial } },
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
            max={100}
            step={1}
            value={radius}
            style={
              { "--pct": String((radius - 1) / 99) } as React.CSSProperties
            }
            onChange={(e) => up({ radius: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={1}
          max={100}
          step={1}
          value={radius}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ radius: Math.min(100, Math.max(1, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Blades</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={3}
            max={8}
            step={1}
            value={bladeCount}
            style={
              { "--pct": String((bladeCount - 3) / 5) } as React.CSSProperties
            }
            onChange={(e) => up({ bladeCount: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={3}
          max={8}
          step={1}
          value={bladeCount}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ bladeCount: Math.min(8, Math.max(3, Math.round(v))) });
          }}
        />
        <span className={styles.unitSpacer} />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Curvature</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={100}
            step={1}
            value={bladeCurvature}
            style={
              { "--pct": String(bladeCurvature / 100) } as React.CSSProperties
            }
            onChange={(e) => up({ bladeCurvature: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={bladeCurvature}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ bladeCurvature: Math.min(100, Math.max(0, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>%</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Rotation</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={359}
            step={1}
            value={rotation}
            style={{ "--pct": String(rotation / 359) } as React.CSSProperties}
            onChange={(e) => up({ rotation: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={359}
          step={1}
          value={rotation}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ rotation: Math.min(359, Math.max(0, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>°</span>
      </div>
      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            up({ radius: 10, bladeCount: 6, bladeCurvature: 0, rotation: 0 })
          }
          title="Reset"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
