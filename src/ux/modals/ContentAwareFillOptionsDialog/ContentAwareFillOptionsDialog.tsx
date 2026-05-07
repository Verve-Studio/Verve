import React, { useState, useEffect } from "react";
import { ModalDialog } from "@/ux/modals/ModalDialog/ModalDialog";
import { DialogButton } from "@/ux/widgets/DialogButton/DialogButton";
import styles from "./ContentAwareFillOptionsDialog.module.scss";

export interface ContentAwareFillOptionsDialogProps {
  open: boolean;
  mode: "fill" | "delete";
  onConfirm: (samplingRadius: number) => void;
  onCancel: () => void;
}

export function ContentAwareFillOptionsDialog({
  open,
  mode,
  onConfirm,
  onCancel,
}: ContentAwareFillOptionsDialogProps): React.JSX.Element | null {
  const [radius, setRadius] = useState(200);

  useEffect(() => {
    if (open) setRadius(200);
  }, [open]);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    onConfirm(radius);
  };

  const title = mode === "fill" ? "Content-Aware Fill" : "Content-Aware Delete";
  const primaryLabel = mode === "fill" ? "Fill" : "Delete";

  return (
    <ModalDialog open={open} title={title} width={296} onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <div className={styles.body}>
          <p className={styles.description}>
            Only pixels within this distance of the selection boundary will be
            used as source material. Set to 0 to sample the entire image.
          </p>
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>Sampling Radius</span>
            <span className={styles.fieldSpacer} />
            <input
              type="number"
              className={styles.numberInput}
              min={0}
              step={1}
              value={radius}
              onChange={(e) =>
                setRadius(Math.max(0, parseInt(e.target.value, 10) || 0))
              }
              autoFocus
            />
            <span className={styles.unit}>px</span>
          </div>
          {radius === 0 && (
            <p className={styles.zeroHint}>0 = sample entire image</p>
          )}
        </div>
        <div className={styles.footer}>
          <DialogButton onClick={onCancel} type="button">
            Cancel
          </DialogButton>
          <DialogButton primary type="submit">
            {primaryLabel}
          </DialogButton>
        </div>
      </form>
    </ModalDialog>
  );
}
