import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { BloomEffectLayer } from "@/core/effects/Bloom/BloomEffect";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./BloomOptions.module.scss";

// ─── Props ────────────────────────────────────────────────────────────────────

interface BloomOptionsProps {
  layer: BloomEffectLayer;
  parentLayerName: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BloomOptions({
  layer,
  parentLayerName,
}: BloomOptionsProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { threshold, strength, spread, quality } = layer.params;

  const pct = (v: number, min: number, max: number): string =>
    String((v - min) / (max - min));

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Threshold</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={1}
            step={0.01}
            value={threshold}
            style={{ "--pct": pct(threshold, 0, 1) } as React.CSSProperties}
            onChange={(e) =>
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    threshold: Number(e.target.value),
                  },
                },
              })
            }
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={1}
          step={0.01}
          value={threshold}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    threshold: Math.min(1, Math.max(0, v)),
                  },
                },
              });
          }}
        />
        <span className={styles.unitSpacer} />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Strength</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={2}
            step={0.01}
            value={strength}
            style={{ "--pct": pct(strength, 0, 2) } as React.CSSProperties}
            onChange={(e) =>
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: { ...layer.params, strength: Number(e.target.value) },
                },
              })
            }
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={2}
          step={0.01}
          value={strength}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    strength: Math.min(2, Math.max(0, v)),
                  },
                },
              });
          }}
        />
        <span className={styles.unitSpacer} />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Spread</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={1}
            max={100}
            step={1}
            value={spread}
            style={{ "--pct": pct(spread, 1, 100) } as React.CSSProperties}
            onChange={(e) =>
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: { ...layer.params, spread: Number(e.target.value) },
                },
              })
            }
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={1}
          max={100}
          step={1}
          value={spread}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: {
                    ...layer.params,
                    spread: Math.min(100, Math.max(1, Math.round(v))),
                  },
                },
              });
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>
      <div className={styles.sep} />
      <div className={styles.qualityRow}>
        <span className={styles.label}>Quality</span>
        <div className={styles.segmented}>
          {(["full", "half", "quarter"] as const).map((q) => (
            <button
              key={q}
              className={`${styles.segBtn} ${quality === q ? styles.segBtnActive : ""}`}
              onClick={() =>
                dispatch({
                  type: "UPDATE_ADJUSTMENT_LAYER",
                  payload: {
                    ...layer,
                    params: { ...layer.params, quality: q },
                  },
                })
              }
            >
              {q.charAt(0).toUpperCase() + q.slice(1)}
            </button>
          ))}
        </div>
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
                params: {
                  threshold: 0.5,
                  strength: 0.5,
                  spread: 20,
                  quality: "half",
                },
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
