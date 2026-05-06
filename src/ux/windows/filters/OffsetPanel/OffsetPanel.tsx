import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { OffsetAdjustmentLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "../filterPanel.module.scss";

interface Props {
  layer: OffsetAdjustmentLayer;
  parentLayerName: string;
}

export function OffsetPanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { offsetX, offsetY } = layer.params;

  const update = (patch: Partial<OffsetAdjustmentLayer["params"]>): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...patch } },
    });
  };

  // Slider range covers a generous shift; the wrap-around behaviour means any
  // value modulo the canvas dimensions produces a unique result, so the cap is
  // more about UX than correctness.
  const SLIDER_MIN = -2000;
  const SLIDER_MAX = 2000;
  const sliderPct = (v: number): string =>
    String((v - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN));

  const slider = (
    label: string,
    value: number,
    onChange: (v: number) => void,
  ): React.JSX.Element => (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div className={styles.trackWrap}>
        <input
          type="range"
          className={styles.track}
          min={SLIDER_MIN}
          max={SLIDER_MAX}
          step={1}
          value={Math.max(SLIDER_MIN, Math.min(SLIDER_MAX, value))}
          style={{ "--pct": sliderPct(value) } as React.CSSProperties}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      <input
        type="number"
        className={styles.numInput}
        step={1}
        value={value}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (!isNaN(v)) onChange(Math.round(v));
        }}
      />
      <span className={styles.unitLabel}>px</span>
    </div>
  );

  return (
    <div className={styles.content}>
      {slider("Offset X", offsetX, (v) => update({ offsetX: v }))}
      {slider("Offset Y", offsetY, (v) => update({ offsetY: v }))}

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Offsetting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() => update({ offsetX: 0, offsetY: 0 })}
          title="Reset to zero"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
