import React, { useSyncExternalStore } from "react";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import { discardPrompt } from "@/ux/main/NodeEditor/automationFiles";
import styles from "./UnsavedWorkflowDialog.module.scss";

/** "Save changes to <workflow>?" before an automation workflow is replaced
 *  (New / Open Automation). Driven by `discardPrompt`. */
export function UnsavedWorkflowDialog(): React.JSX.Element | null {
  const name = useSyncExternalStore(discardPrompt.subscribe, discardPrompt.getSnapshot);
  return (
    <ModalDialog
      open={name !== null}
      title="Unsaved Automation"
      width={420}
      onClose={() => discardPrompt.answer("cancel")}
    >
      <div className={styles.body}>
        <p className={styles.message}>
          Save the changes to <strong>{name}</strong> before closing it?
        </p>
      </div>
      <div className={styles.footer}>
        <DialogButton onClick={() => discardPrompt.answer("discard")}>Don&apos;t Save</DialogButton>
        <span className={styles.spacer} />
        <DialogButton onClick={() => discardPrompt.answer("cancel")}>Cancel</DialogButton>
        <DialogButton onClick={() => discardPrompt.answer("save")} primary>
          Save
        </DialogButton>
      </div>
    </ModalDialog>
  );
}
