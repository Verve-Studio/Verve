import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { LensFlareEffectLayer } from "@/core/effects/LensFlare/LensFlareEffect";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "@/core/effects/_shared/filterPanel.module.scss";

interface Props {
  layer: LensFlareEffectLayer;
  parentLayerName: string;
}

const LENS_TYPES = [
  "50–300mm Zoom",
  "35mm Prime",
  "105mm Prime",
  "Movie Prime",
  "Cinematic / Anamorphic",
];

export function LensFlarePanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { state, dispatch } = useAppContext();
  const p = layer.params;
  const canvasW = Math.max(1, state.canvas.width);
  const canvasH = Math.max(1, state.canvas.height);

  const update = <K extends keyof typeof p>(
    key: K,
    value: (typeof p)[K],
  ): void =>
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...p, [key]: value } },
    });

  const slider = (
    label: string,
    field: keyof typeof p,
    min: number,
    max: number,
    unit = "",
  ): React.JSX.Element => {
    const value = p[field] as number;
    const pct = (value - min) / (max - min);
    return (
      <div className={styles.row}>
        <span className={styles.label}>{label}</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={min}
            max={max}
            step={1}
            value={value}
            style={{ "--pct": String(pct) } as React.CSSProperties}
            onChange={(e) =>
              update(field, Number(e.target.value) as (typeof p)[typeof field])
            }
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              update(
                field,
                Math.min(max, Math.max(min, Math.round(v))) as (typeof p)[typeof field],
              );
          }}
        />
        {unit && <span className={styles.unitLabel}>{unit}</span>}
      </div>
    );
  };

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Lens Type</span>
        <select
          value={p.lensType}
          onChange={(e) => update("lensType", Number(e.target.value))}
        >
          {LENS_TYPES.map((label, idx) => (
            <option key={idx} value={idx}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {slider("Center X", "centerX", 0, canvasW, "px")}
      {slider("Center Y", "centerY", 0, canvasH, "px")}
      {slider("Brightness", "brightness", 10, 300, "%")}
      {slider("Rings", "ringOpacity", 0, 100, "%")}
      {slider("Streaks", "streakStrength", 0, 100, "%")}
      {slider("Streak Width", "streakWidth", 1, 500, "%")}
      {slider("Streak Rotation", "streakRotation", 0, 359, "°")}
      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
      </div>
    </div>
  );
}
