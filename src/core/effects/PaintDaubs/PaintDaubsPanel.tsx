import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type {
  PaintDaubsEffectLayer,
  PaintDaubsBrushType,
} from "./PaintDaubsEffect";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "@/core/effects/_shared/filterPanel.module.scss";

interface Props {
  layer: PaintDaubsEffectLayer;
  parentLayerName: string;
}

const BRUSH_TYPES: { value: PaintDaubsBrushType; label: string }[] = [
  { value: "simple", label: "Simple" },
  { value: "light-rough", label: "Light Rough" },
  { value: "dark-rough", label: "Dark Rough" },
  { value: "wide-sharp", label: "Wide Sharp" },
  { value: "wide-blurry", label: "Wide Blurry" },
  { value: "sparkle", label: "Sparkle" },
];

export function PaintDaubsPanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;

  const update = (patch: Partial<PaintDaubsEffectLayer["params"]>): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...patch } },
    });
  };

  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (v: number) => void,
  ): React.JSX.Element => (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div className={styles.trackWrap}>
        <input
          type="range"
          className={styles.track}
          min={min}
          max={max}
          step={1}
          value={Math.max(min, Math.min(max, value))}
          style={
            { "--pct": String((value - min) / (max - min)) } as React.CSSProperties
          }
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      <input
        type="number"
        className={styles.numInput}
        step={1}
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (!isNaN(v)) onChange(Math.max(min, Math.min(max, Math.round(v))));
        }}
      />
      <span className={styles.unitSpacer} />
    </div>
  );

  return (
    <div className={styles.content}>
      {slider("Brush Size", p.brushSize, 1, 50, (v) => update({ brushSize: v }))}
      {slider("Sharpness", p.sharpness, 0, 40, (v) => update({ sharpness: v }))}

      <div className={styles.row}>
        <span className={styles.label}>Brush Type</span>
        <select
          value={p.brushType}
          onChange={(e) =>
            update({ brushType: e.target.value as PaintDaubsBrushType })
          }
          style={{
            flex: 1,
            height: 22,
            fontSize: 11,
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            borderRadius: 2,
            color: "var(--color-text)",
          }}
        >
          {BRUSH_TYPES.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Daubing <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            update({ brushSize: 8, sharpness: 20, brushType: "simple" })
          }
        >
          Reset
        </button>
      </div>
    </div>
  );
}
