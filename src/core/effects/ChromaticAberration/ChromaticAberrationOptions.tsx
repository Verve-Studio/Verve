import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { ChromaticAberrationEffectLayer } from "@/core/effects/ChromaticAberration/ChromaticAberrationEffect";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./ChromaticAberrationOptions.module.scss";

interface ChromaticAberrationOptionsProps {
  layer: ChromaticAberrationEffectLayer;
  parentLayerName: string;
}

export function ChromaticAberrationOptions({
  layer,
  parentLayerName,
}: ChromaticAberrationOptionsProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { type, distance, angle } = layer.params;

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
      {/* ── Type ─────────────────────────────────────────────────────────── */}
      <div className={styles.row}>
        <span className={styles.label}>Type</span>
        <div className={styles.segmented}>
          {(["radial", "directional"] as const).map((t) => (
            <button
              key={t}
              className={`${styles.segBtn} ${type === t ? styles.segBtnActive : ""}`}
              onClick={() => update({ type: t })}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* ── Distance ─────────────────────────────────────────────────────── */}
      <div className={styles.row}>
        <span className={styles.label}>Distance</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={50}
            step={0.5}
            value={distance}
            style={{ "--pct": pct(distance, 0, 50) } as React.CSSProperties}
            onChange={(e) => update({ distance: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={50}
          step={0.5}
          value={distance}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v)) update({ distance: Math.min(50, Math.max(0, v)) });
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>

      {/* ── Angle (directional only) ──────────────────────────────────────── */}
      {type === "directional" && (
        <div className={styles.row}>
          <span className={styles.label}>Angle</span>
          <div className={styles.trackWrap}>
            <input
              type="range"
              className={styles.track}
              min={0}
              max={360}
              step={1}
              value={angle}
              style={{ "--pct": pct(angle, 0, 360) } as React.CSSProperties}
              onChange={(e) => update({ angle: Number(e.target.value) })}
            />
          </div>
          <input
            type="number"
            className={styles.numInput}
            min={0}
            max={360}
            step={1}
            value={angle}
            onChange={(e) => {
              const v = e.target.valueAsNumber;
              if (!isNaN(v))
                update({ angle: ((Math.round(v) % 360) + 360) % 360 });
            }}
          />
          <span className={styles.unitLabel}>°</span>
        </div>
      )}

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() => update({ type: "radial", distance: 5, angle: 0 })}
          title="Reset to defaults"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
