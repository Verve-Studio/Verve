import React, { useEffect, useState } from "react";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import type { LayerColorSpace, PixelFormat } from "@/types";
import {
  ALL_LAYER_COLOR_SPACES,
  LAYER_COLOR_SPACE_LABEL,
} from "@/core/lut/layerColorSpace";
import styles from "./ConvertColorModeDialog.module.scss";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConvertColorModeDialogProps {
  open: boolean;
  fromFormat: PixelFormat;
  toFormat: PixelFormat;
  /** Called with the user-chosen source colour space when going rgba8 →
   *  rgba32f (uniform tag applied to every pixel layer in the doc).
   *  `undefined` for any other conversion direction. */
  onConfirm: (sourceColorSpace?: LayerColorSpace) => void;
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
  // Source colour-space picker is meaningful only when going rgba8 →
  // rgba32f. Default `'auto'` preserves the documented sRGB → linear gamma
  // decode for everyday content. Pick a camera log space when the rgba8
  // bytes hold log-encoded data — the gamma decode is skipped and each
  // converted layer is tagged with the chosen space.
  const showSourceSpacePicker =
    fromFormat === "rgba8" && toFormat === "rgba32f";
  const [sourceSpace, setSourceSpace] = useState<LayerColorSpace>("auto");
  // Reset when the dialog re-opens for a different conversion.
  useEffect(() => {
    if (open) setSourceSpace("auto");
  }, [open]);

  const handleConfirm = (): void => {
    onConfirm(showSourceSpacePicker ? sourceSpace : undefined);
  };

  return (
    <ModalDialog
      open={open}
      title="Convert Color Mode"
      width={420}
      onClose={onCancel}
    >
      <div className={styles.body}>
        <p className={styles.message}>
          Convert all layers from <strong>{formatLabel(fromFormat)}</strong> to{" "}
          <strong>{formatLabel(toFormat)}</strong>? This operation can be
          undone.
        </p>

        {showSourceSpacePicker && (
          <div className={styles.field}>
            <label className={styles.label}>Source colour space</label>
            <select
              className={styles.select}
              value={sourceSpace}
              onChange={(e) =>
                setSourceSpace(e.target.value as LayerColorSpace)
              }
            >
              {ALL_LAYER_COLOR_SPACES.map((s) => (
                <option key={s} value={s}>
                  {LAYER_COLOR_SPACE_LABEL[s]}
                </option>
              ))}
            </select>
            <p className={styles.hint}>
              Most files are <strong>sRGB</strong> — leave Auto. Pick a
              camera log space if the rgba8 bytes hold raw S-Log3 / LogC3 /
              etc. data; the sRGB gamma decode is skipped and each layer is
              tagged so the renderer can apply the matching IDT.
            </p>
          </div>
        )}

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
        <DialogButton onClick={handleConfirm} primary>
          Convert
        </DialogButton>
      </div>
    </ModalDialog>
  );
}
