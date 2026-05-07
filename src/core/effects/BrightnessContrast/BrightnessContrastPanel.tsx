import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { BrightnessContrastEffectLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./BrightnessContrastPanel.module.scss";

// ─── Props ────────────────────────────────────────────────────────────────────

interface BrightnessContrastPanelProps {
  layer: BrightnessContrastEffectLayer;
  parentLayerName: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BrightnessContrastPanel({
  layer,
  parentLayerName,
}: BrightnessContrastPanelProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { brightness, contrast } = layer.params;

  const pct = (v: number, min: number, max: number): string =>
    String((v - min) / (max - min));

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Brightness</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={-100}
            max={100}
            step={1}
            value={brightness}
            style={
              { "--pct": pct(brightness, -100, 100) } as React.CSSProperties
            }
            onChange={(e) =>
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    brightness: Number(e.target.value),
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
          value={brightness}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    brightness: Math.min(100, Math.max(-100, Math.round(v))),
                  },
                },
              });
          }}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Contrast</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={-100}
            max={100}
            step={1}
            value={contrast}
            style={{ "--pct": pct(contrast, -100, 100) } as React.CSSProperties}
            onChange={(e) =>
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: { ...layer.params, contrast: Number(e.target.value) },
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
          value={contrast}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    contrast: Math.min(100, Math.max(-100, Math.round(v))),
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
              payload: { ...layer, params: { brightness: 0, contrast: 0 } },
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
