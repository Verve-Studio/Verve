import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { InnerShadowAdjustmentLayer } from "@/types";
import { ColorSwatch } from "@/ux/widgets/ColorSwatch/ColorSwatch";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./InnerShadowOptions.module.scss";

interface InnerShadowOptionsProps {
  layer: InnerShadowAdjustmentLayer;
  parentLayerName: string;
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}

function pct(v: number, lo: number, hi: number): string {
  return String((v - lo) / (hi - lo));
}

export function InnerShadowOptions({
  layer,
  parentLayerName,
}: InnerShadowOptionsProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;

  const update = (patch: Partial<typeof p>): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...p, ...patch } },
    });
  };

  const hexValue = rgbToHex(p.color.r, p.color.g, p.color.b);

  return (
    <div className={styles.content}>
      {/* Color */}
      <div className={styles.row}>
        <span className={styles.label}>Color</span>
        <ColorSwatch
          value={hexValue}
          onChange={(hex) => {
            const rgb = hexToRgb(hex);
            if (rgb) update({ color: { ...rgb, a: p.color.a } });
          }}
          title="Shadow color"
        />
        <input
          type="text"
          className={styles.hexInput}
          value={hexValue.toUpperCase()}
          onChange={(e) => {
            const rgb = hexToRgb(e.target.value);
            if (rgb) update({ color: { ...rgb, a: p.color.a } });
          }}
          maxLength={7}
          spellCheck={false}
        />
        <span className={styles.unitSpacer} />
      </div>

      {/* Opacity */}
      <div className={styles.row}>
        <span className={styles.label}>Opacity</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={100}
            step={1}
            value={p.opacity}
            style={{ "--pct": pct(p.opacity, 0, 100) } as React.CSSProperties}
            onChange={(e) => update({ opacity: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={p.opacity}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v)) update({ opacity: Math.min(100, Math.max(0, v)) });
          }}
        />
        <span className={styles.unitLabel}>%</span>
      </div>

      {/* X Offset */}
      <div className={styles.row}>
        <span className={styles.label}>X Offset</span>
        <div className={styles.signedTrackWrap}>
          <input
            type="range"
            className={styles.track}
            min={-200}
            max={200}
            step={1}
            value={p.offsetX}
            style={
              { "--pct": pct(p.offsetX, -200, 200) } as React.CSSProperties
            }
            onChange={(e) => update({ offsetX: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInputWide}
          min={-200}
          max={200}
          step={1}
          value={p.offsetX}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              update({ offsetX: Math.min(200, Math.max(-200, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>

      {/* Y Offset */}
      <div className={styles.row}>
        <span className={styles.label}>Y Offset</span>
        <div className={styles.signedTrackWrap}>
          <input
            type="range"
            className={styles.track}
            min={-200}
            max={200}
            step={1}
            value={p.offsetY}
            style={
              { "--pct": pct(p.offsetY, -200, 200) } as React.CSSProperties
            }
            onChange={(e) => update({ offsetY: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInputWide}
          min={-200}
          max={200}
          step={1}
          value={p.offsetY}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              update({ offsetY: Math.min(200, Math.max(-200, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>

      {/* Spread */}
      <div className={styles.row}>
        <span className={styles.label}>Spread</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={100}
            step={1}
            value={p.spread}
            style={{ "--pct": pct(p.spread, 0, 100) } as React.CSSProperties}
            onChange={(e) => update({ spread: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={p.spread}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              update({ spread: Math.min(100, Math.max(0, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>

      {/* Softness */}
      <div className={styles.row}>
        <span className={styles.label}>Softness</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={100}
            step={1}
            value={p.softness}
            style={{ "--pct": pct(p.softness, 0, 100) } as React.CSSProperties}
            onChange={(e) => update({ softness: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={p.softness}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              update({ softness: Math.min(100, Math.max(0, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>

      <div className={styles.footer}>
        <div className={styles.footerInfo}>
          <ParentConnectorIcon />
          <strong>{parentLayerName}</strong>
        </div>
        <button
          className={styles.resetBtn}
          onClick={() =>
            update({
              color: { r: 0, g: 0, b: 0, a: 255 },
              opacity: 75,
              offsetX: 5,
              offsetY: 5,
              spread: 0,
              softness: 10,
            })
          }
        >
          Reset
        </button>
      </div>
    </div>
  );
}
