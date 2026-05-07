import React, { useState, useEffect, useCallback } from "react";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import { SizeInputs } from "../../widgets/SizeInputs/SizeInputs";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import styles from "./ResizeImageDialog.module.scss";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ResizeFilter = "bilinear" | "nearest";

export interface ResizeImageSettings {
  width: number;
  height: number;
  filter: ResizeFilter;
}

export interface ResizeImageDialogProps {
  open: boolean;
  currentWidth: number;
  currentHeight: number;
  onConfirm: (settings: ResizeImageSettings) => void;
  onCancel: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ResizeImageDialog({
  open,
  currentWidth,
  currentHeight,
  onConfirm,
  onCancel,
}: ResizeImageDialogProps): React.JSX.Element | null {
  const [width, setWidth] = useState(currentWidth);
  const [height, setHeight] = useState(currentHeight);
  const [constrain, setConstrain] = useState(true);
  const [filter, setFilter] = useState<ResizeFilter>("bilinear");

  // Reset to current canvas size each time dialog opens
  useEffect(() => {
    if (open) {
      setWidth(currentWidth);
      setHeight(currentHeight);
      setConstrain(true);
      setFilter("bilinear");
    }
  }, [open, currentWidth, currentHeight]);

  const handleConfirm = useCallback((): void => {
    const w = Math.max(1, Math.min(8192, Math.round(width || 1)));
    const h = Math.max(1, Math.min(8192, Math.round(height || 1)));
    onConfirm({ width: w, height: h, filter });
  }, [width, height, filter, onConfirm]);

  // Enter = confirm
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Enter") {
        e.stopPropagation();
        handleConfirm();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, handleConfirm]);

  return (
    <ModalDialog
      open={open}
      title="Resize Image"
      width={360}
      onClose={onCancel}
    >
      <div className={styles.body}>
        {/* ── Current size info ─────────────────────────────────────── */}
        <p className={styles.currentSize}>
          Current: {currentWidth} × {currentHeight} px
        </p>

        <SizeInputs
          width={width}
          height={height}
          constrain={constrain}
          originWidth={currentWidth}
          originHeight={currentHeight}
          onWidthChange={setWidth}
          onHeightChange={setHeight}
          onConstrainChange={setConstrain}
        />

        <hr className={styles.divider} />

        {/* ── Resample filter ───────────────────────────────────────── */}
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Resample</label>
          <select
            className={styles.select}
            value={filter}
            onChange={(e) => setFilter(e.target.value as ResizeFilter)}
          >
            <option value="bilinear">Bilinear (smooth)</option>
            <option value="nearest">Nearest Neighbour (sharp)</option>
          </select>
        </div>
      </div>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <div className={styles.footer}>
        <DialogButton onClick={onCancel}>Cancel</DialogButton>
        <DialogButton onClick={handleConfirm} primary>
          OK
        </DialogButton>
      </div>
    </ModalDialog>
  );
}
