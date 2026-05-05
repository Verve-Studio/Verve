import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type {
  BlackAndWhiteAdjustmentLayer,
  AdjustmentParamsMap,
} from "@/types";
import { ADJUSTMENT_REGISTRY } from "@/core/operations/adjustments/registry";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./BlackAndWhitePanel.module.scss";

// ─── Props ────────────────────────────────────────────────────────────────────

interface BlackAndWhitePanelProps {
  layer: BlackAndWhiteAdjustmentLayer;
  parentLayerName: string;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_PARAMS = ADJUSTMENT_REGISTRY.find(
  (e) => e.adjustmentType === "black-and-white",
)!.defaultParams as AdjustmentParamsMap["black-and-white"];

// ─── Component ────────────────────────────────────────────────────────────────

export function BlackAndWhitePanel({
  layer,
  parentLayerName,
}: BlackAndWhitePanelProps): React.JSX.Element {
  const { dispatch } = useAppContext();

  const pct = (v: number, min: number, max: number): string =>
    String((v - min) / (max - min));

  const update = (key: keyof typeof DEFAULT_PARAMS, value: number): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, [key]: value } },
    });
  };

  const rows: Array<{
    key: keyof typeof DEFAULT_PARAMS;
    label: string;
    labelClass: string;
  }> = [
    { key: "reds", label: "Reds", labelClass: styles.labelRed },
    { key: "yellows", label: "Yellows", labelClass: styles.labelYellow },
    { key: "greens", label: "Greens", labelClass: styles.labelGreen },
    { key: "cyans", label: "Cyans", labelClass: styles.labelCyan },
    { key: "blues", label: "Blues", labelClass: styles.labelBlue },
    { key: "magentas", label: "Magentas", labelClass: styles.labelMagenta },
  ];

  return (
    <div className={styles.content}>
      {rows.map(({ key, label, labelClass }) => {
        const val = layer.params[key];
        return (
          <div key={key} className={styles.row}>
            <span className={`${styles.label} ${labelClass}`}>{label}</span>
            <div className={styles.trackWrap}>
              <input
                type="range"
                className={styles.track}
                min={-200}
                max={300}
                step={1}
                value={val}
                style={{ "--pct": pct(val, -200, 300) } as React.CSSProperties}
                onChange={(e) => update(key, Number(e.target.value))}
              />
              <div className={styles.zeroTick} />
            </div>
            <input
              type="number"
              className={styles.numInput}
              min={-200}
              max={300}
              step={1}
              value={val}
              onChange={(e) => {
                const v = e.target.valueAsNumber;
                if (!isNaN(v))
                  update(key, Math.min(300, Math.max(-200, Math.round(v))));
              }}
            />
          </div>
        );
      })}
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
              payload: { ...layer, params: { ...DEFAULT_PARAMS } },
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
