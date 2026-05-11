import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import { activeScope } from "@/core/store/scope";
import type {
  RepeatAxisMode,
  RepeatBackground,
  RepeatEffectLayer,
} from "./RepeatEffect";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "@/core/effects/_shared/filterPanel.module.scss";

interface Props {
  layer: RepeatEffectLayer;
  parentLayerName: string;
}

const X_MODES: { value: RepeatAxisMode; label: string }[] = [
  { value: "none", label: "None" },
  { value: "negative", label: "Left" },
  { value: "positive", label: "Right" },
  { value: "both", label: "Both" },
];

const Y_MODES: { value: RepeatAxisMode; label: string }[] = [
  { value: "none", label: "None" },
  { value: "negative", label: "Up" },
  { value: "positive", label: "Down" },
  { value: "both", label: "Both" },
];

const BG_MODES: { value: RepeatBackground; label: string }[] = [
  { value: "passthrough", label: "Pass-through" },
  { value: "transparent", label: "Transparent" },
];

/** Walk the selection mask once to find the smallest axis-aligned rect
 *  containing every selected pixel. Returns null when the mask is empty. */
function maskBoundingRect(
  mask: Uint8Array,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } | null {
  let minX = w,
    maxX = -1,
    minY = h,
    maxY = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) {
      const x = i % w;
      const y = (i - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function RepeatPanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { state, dispatch } = useAppContext();
  const p = layer.params;

  const update = (patch: Partial<RepeatEffectLayer["params"]>): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...patch } },
    });
  };

  const useSelection = (): void => {
    const sel = activeScope().selection;
    if (!sel.mask) return;
    const r = maskBoundingRect(sel.mask, sel.width, sel.height);
    if (!r) return;
    update({ rectX: r.x, rectY: r.y, rectW: r.w, rectH: r.h });
  };

  const segmented = <T extends string>(
    label: string,
    value: T,
    options: { value: T; label: string }[],
    onChange: (v: T) => void,
  ): React.JSX.Element => (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div className={styles.segmented}>
        {options.map((o) => (
          <button
            key={o.value}
            className={
              o.value === value
                ? `${styles.segBtn} ${styles.segBtnActive}`
                : styles.segBtn
            }
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );

  const numberField = (
    label: string,
    value: number,
    onChange: (v: number) => void,
    min?: number,
  ): React.JSX.Element => (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div className={styles.trackWrap} />
      <input
        type="number"
        className={styles.numInput}
        step={1}
        min={min}
        value={value}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (!isNaN(v)) {
            const rounded = Math.round(v);
            onChange(min !== undefined ? Math.max(min, rounded) : rounded);
          }
        }}
      />
      <span className={styles.unitLabel}>px</span>
    </div>
  );

  const SLIDER_MAX = 256;

  const hasSelection = state.canvas.width > 0 && activeScope().selection.mask !== null;

  return (
    <div className={styles.content}>
      {segmented("X axis", p.xMode, X_MODES, (v) => update({ xMode: v }))}
      {segmented("Y axis", p.yMode, Y_MODES, (v) => update({ yMode: v }))}

      <div className={styles.sep} />

      {numberField("Rect X", p.rectX, (v) => update({ rectX: v }))}
      {numberField("Rect Y", p.rectY, (v) => update({ rectY: v }))}
      {numberField("Rect W", p.rectW, (v) => update({ rectW: v }), 0)}
      {numberField("Rect H", p.rectH, (v) => update({ rectH: v }), 0)}

      <div className={styles.row}>
        <span className={styles.label}></span>
        <button
          className={styles.resetBtn}
          onClick={useSelection}
          disabled={!hasSelection}
          title={
            hasSelection
              ? "Set the source rect to the current selection's bounding box"
              : "Make a selection on the canvas first"
          }
        >
          Use Selection
        </button>
      </div>

      <div className={styles.sep} />

      <div className={styles.row}>
        <span className={styles.label}>Spacing</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={SLIDER_MAX}
            step={1}
            value={Math.max(0, Math.min(SLIDER_MAX, p.spacing))}
            style={
              {
                "--pct": String(
                  Math.max(0, Math.min(SLIDER_MAX, p.spacing)) / SLIDER_MAX,
                ),
              } as React.CSSProperties
            }
            onChange={(e) => update({ spacing: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          step={1}
          min={0}
          value={p.spacing}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v)) update({ spacing: Math.max(0, Math.round(v)) });
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>

      {segmented("Background", p.background, BG_MODES, (v) =>
        update({ background: v }),
      )}

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Repeating <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            update({
              xMode: "positive",
              yMode: "none",
              rectX: 0,
              rectY: 0,
              rectW: 0,
              rectH: 0,
              spacing: 0,
              background: "passthrough",
            })
          }
          title="Reset all parameters"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
