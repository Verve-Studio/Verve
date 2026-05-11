import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { ColoredPencilEffectLayer } from "./ColoredPencilEffect";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "@/core/effects/_shared/filterPanel.module.scss";

interface Props {
  layer: ColoredPencilEffectLayer;
  parentLayerName: string;
}

export function ColoredPencilPanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;

  const update = (patch: Partial<ColoredPencilEffectLayer["params"]>): void => {
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
      {slider("Pencil Width", p.pencilWidth, 1, 24, (v) =>
        update({ pencilWidth: v }),
      )}
      {slider("Stroke Pressure", p.strokePressure, 0, 15, (v) =>
        update({ strokePressure: v }),
      )}
      {slider("Paper Brightness", p.paperBrightness, 0, 50, (v) =>
        update({ paperBrightness: v }),
      )}
      {slider("Opacity", p.opacity, 0, 100, (v) => update({ opacity: v }))}

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Sketching <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            update({
              pencilWidth: 4,
              strokePressure: 8,
              paperBrightness: 25,
              opacity: 100,
            })
          }
        >
          Reset
        </button>
      </div>
    </div>
  );
}
