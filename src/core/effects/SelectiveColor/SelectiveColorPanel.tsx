import React, { useState } from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { SelectiveColorEffectLayer } from "@/core/effects/SelectiveColor/SelectiveColorEffect";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./SelectiveColorPanel.module.scss";

interface SelectiveColorPanelProps {
  layer: SelectiveColorEffectLayer;
  parentLayerName: string;
}

type RangeKey =
  | "reds"
  | "yellows"
  | "greens"
  | "cyans"
  | "blues"
  | "magentas"
  | "whites"
  | "neutrals"
  | "blacks";

const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: "reds", label: "Reds" },
  { value: "yellows", label: "Yellows" },
  { value: "greens", label: "Greens" },
  { value: "cyans", label: "Cyans" },
  { value: "blues", label: "Blues" },
  { value: "magentas", label: "Magentas" },
  { value: "whites", label: "Whites" },
  { value: "neutrals", label: "Neutrals" },
  { value: "blacks", label: "Blacks" },
];

type ChannelKey = "cyan" | "magenta" | "yellow" | "black";

const CHANNEL_CONFIG: { key: ChannelKey; label: string; trackClass: string }[] =
  [
    { key: "cyan", label: "Cyan", trackClass: "trackCyan" },
    { key: "magenta", label: "Magenta", trackClass: "trackMagenta" },
    { key: "yellow", label: "Yellow", trackClass: "trackYellow" },
    { key: "black", label: "Black", trackClass: "trackBlack" },
  ];

const RANGE_COLORS: Record<string, string> = {
  reds: "#cc3333",
  yellows: "#ccaa00",
  greens: "#33aa33",
  cyans: "#00aaaa",
  blues: "#3366cc",
  magentas: "#aa33aa",
  whites: "#dddddd",
  neutrals: "#888888",
  blacks: "#333333",
};

export function SelectiveColorPanel({
  layer,
  parentLayerName,
}: SelectiveColorPanelProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const [activeRange, setActiveRange] = useState<RangeKey>("reds");

  const pct = (v: number, min: number, max: number): string =>
    String((v - min) / (max - min));

  const currentRange = layer.params[activeRange];

  const handleSliderChange = (channelKey: ChannelKey, value: number): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: {
        ...layer,
        params: {
          ...layer.params,
          [activeRange]: {
            ...currentRange,
            [channelKey]: value,
          },
        },
      },
    });
  };

  const handleReset = (): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: {
        ...layer,
        params: {
          ...layer.params,
          [activeRange]: { cyan: 0, magenta: 0, yellow: 0, black: 0 },
        },
      },
    });
  };

  const handleModeChange = (mode: "relative" | "absolute"): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, mode } },
    });
  };

  return (
    <div className={styles.content}>
      <div className={styles.rangeRow}>
        <span className={styles.rangeLabel}>Colors:</span>
        <span
          className={styles.rangeSwatch}
          style={{ background: RANGE_COLORS[activeRange] }}
        />
        <select
          className={styles.rangeSelect}
          value={activeRange}
          onChange={(e) => setActiveRange(e.target.value as RangeKey)}
        >
          {RANGE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {CHANNEL_CONFIG.map(({ key, label, trackClass }) => (
        <div key={key} className={styles.row}>
          <span className={styles.label}>{label}</span>
          <div className={styles.trackWrap}>
            <input
              type="range"
              className={`${styles.track} ${styles[trackClass as keyof typeof styles]}`}
              min={-100}
              max={100}
              step={1}
              value={currentRange[key]}
              style={
                {
                  "--pct": pct(currentRange[key], -100, 100),
                } as React.CSSProperties
              }
              onChange={(e) => handleSliderChange(key, Number(e.target.value))}
            />
            <div className={styles.zeroTick} />
          </div>
          <input
            type="number"
            className={styles.numInput}
            min={-100}
            max={100}
            step={1}
            value={currentRange[key]}
            onChange={(e) => {
              const v = e.target.valueAsNumber;
              if (!isNaN(v))
                handleSliderChange(
                  key,
                  Math.min(100, Math.max(-100, Math.round(v))),
                );
            }}
          />
        </div>
      ))}

      <div className={styles.modeRow}>
        <label className={styles.radioOption}>
          <input
            type="radio"
            name={`sel-mode-${layer.id}`}
            value="relative"
            checked={layer.params.mode === "relative"}
            onChange={() => handleModeChange("relative")}
          />
          Relative
        </label>
        <label className={styles.radioOption}>
          <input
            type="radio"
            name={`sel-mode-${layer.id}`}
            value="absolute"
            checked={layer.params.mode === "absolute"}
            onChange={() => handleModeChange("absolute")}
          />
          Absolute
        </label>
      </div>

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={handleReset}
          title="Reset current range to defaults"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
