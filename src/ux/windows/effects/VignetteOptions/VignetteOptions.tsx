import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { VignetteAdjustmentLayer } from "@/types";
import { ColorSwatch } from "@/ux/widgets/ColorSwatch/ColorSwatch";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./VignetteOptions.module.scss";

interface VignetteOptionsProps {
  layer: VignetteAdjustmentLayer;
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

const pct = (v: number, lo: number, hi: number): string =>
  String((v - lo) / (hi - lo));

export function VignetteOptions({
  layer,
  parentLayerName,
}: VignetteOptionsProps): React.JSX.Element {
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
      {/* Shape */}
      <div className={styles.row}>
        <span className={styles.label}>Shape</span>
        <div className={styles.segmented}>
          {(["ellipse", "rectangle"] as const).map((s) => (
            <button
              key={s}
              className={`${styles.segBtn} ${p.shape === s ? styles.segBtnActive : ""}`}
              onClick={() => update({ shape: s })}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Color */}
      <div className={styles.row}>
        <span className={styles.label}>Color</span>
        <ColorSwatch
          value={hexValue}
          onChange={(hex) => {
            const rgb = hexToRgb(hex);
            if (rgb) update({ color: rgb });
          }}
          title="Vignette color"
        />
        <input
          type="text"
          className={styles.hexInput}
          value={hexValue.toUpperCase()}
          onChange={(e) => {
            const rgb = hexToRgb(e.target.value);
            if (rgb) update({ color: rgb });
          }}
          maxLength={7}
          spellCheck={false}
        />
        <span className={styles.unitLabel} />
      </div>

      {/* Spread */}
      <div className={styles.row}>
        <span className={styles.label}>Spread</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={1}
            step={0.01}
            value={p.spread}
            style={{ "--pct": pct(p.spread, 0, 1) } as React.CSSProperties}
            onChange={(e) => update({ spread: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={Math.round(p.spread * 100)}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              update({ spread: Math.min(1, Math.max(0, v / 100)) });
          }}
        />
        <span className={styles.unitLabel}>%</span>
      </div>

      {/* Softness */}
      <div className={styles.row}>
        <span className={styles.label}>Softness</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={1}
            step={0.01}
            value={p.softness}
            style={{ "--pct": pct(p.softness, 0, 1) } as React.CSSProperties}
            onChange={(e) => update({ softness: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={Math.round(p.softness * 100)}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              update({ softness: Math.min(1, Math.max(0, v / 100)) });
          }}
        />
        <span className={styles.unitLabel}>%</span>
      </div>

      {/* Opacity */}
      <div className={styles.row}>
        <span className={styles.label}>Opacity</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={1}
            step={0.01}
            value={p.opacity}
            style={{ "--pct": pct(p.opacity, 0, 1) } as React.CSSProperties}
            onChange={(e) => update({ opacity: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={Math.round(p.opacity * 100)}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              update({ opacity: Math.min(1, Math.max(0, v / 100)) });
          }}
        />
        <span className={styles.unitLabel}>%</span>
      </div>

      {/* Roundness — only for rectangle */}
      {p.shape === "rectangle" && (
        <div className={styles.row}>
          <span className={styles.label}>Roundness</span>
          <div className={styles.trackWrap}>
            <input
              type="range"
              className={styles.track}
              min={0}
              max={1}
              step={0.01}
              value={p.roundness}
              style={{ "--pct": pct(p.roundness, 0, 1) } as React.CSSProperties}
              onChange={(e) => update({ roundness: Number(e.target.value) })}
            />
          </div>
          <input
            type="number"
            className={styles.numInput}
            min={0}
            max={100}
            step={1}
            value={Math.round(p.roundness * 100)}
            onChange={(e) => {
              const v = e.target.valueAsNumber;
              if (!isNaN(v))
                update({ roundness: Math.min(1, Math.max(0, v / 100)) });
            }}
          />
          <span className={styles.unitLabel}>%</span>
        </div>
      )}

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            update({
              shape: "ellipse",
              spread: 0.55,
              softness: 0.5,
              opacity: 0.75,
              color: { r: 0, g: 0, b: 0 },
              roundness: 0.6,
            })
          }
          title="Reset to defaults"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
