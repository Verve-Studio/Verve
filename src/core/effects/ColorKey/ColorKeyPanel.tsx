import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { ColorKeyAdjustmentLayer } from "@/types";
import { ColorSwatch } from "@/ux/widgets/ColorSwatch/ColorSwatch";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./ColorKeyPanel.module.scss";

interface ColorKeyPanelProps {
  layer: ColorKeyAdjustmentLayer;
  parentLayerName: string;
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}

async function pickWithEyedropper(): Promise<string | null> {
  if (!("EyeDropper" in window)) return null;
  try {
    const picker = new (
      window as unknown as {
        EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> };
      }
    ).EyeDropper();
    const result = await picker.open();
    return result.sRGBHex;
  } catch {
    return null;
  }
}

export function ColorKeyPanel({
  layer,
  parentLayerName,
}: ColorKeyPanelProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { keyColor, tolerance, softness, dilation } = layer.params;
  const pct = (v: number, lo: number, hi: number): string =>
    String((v - lo) / (hi - lo));

  const updateParams = (patch: Partial<typeof layer.params>): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...patch } },
    });
  };

  const handleEyedropper = async (): Promise<void> => {
    const hex = await pickWithEyedropper();
    if (hex) updateParams({ keyColor: hexToRgb(hex) });
  };

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Key Color</span>
        <div className={styles.colorRow}>
          <ColorSwatch
            value={rgbToHex(keyColor.r, keyColor.g, keyColor.b)}
            onChange={(hex) => updateParams({ keyColor: hexToRgb(hex) })}
            title="Key Color"
          />
          <button
            className={styles.eyedropperBtn}
            onClick={handleEyedropper}
            title="Sample key color from screen"
            aria-label="Pick key color from screen"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8.5 1.5 L10.5 3.5 L5 9 L3 9 L3 7 Z" />
              <line x1="7" y1="3" x2="9" y2="5" />
              <line x1="2" y1="10" x2="3" y2="9" />
            </svg>
          </button>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Tolerance</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={100}
            step={1}
            value={tolerance}
            style={{ "--pct": pct(tolerance, 0, 100) } as React.CSSProperties}
            onChange={(e) =>
              updateParams({ tolerance: Number(e.target.value) })
            }
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={tolerance}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              updateParams({
                tolerance: Math.min(100, Math.max(0, Math.round(v))),
              });
          }}
        />
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Edge Softness</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={100}
            step={1}
            value={softness}
            style={{ "--pct": pct(softness, 0, 100) } as React.CSSProperties}
            onChange={(e) => updateParams({ softness: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={softness}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              updateParams({
                softness: Math.min(100, Math.max(0, Math.round(v))),
              });
          }}
        />
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Expand Edge</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={20}
            step={1}
            value={dilation}
            style={{ "--pct": pct(dilation, 0, 20) } as React.CSSProperties}
            onChange={(e) => updateParams({ dilation: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={20}
          step={1}
          value={dilation}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              updateParams({
                dilation: Math.min(20, Math.max(0, Math.round(v))),
              });
          }}
        />
      </div>

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            updateParams({
              keyColor: { r: 0, g: 255, b: 0 },
              tolerance: 0,
              softness: 0,
              dilation: 0,
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
