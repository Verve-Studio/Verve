import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { ColorTemperatureAdjustmentLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./ColorTemperaturePanel.module.scss";

interface ColorTemperaturePanelProps {
  layer: ColorTemperatureAdjustmentLayer;
  parentLayerName: string;
}

export function ColorTemperaturePanel({
  layer,
  parentLayerName,
}: ColorTemperaturePanelProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { temperature, tint } = layer.params;

  const pct = (v: number, min: number, max: number): string =>
    String((v - min) / (max - min));

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Temperature</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={`${styles.track} ${styles.trackTemperature}`}
            min={-100}
            max={100}
            step={1}
            value={temperature}
            style={
              { "--pct": pct(temperature, -100, 100) } as React.CSSProperties
            }
            onChange={(e) =>
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    temperature: Number(e.target.value),
                  },
                },
              })
            }
          />
          <div className={styles.zeroTick} />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={-100}
          max={100}
          step={1}
          value={temperature}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    temperature: Math.min(100, Math.max(-100, Math.round(v))),
                  },
                },
              });
          }}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Tint</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={`${styles.track} ${styles.trackTint}`}
            min={-100}
            max={100}
            step={1}
            value={tint}
            style={{ "--pct": pct(tint, -100, 100) } as React.CSSProperties}
            onChange={(e) =>
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: { ...layer.params, tint: Number(e.target.value) },
                },
              })
            }
          />
          <div className={styles.zeroTick} />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={-100}
          max={100}
          step={1}
          value={tint}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    tint: Math.min(100, Math.max(-100, Math.round(v))),
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
              payload: { ...layer, params: { temperature: 0, tint: 0 } },
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
