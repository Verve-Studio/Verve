import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { PlasticWrapEffectLayer } from "./PlasticWrapEffect";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "@/core/effects/_shared/filterPanel.module.scss";

interface Props {
  layer: PlasticWrapEffectLayer;
  parentLayerName: string;
}

export function PlasticWrapPanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;

  const update = (patch: Partial<PlasticWrapEffectLayer["params"]>): void => {
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
      {slider("Highlight Strength", p.highlightStrength, 0, 20, (v) =>
        update({ highlightStrength: v }),
      )}
      {slider("Detail", p.detail, 1, 15, (v) => update({ detail: v }))}
      {slider("Smoothness", p.smoothness, 1, 15, (v) =>
        update({ smoothness: v }),
      )}

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Wrapping <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            update({ highlightStrength: 15, detail: 10, smoothness: 7 })
          }
        >
          Reset
        </button>
      </div>
    </div>
  );
}
