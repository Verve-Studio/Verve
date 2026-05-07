import React from "react";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import styles from "./HdrLdrExportWarningDialog.module.scss";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HdrLdrExportWarningDialogProps {
  open: boolean;
  format: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function HdrLdrExportWarningDialog({
  open,
  format,
  onConfirm,
  onCancel,
}: HdrLdrExportWarningDialogProps): React.JSX.Element | null {
  return (
    <ModalDialog
      open={open}
      title="Export HDR Document"
      width={400}
      onClose={onCancel}
    >
      <div className={styles.body}>
        <p className={styles.warning}>
          Exporting an HDR document to <strong>{format.toUpperCase()}</strong>{" "}
          requires tone-mapping. The exported file will use the active
          tone-mapping operator. HDR values exceeding 1.0 will be clipped.
        </p>
      </div>
      <div className={styles.footer}>
        <DialogButton onClick={onCancel}>Cancel</DialogButton>
        <DialogButton onClick={onConfirm} primary>
          Export Anyway
        </DialogButton>
      </div>
    </ModalDialog>
  );
}
