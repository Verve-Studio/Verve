import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { HueSaturationEffectLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./HueSaturationPanel.module.scss";

// ─── Props ────────────────────────────────────────────────────────────────────

interface HueSaturationPanelProps {
  layer: HueSaturationEffectLayer;
  parentLayerName: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function HueSaturationPanel({
  layer,
  parentLayerName,
}: HueSaturationPanelProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { hue, saturation, lightness } = layer.params;

  const pct = (v: number, min: number, max: number): string =>
    String((v - min) / (max - min));

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Hue</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={`${styles.track} ${styles.hueTrack}`}
            min={-180}
            max={180}
            step={1}
            value={hue}
            onChange={(e) =>
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: { ...layer.params, hue: Number(e.target.value) },
                },
              })
            }
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={-180}
          max={180}
          step={1}
          value={hue}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    hue: Math.min(180, Math.max(-180, Math.round(v))),
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
      <div className={styles.row}>
        <span className={styles.label}>Lightness</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={-100}
            max={100}
            step={1}
            value={lightness}
            style={
              { "--pct": pct(lightness, -100, 100) } as React.CSSProperties
            }
            onChange={(e) =>
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    lightness: Number(e.target.value),
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
          value={lightness}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    lightness: Math.min(100, Math.max(-100, Math.round(v))),
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
              payload: {
                ...layer,
                params: { hue: 0, saturation: 0, lightness: 0 },
              },
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
