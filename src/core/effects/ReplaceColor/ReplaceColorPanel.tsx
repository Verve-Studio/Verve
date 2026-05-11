import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { ReplaceColorEffectLayer } from "@/core/effects/ReplaceColor/ReplaceColorEffect";
import { ColorSwatch } from "@/ux/widgets/ColorSwatch/ColorSwatch";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./ReplaceColorPanel.module.scss";

interface ReplaceColorPanelProps {
  layer: ReplaceColorEffectLayer;
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

export function ReplaceColorPanel({
  layer,
  parentLayerName,
}: ReplaceColorPanelProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { originalColor, targetColor, hueRange, amount } = layer.params;
  const pct = (v: number, lo: number, hi: number): string =>
    String((v - lo) / (hi - lo));

  const updateParams = (patch: Partial<typeof layer.params>): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...patch } },
    });
  };

  const handleOriginalEyedropper = async (): Promise<void> => {
    const hex = await pickWithEyedropper();
    if (hex) updateParams({ originalColor: hexToRgb(hex) });
  };

  const handleTargetEyedropper = async (): Promise<void> => {
    const hex = await pickWithEyedropper();
    if (hex) updateParams({ targetColor: hexToRgb(hex) });
  };

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Original</span>
        <div className={styles.colorRow}>
          <ColorSwatch
            value={rgbToHex(originalColor.r, originalColor.g, originalColor.b)}
            onChange={(hex) => updateParams({ originalColor: hexToRgb(hex) })}
            title="Original color (the colour to match in the image)"
          />
          <button
            className={styles.eyedropperBtn}
            onClick={handleOriginalEyedropper}
            title="Pick original color from screen"
            aria-label="Pick original color"
          >
            <EyedropperIcon />
          </button>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Target</span>
        <div className={styles.colorRow}>
          <ColorSwatch
            value={rgbToHex(targetColor.r, targetColor.g, targetColor.b)}
            onChange={(hex) => updateParams({ targetColor: hexToRgb(hex) })}
            title="Target color (the colour to replace with)"
          />
          <button
            className={styles.eyedropperBtn}
            onClick={handleTargetEyedropper}
            title="Pick target color from screen"
            aria-label="Pick target color"
          >
            <EyedropperIcon />
          </button>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Hue Range</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={180}
            step={1}
            value={hueRange}
            style={{ "--pct": pct(hueRange, 0, 180) } as React.CSSProperties}
            onChange={(e) => updateParams({ hueRange: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={180}
          step={1}
          value={hueRange}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              updateParams({
                hueRange: Math.min(180, Math.max(0, Math.round(v))),
              });
          }}
        />
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Amount</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={100}
            step={1}
            value={amount}
            style={{ "--pct": pct(amount, 0, 100) } as React.CSSProperties}
            onChange={(e) => updateParams({ amount: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={amount}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              updateParams({
                amount: Math.min(100, Math.max(0, Math.round(v))),
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
              originalColor: { r: 170, g: 80, b: 80 },
              targetColor: { r: 80, g: 110, b: 170 },
              hueRange: 30,
              amount: 100,
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

function EyedropperIcon(): React.JSX.Element {
  return (
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
  );
}
