import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { PaletteKnifeEffectLayer } from "./PaletteKnifeEffect";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "@/core/effects/_shared/filterPanel.module.scss";

interface Props {
  layer: PaletteKnifeEffectLayer;
  parentLayerName: string;
}

export function PaletteKnifePanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;

  const update = (patch: Partial<PaletteKnifeEffectLayer["params"]>): void => {
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
      {slider("Stroke Size", p.strokeSize, 1, 50, (v) =>
        update({ strokeSize: v }),
      )}
      {slider("Stroke Detail", p.strokeDetail, 1, 3, (v) =>
        update({ strokeDetail: v }),
      )}
      {slider("Softness", p.softness, 0, 10, (v) => update({ softness: v }))}

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Knifing <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            update({ strokeSize: 25, strokeDetail: 3, softness: 0 })
          }
        >
          Reset
        </button>
      </div>
    </div>
  );
}
