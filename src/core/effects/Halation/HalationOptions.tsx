import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { HalationEffectLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./HalationOptions.module.scss";

interface HalationOptionsProps {
  layer: HalationEffectLayer;
  parentLayerName: string;
}

export function HalationOptions({
  layer,
  parentLayerName,
}: HalationOptionsProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { threshold, spread, blur, strength } = layer.params;

  const pct = (v: number, min: number, max: number): string =>
    String((v - min) / (max - min));

  function update(patch: Partial<typeof layer.params>) {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...patch } },
    });
  }

  return (
    <div className={styles.content}>
      {/* ── Threshold ────────────────────────────────────────────────────── */}
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
            onChange={(e) => update({ threshold: Number(e.target.value) })}
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
            if (!isNaN(v)) update({ threshold: Math.min(1, Math.max(0, v)) });
          }}
        />
        <span className={styles.unitSpacer} />
      </div>

      {/* ── Spread ───────────────────────────────────────────────────────── */}
      <div className={styles.row}>
        <span className={styles.label}>Spread</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={100}
            step={1}
            value={spread}
            style={{ "--pct": pct(spread, 0, 100) } as React.CSSProperties}
            onChange={(e) => update({ spread: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={spread}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              update({ spread: Math.min(100, Math.max(0, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>

      {/* ── Blur ─────────────────────────────────────────────────────────── */}
      <div className={styles.row}>
        <span className={styles.label}>Blur</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={1}
            max={5}
            step={1}
            value={blur}
            style={{ "--pct": pct(blur, 1, 5) } as React.CSSProperties}
            onChange={(e) => update({ blur: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={1}
          max={5}
          step={1}
          value={blur}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              update({ blur: Math.min(5, Math.max(1, Math.round(v))) });
          }}
        />
        <span className={styles.unitSpacer} />
      </div>

      {/* ── Strength ─────────────────────────────────────────────────────── */}
      <div className={styles.row}>
        <span className={styles.label}>Strength</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={1}
            step={0.01}
            value={strength}
            style={{ "--pct": pct(strength, 0, 1) } as React.CSSProperties}
            onChange={(e) => update({ strength: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={1}
          step={0.01}
          value={strength}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v)) update({ strength: Math.min(1, Math.max(0, v)) });
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
          onClick={() =>
            update({ threshold: 0.5, spread: 30, blur: 2, strength: 0.6 })
          }
          title="Reset to defaults"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
