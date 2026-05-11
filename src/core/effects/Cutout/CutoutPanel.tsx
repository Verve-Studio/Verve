import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { CutoutEffectLayer } from "./CutoutEffect";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "@/core/effects/_shared/filterPanel.module.scss";

interface Props {
  layer: CutoutEffectLayer;
  parentLayerName: string;
}

export function CutoutPanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;

  const update = (patch: Partial<CutoutEffectLayer["params"]>): void => {
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
    step: number,
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
          step={step}
          value={Math.max(min, Math.min(max, value))}
          style={
            {
              "--pct": String((value - min) / (max - min || 1)),
            } as React.CSSProperties
          }
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      <input
        type="number"
        className={styles.numInput}
        step={step}
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (!isNaN(v)) onChange(Math.max(min, Math.min(max, v)));
        }}
      />
      <span className={styles.unitSpacer} />
    </div>
  );

  return (
    <div className={styles.content}>
      {slider("Number of Levels", p.levels, 2, 8, 1, (v) =>
        update({ levels: Math.round(v) }),
      )}
      {slider("Edge Simplicity", p.edgeSimplicity, 1, 10, 1, (v) =>
        update({ edgeSimplicity: Math.round(v) }),
      )}
      {slider("Edge Fidelity", p.edgeFidelity, 1, 3, 1, (v) =>
        update({ edgeFidelity: Math.round(v) }),
      )}

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Cutting out <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            update({ levels: 4, edgeSimplicity: 4, edgeFidelity: 2 })
          }
        >
          Reset
        </button>
      </div>
    </div>
  );
}
