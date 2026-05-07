import React, { useCallback } from "react";
import { SliderInput } from "../SliderInput/SliderInput";
import styles from "./SizeInputs.module.scss";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SizeInputsProps {
  width: number;
  height: number;
  constrain: boolean;
  /** Original width used for aspect-ratio calculation. */
  originWidth: number;
  /** Original height used for aspect-ratio calculation. */
  originHeight: number;
  onWidthChange: (w: number) => void;
  onHeightChange: (h: number) => void;
  onConstrainChange: (constrain: boolean) => void;
  min?: number;
  max?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SizeInputs({
  width,
  height,
  constrain,
  originWidth,
  originHeight,
  onWidthChange,
  onHeightChange,
  onConstrainChange,
  min = 1,
  max = 8192,
}: SizeInputsProps): React.JSX.Element {
  const handleWidthChange = useCallback(
    (v: number): void => {
      const w = Math.max(min, Math.round(v));
      onWidthChange(w);
      if (constrain && originHeight > 0 && originWidth > 0) {
        onHeightChange(
          Math.max(min, Math.round((w * originHeight) / originWidth)),
        );
      }
    },
    [constrain, originWidth, originHeight, min, onWidthChange, onHeightChange],
  );

  const handleHeightChange = useCallback(
    (v: number): void => {
      const h = Math.max(min, Math.round(v));
      onHeightChange(h);
      if (constrain && originWidth > 0 && originHeight > 0) {
        onWidthChange(
          Math.max(min, Math.round((h * originWidth) / originHeight)),
        );
      }
    },
    [constrain, originWidth, originHeight, min, onWidthChange, onHeightChange],
  );

  const handleConstrainToggle = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      onConstrainChange(e.target.checked);
      if (e.target.checked && originWidth > 0 && originHeight > 0) {
        // Snap height to match current width ratio
        onHeightChange(
          Math.max(min, Math.round((width * originHeight) / originWidth)),
        );
      }
    },
    [onConstrainChange, originWidth, originHeight, min, width, onHeightChange],
  );

  const aspectRatio =
    originWidth > 0 && originHeight > 0
      ? (originWidth / originHeight).toFixed(3)
      : "—";

  return (
    <div className={styles.sizeInputs}>
      {/* ── Width ────────────────────────────────────────────────── */}
      <div className={styles.fieldRow}>
        <label className={styles.fieldLabel}>Width</label>
        <SliderInput
          value={width}
          min={min}
          max={max}
          inputWidth={60}
          suffix="px"
          onChange={handleWidthChange}
        />
      </div>

      {/* ── Constrain ────────────────────────────────────────────── */}
      <div className={styles.constrainRow}>
        <div className={styles.chainLine} />
        <label className={styles.constrainLabel}>
          <input
            type="checkbox"
            className={styles.constrainCheck}
            checked={constrain}
            onChange={handleConstrainToggle}
          />
          Constrain
          <span className={styles.aspectHint}>({aspectRatio})</span>
        </label>
        <div className={styles.chainLine} />
      </div>

      {/* ── Height ───────────────────────────────────────────────── */}
      <div className={styles.fieldRow}>
        <label className={styles.fieldLabel}>Height</label>
        <SliderInput
          value={height}
          min={min}
          max={max}
          inputWidth={60}
          suffix="px"
          onChange={handleHeightChange}
        />
      </div>
    </div>
  );
}
