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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clampSide(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * The edited side `v` and the side derived from it (`v * ratio`), both kept
 * within [min, max]. When the derived side would exceed `max`, the edited side
 * shrinks instead so the aspect ratio holds (the dialogs would otherwise clamp
 * one side on OK and distort the image).
 */
function fitConstrained(
  v: number,
  ratio: number,
  min: number,
  max: number,
): [edited: number, derived: number] {
  let edited = clampSide(v, min, max);
  let derived = Math.round(edited * ratio);
  if (derived > max) {
    derived = max;
    edited = clampSide(max / ratio, min, max);
  }
  return [edited, Math.max(min, derived)];
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
      if (constrain && originHeight > 0 && originWidth > 0) {
        const [w, h] = fitConstrained(v, originHeight / originWidth, min, max);
        onWidthChange(w);
        onHeightChange(h);
      } else {
        onWidthChange(clampSide(v, min, max));
      }
    },
    [constrain, originWidth, originHeight, min, max, onWidthChange, onHeightChange],
  );

  const handleHeightChange = useCallback(
    (v: number): void => {
      if (constrain && originWidth > 0 && originHeight > 0) {
        const [h, w] = fitConstrained(v, originWidth / originHeight, min, max);
        onHeightChange(h);
        onWidthChange(w);
      } else {
        onHeightChange(clampSide(v, min, max));
      }
    },
    [constrain, originWidth, originHeight, min, max, onWidthChange, onHeightChange],
  );

  const handleConstrainToggle = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      onConstrainChange(e.target.checked);
      if (e.target.checked && originWidth > 0 && originHeight > 0) {
        // Snap height to match current width ratio (shrinking both if the
        // height would exceed max).
        const [w, h] = fitConstrained(width, originHeight / originWidth, min, max);
        if (w !== width) onWidthChange(w);
        onHeightChange(h);
      }
    },
    [onConstrainChange, originWidth, originHeight, min, max, width, onWidthChange, onHeightChange],
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
