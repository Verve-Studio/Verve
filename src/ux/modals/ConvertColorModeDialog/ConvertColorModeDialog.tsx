import React from "react";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import type { PixelFormat } from "@/types";
import styles from "./ConvertColorModeDialog.module.scss";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConvertColorModeDialogProps {
  open: boolean;
  fromFormat: PixelFormat;
  toFormat: PixelFormat;
  onConfirm: () => void;
  onCancel: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatLabel(fmt: PixelFormat): string {
  if (fmt === "rgba8") return "RGB/8";
  if (fmt === "rgba32f") return "RGB/32 Float";
  return "Indexed/8";
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ConvertColorModeDialog({
  open,
  fromFormat,
  toFormat,
  onConfirm,
  onCancel,
}: ConvertColorModeDialogProps): React.JSX.Element | null {
  const showHdrWarning = fromFormat === "rgba32f" && toFormat !== "rgba32f";
  const showIndexedWarning = toFormat === "indexed8";

  return (
    <ModalDialog
      open={open}
      title="Convert Color Mode"
      width={400}
      onClose={onCancel}
    >
      <div className={styles.body}>
        <p className={styles.message}>
          Convert all layers from <strong>{formatLabel(fromFormat)}</strong> to{" "}
          <strong>{formatLabel(toFormat)}</strong>? This operation can be
          undone.
        </p>

        {showHdrWarning && (
          <div className={styles.warning}>
            Out-of-range HDR values will be clamped to 0–255.
          </div>
        )}

        {showIndexedWarning && (
          <div className={styles.warning}>
            All adjustment layers will be suspended in Indexed/8 mode.
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <DialogButton onClick={onCancel}>Cancel</DialogButton>
        <DialogButton onClick={onConfirm} primary>
          Convert
        </DialogButton>
      </div>
    </ModalDialog>
  );
}
