import React, { useState, useEffect, useCallback } from "react";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import { SizeInputs } from "../../widgets/SizeInputs/SizeInputs";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import styles from "./ResizeCanvasDialog.module.scss";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Column 0–2, row 0–2 anchor position (Photoshop-style 3×3 grid). */
export type AnchorCol = 0 | 1 | 2;
export type AnchorRow = 0 | 1 | 2;

export interface ResizeCanvasSettings {
  width: number;
  height: number;
  /** Column anchor: 0 = left, 1 = center, 2 = right */
  anchorCol: AnchorCol;
  /** Row anchor: 0 = top, 1 = center, 2 = bottom */
  anchorRow: AnchorRow;
}

export interface ResizeCanvasDialogProps {
  open: boolean;
  currentWidth: number;
  currentHeight: number;
  onConfirm: (settings: ResizeCanvasSettings) => void;
  onCancel: () => void;
}

// ─── Anchor Grid ─────────────────────────────────────────────────────────────

interface AnchorGridProps {
  anchorCol: AnchorCol;
  anchorRow: AnchorRow;
  onChange: (col: AnchorCol, row: AnchorRow) => void;
}

function AnchorGrid({
  anchorCol,
  anchorRow,
  onChange,
}: AnchorGridProps): React.JSX.Element {
  const cells: Array<{ col: AnchorCol; row: AnchorRow }> = [
    { col: 0, row: 0 },
    { col: 1, row: 0 },
    { col: 2, row: 0 },
    { col: 0, row: 1 },
    { col: 1, row: 1 },
    { col: 2, row: 1 },
    { col: 0, row: 2 },
    { col: 1, row: 2 },
    { col: 2, row: 2 },
  ];

  // Arrow labels for each of the 9 cells
  const arrowMap: Record<string, string> = {
    "0,0": "↖",
    "1,0": "↑",
    "2,0": "↗",
    "0,1": "←",
    "1,1": "·",
    "2,1": "→",
    "0,2": "↙",
    "1,2": "↓",
    "2,2": "↘",
  };

  return (
    <div
      className={styles.anchorGrid}
      role="group"
      aria-label="Anchor position"
    >
      {cells.map(({ col, row }) => {
        const key = `${col},${row}`;
        const active = col === anchorCol && row === anchorRow;
        return (
          <button
            key={key}
            type="button"
            className={`${styles.anchorCell} ${active ? styles.anchorCellActive : ""}`}
            onClick={() => onChange(col, row)}
            aria-label={`Anchor ${key}`}
            aria-pressed={active}
          >
            {arrowMap[key]}
          </button>
        );
      })}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ResizeCanvasDialog({
  open,
  currentWidth,
  currentHeight,
  onConfirm,
  onCancel,
}: ResizeCanvasDialogProps): React.JSX.Element | null {
  const [width, setWidth] = useState(currentWidth);
  const [height, setHeight] = useState(currentHeight);
  const [constrain, setConstrain] = useState(false);
  const [anchorCol, setAnchorCol] = useState<AnchorCol>(1);
  const [anchorRow, setAnchorRow] = useState<AnchorRow>(1);

  // Reset each time dialog opens
  useEffect(() => {
    if (open) {
      setWidth(currentWidth);
      setHeight(currentHeight);
      setConstrain(false);
      setAnchorCol(1);
      setAnchorRow(1);
    }
  }, [open, currentWidth, currentHeight]);

  const handleAnchorChange = useCallback(
    (col: AnchorCol, row: AnchorRow): void => {
      setAnchorCol(col);
      setAnchorRow(row);
    },
    [],
  );

  const handleConfirm = useCallback((): void => {
    const w = Math.max(1, Math.min(8192, Math.round(width || 1)));
    const h = Math.max(1, Math.min(8192, Math.round(height || 1)));
    onConfirm({ width: w, height: h, anchorCol, anchorRow });
  }, [width, height, anchorCol, anchorRow, onConfirm]);

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

  const dw = width - currentWidth;
  const dh = height - currentHeight;

  return (
    <ModalDialog
      open={open}
      title="Resize Canvas"
      width={380}
      onClose={onCancel}
    >
      <div className={styles.body}>
        {/* ── Current size info ─────────────────────────────────────── */}
        <p className={styles.currentSize}>
          Current: {currentWidth} × {currentHeight} px
        </p>

        {/* ── New size + anchor side-by-side ────────────────────────── */}
        <div className={styles.row}>
          <div className={styles.sizeCol}>
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
          </div>

          <div className={styles.anchorCol}>
            <span className={styles.anchorLabel}>Anchor</span>
            <AnchorGrid
              anchorCol={anchorCol}
              anchorRow={anchorRow}
              onChange={handleAnchorChange}
            />
          </div>
        </div>

        {/* ── Delta hint ────────────────────────────────────────────── */}
        <p className={styles.deltaHint}>
          {dw === 0 && dh === 0
            ? "No change"
            : [
                dw !== 0 && `${dw > 0 ? "+" : ""}${dw}px width`,
                dh !== 0 && `${dh > 0 ? "+" : ""}${dh}px height`,
              ]
                .filter(Boolean)
                .join(", ")}
        </p>
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
