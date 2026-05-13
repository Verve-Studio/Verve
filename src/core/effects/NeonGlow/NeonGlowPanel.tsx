import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { NeonGlowEffectLayer } from "./NeonGlowEffect";
import { ColorSwatch } from "@/ux/widgets/ColorSwatch/ColorSwatch";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "@/core/effects/_shared/filterPanel.module.scss";

interface Props {
  layer: NeonGlowEffectLayer;
  parentLayerName: string;
}

const toHex = (r: number, g: number, b: number): string => {
  const h = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
};
const fromHex = (s: string): { r: number; g: number; b: number } | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
};

export function NeonGlowPanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;

  const update = (patch: Partial<NeonGlowEffectLayer["params"]>): void => {
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
      {slider("Glow Size", p.glowSize, -24, 24, (v) => update({ glowSize: v }))}
      {slider("Glow Brightness", p.glowBrightness, 0, 50, (v) =>
        update({ glowBrightness: v }),
      )}
      <div className={styles.row}>
        <span className={styles.label}>Glow Color</span>
        <ColorSwatch
          value={toHex(p.glowColor.r, p.glowColor.g, p.glowColor.b)}
          onChange={(hex) => {
            const rgb = fromHex(hex);
            if (rgb) update({ glowColor: { ...rgb, a: 255 } });
          }}
          title="Glow color"
        />
        <div className={styles.trackWrap} />
      </div>

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Glowing <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            update({
              glowSize: 5,
              glowBrightness: 15,
              glowColor: { r: 76, g: 220, b: 230, a: 255 },
            })
          }
        >
          Reset
        </button>
      </div>
    </div>
  );
}
