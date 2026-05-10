import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type {
  ColorBiasEffectLayer,
  ColorBiasMetric,
} from "./ColorBiasEffect";
import { ColorSwatch } from "@/ux/widgets/ColorSwatch/ColorSwatch";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./ColorBiasPanel.module.scss";

interface ColorBiasPanelProps {
  layer: ColorBiasEffectLayer;
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

export function ColorBiasPanel({
  layer,
  parentLayerName,
}: ColorBiasPanelProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const {
    targetColor,
    useSeparateOutput,
    outputColor,
    range,
    falloff,
    metric,
  } = layer.params;
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
    if (hex) updateParams({ targetColor: hexToRgb(hex) });
  };

  const handleOutputEyedropper = async (): Promise<void> => {
    const hex = await pickWithEyedropper();
    if (hex) updateParams({ outputColor: hexToRgb(hex) });
  };

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span
          className={styles.label}
          title={
            useSeparateOutput
              ? "Sample colour — pixels close to this colour are affected. They snap to the Output Color below."
              : "Target colour — pixels close to this colour snap to it."
          }
        >
          {useSeparateOutput ? "Sample Color" : "Target Color"}
        </span>
        <div className={styles.colorRow}>
          <ColorSwatch
            value={rgbToHex(targetColor.r, targetColor.g, targetColor.b)}
            onChange={(hex) => updateParams({ targetColor: hexToRgb(hex) })}
            title={
              useSeparateOutput
                ? "Sample colour"
                : "Target colour — pixels close to this snap to it"
            }
          />
          <button
            className={styles.eyedropperBtn}
            onClick={handleEyedropper}
            title="Pick from screen"
            aria-label="Pick from screen"
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
        <span
          className={styles.label}
          title="When on, affected pixels snap to the Output Color below instead of the sampled color. Useful for normalising muddy whites to pure white in one pass."
        >
          Separate Output
        </span>
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={useSeparateOutput}
            onChange={(e) =>
              updateParams({ useSeparateOutput: e.target.checked })
            }
          />
        </label>
      </div>

      {useSeparateOutput && (
        <div className={styles.row}>
          <span
            className={styles.label}
            title="Affected pixels snap to this colour."
          >
            Output Color
          </span>
          <div className={styles.colorRow}>
            <ColorSwatch
              value={rgbToHex(outputColor.r, outputColor.g, outputColor.b)}
              onChange={(hex) => updateParams({ outputColor: hexToRgb(hex) })}
              title="Output colour"
            />
            <button
              className={styles.eyedropperBtn}
              onClick={handleOutputEyedropper}
              title="Pick output colour from screen"
              aria-label="Pick output colour from screen"
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
      )}

      <div className={styles.row}>
        <span
          className={styles.label}
          title="Colour-space the distance is measured in. RGB is fast but channel-uneven. HSV decouples hue from brightness — best for pure hue shifts. LAB is perceptually uniform — best for finicky scans where 'looks the same' should mean 'small distance'."
        >
          Metric
        </span>
        <select
          className={styles.select}
          value={metric}
          onChange={(e) =>
            updateParams({ metric: e.target.value as ColorBiasMetric })
          }
        >
          <option value="rgb">RGB (Euclidean)</option>
          <option value="hsv">HSV (hue-aware)</option>
          <option value="lab">LAB (perceptual ΔE)</option>
        </select>
      </div>

      <div className={styles.row}>
        <span
          className={styles.label}
          title="How far from the target color a pixel can be and still get snapped. 0 = only exact matches; 100 = entire colour space."
        >
          Range
        </span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={100}
            step={1}
            value={range}
            style={{ "--pct": pct(range, 0, 100) } as React.CSSProperties}
            onChange={(e) => updateParams({ range: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={range}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              updateParams({
                range: Math.min(100, Math.max(0, Math.round(v))),
              });
          }}
        />
      </div>

      <div className={styles.row}>
        <span
          className={styles.label}
          title="The outermost X% of the range fades back to the original pixel. 0 = hard edge; 100 = the entire range is a soft transition."
        >
          Falloff
        </span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={100}
            step={1}
            value={falloff}
            style={{ "--pct": pct(falloff, 0, 100) } as React.CSSProperties}
            onChange={(e) => updateParams({ falloff: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={100}
          step={1}
          value={falloff}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              updateParams({
                falloff: Math.min(100, Math.max(0, Math.round(v))),
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
              targetColor: { r: 255, g: 255, b: 255 },
              useSeparateOutput: false,
              outputColor: { r: 255, g: 255, b: 255 },
              range: 10,
              falloff: 50,
              metric: "rgb",
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
