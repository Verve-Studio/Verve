import React, { useCallback } from "react";
import { useAppContext } from "@/core/store/AppContext";
import type {
  ColorGradingAdjustmentLayer,
  ColorGradingWheelParams,
} from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import { ColorWheelWidget } from "@/ux/widgets/ColorWheelWidget/ColorWheelWidget";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import styles from "./ColorGradingPanel.module.scss";

// ─── Props ────────────────────────────────────────────────────────────────────

interface ColorGradingPanelProps {
  layer: ColorGradingAdjustmentLayer;
  parentLayerName: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ColorGradingPanel({
  layer,
  parentLayerName,
}: ColorGradingPanelProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { params } = layer;

  const update = useCallback(
    <K extends keyof typeof params>(field: K, val: (typeof params)[K]) => {
      dispatch({
        type: "UPDATE_ADJUSTMENT_LAYER",
        payload: { ...layer, params: { ...params, [field]: val } },
      });
    },
    [dispatch, layer, params],
  );

  const updateWheel = useCallback(
    (
      wheel: "lift" | "gamma" | "gain" | "offset",
      val: ColorGradingWheelParams,
    ) => {
      update(wheel, val);
    },
    [update],
  );

  return (
    <div className={styles.content}>
      {/* ── Top strip ── */}
      <div className={styles.ctrlStrip}>
        <div className={styles.col}>
          <span className={styles.label}>Temp</span>
          <SliderInput
            value={params.temp}
            min={1000}
            max={12000}
            step={100}
            suffix="K"
            onChange={(v) => update("temp", v)}
          />
        </div>
        <div className={styles.col}>
          <span className={styles.label}>Tint</span>
          <SliderInput
            value={params.tint}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => update("tint", v)}
          />
        </div>
        <div className={styles.col}>
          <span className={styles.label}>Contrast</span>
          <SliderInput
            value={params.contrast}
            min={0}
            max={2}
            step={0.01}
            onChange={(v) => update("contrast", v)}
          />
        </div>
        <div className={styles.col}>
          <span className={styles.label}>Pivot</span>
          <SliderInput
            value={params.pivot}
            min={0}
            max={1}
            step={0.001}
            onChange={(v) => update("pivot", v)}
          />
        </div>
        <div className={styles.col}>
          <span className={styles.label}>Mid/Detail</span>
          <SliderInput
            value={params.midDetail}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => update("midDetail", v)}
          />
        </div>
      </div>

      {/* ── Wheels row ── */}
      <div className={styles.wheelsRow}>
        <ColorWheelWidget
          label="Lift"
          value={params.lift}
          onChange={(v) => updateWheel("lift", v)}
        />
        <ColorWheelWidget
          label="Gamma"
          value={params.gamma}
          onChange={(v) => updateWheel("gamma", v)}
        />
        <ColorWheelWidget
          label="Gain"
          value={params.gain}
          onChange={(v) => updateWheel("gain", v)}
        />
        <ColorWheelWidget
          label="Offset"
          value={params.offset}
          onChange={(v) => updateWheel("offset", v)}
        />
      </div>

      {/* ── Bottom strip ── */}
      <div className={styles.ctrlStrip}>
        <div className={styles.col}>
          <span className={styles.label}>Color Boost</span>
          <SliderInput
            value={params.colorBoost}
            min={0}
            max={100}
            step={1}
            onChange={(v) => update("colorBoost", v)}
          />
        </div>
        <div className={styles.col}>
          <span className={styles.label}>Shadows</span>
          <SliderInput
            value={params.shadows}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => update("shadows", v)}
          />
        </div>
        <div className={styles.col}>
          <span className={styles.label}>Highlights</span>
          <SliderInput
            value={params.highlights}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => update("highlights", v)}
          />
        </div>
        <div className={styles.col}>
          <span className={styles.label}>Saturation</span>
          <SliderInput
            value={params.saturation}
            min={0}
            max={100}
            step={1}
            onChange={(v) => update("saturation", v)}
          />
        </div>
        <div className={styles.col}>
          <span className={styles.label}>Hue</span>
          <SliderInput
            value={params.hue}
            min={0}
            max={100}
            step={1}
            onChange={(v) => update("hue", v)}
          />
        </div>
        <div className={styles.col}>
          <span className={styles.label}>Lum Mix</span>
          <SliderInput
            value={params.lumMix}
            min={0}
            max={100}
            step={1}
            onChange={(v) => update("lumMix", v)}
          />
        </div>
      </div>

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          <span className={styles.footerText}>
            Applies to <strong>{parentLayerName}</strong>
          </span>
        </span>
      </div>
    </div>
  );
}
