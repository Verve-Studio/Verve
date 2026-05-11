import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { ColorVibranceEffectLayer } from "@/core/effects/ColorVibrance/ColorVibranceEffect";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./ColorVibrancePanel.module.scss";

// ─── Props ────────────────────────────────────────────────────────────────────

interface ColorVibrancePanelProps {
  layer: ColorVibranceEffectLayer;
  parentLayerName: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ColorVibrancePanel({
  layer,
  parentLayerName,
}: ColorVibrancePanelProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { vibrance, saturation } = layer.params;

  const pct = (v: number, min: number, max: number): string =>
    String((v - min) / (max - min));

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Vibrance</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={-100}
            max={100}
            step={1}
            value={vibrance}
            style={{ "--pct": pct(vibrance, -100, 100) } as React.CSSProperties}
            onChange={(e) =>
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: { ...layer.params, vibrance: Number(e.target.value) },
                },
              })
            }
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={-100}
          max={100}
          step={1}
          value={vibrance}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    vibrance: Math.min(100, Math.max(-100, Math.round(v))),
                  },
                },
              });
          }}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Saturation</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={-100}
            max={100}
            step={1}
            value={saturation}
            style={
              { "--pct": pct(saturation, -100, 100) } as React.CSSProperties
            }
            onChange={(e) =>
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    saturation: Number(e.target.value),
                  },
                },
              })
            }
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={-100}
          max={100}
          step={1}
          value={saturation}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    saturation: Math.min(100, Math.max(-100, Math.round(v))),
                  },
                },
              });
          }}
        />
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
              payload: { ...layer, params: { vibrance: 0, saturation: 0 } },
            })
          }
          title="Reset to defaults"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
