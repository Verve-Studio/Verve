import React from "react";
import styles from "./distortionPanel.module.scss";

export type EdgeMode = "transparent" | "clamp" | "mirror";

export const EDGE_MODES: EdgeMode[] = ["transparent", "clamp", "mirror"];

const pctOf = (v: number, min: number, max: number): string =>
  String((v - min) / (max - min));

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  suffix?: string;
}

export function DistortionSlider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
}: SliderProps): React.JSX.Element {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div className={styles.trackWrap}>
        <input
          type="range"
          className={styles.track}
          min={min}
          max={max}
          step={step}
          value={Math.max(min, Math.min(max, value))}
          style={{ "--pct": pctOf(value, min, max) } as React.CSSProperties}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      <input
        type="number"
        className={styles.numInput}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (!isNaN(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
      />
      {suffix !== undefined && (
        <span className={styles.unitLabel}>{suffix}</span>
      )}
    </div>
  );
}

interface SegmentedProps<T extends string> {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  formatLabel?: (v: T) => string;
}

export function DistortionSegmented<T extends string>({
  label,
  options,
  value,
  onChange,
  formatLabel,
}: SegmentedProps<T>): React.JSX.Element {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div className={styles.segmented}>
        {options.map((opt) => (
          <button
            key={opt}
            className={`${styles.segBtn}${value === opt ? ` ${styles.segBtnActive}` : ""}`}
            onClick={() => onChange(opt)}
          >
            {formatLabel
              ? formatLabel(opt)
              : opt.charAt(0).toUpperCase() + opt.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}
