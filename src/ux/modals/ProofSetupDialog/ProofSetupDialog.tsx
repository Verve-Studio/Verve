// ─── Proof Setup dialog (Tier 3a/3b) ─────────────────────────────────────────
//
// Lets the user pick a proof profile (output device to simulate), toggle
// "Simulate Paper Color" / "Gamut Warning", and pick the gamut-warning
// alarm colour. The picker calls into useColorProfile.setProofProfile to
// load the file and build the composed proof LUT.
//
// Like ColorSettingsDialog this is a panel, not a draft — changes apply
// immediately to displayStore so the user sees the effect on the canvas
// while the dialog is open.

import React from "react";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import { parseProfileDescription } from "@/core/cms/iccProfile";
import { useDisplayStore } from "@/ux/main/Canvas/displayStore";
import styles from "./ProofSetupDialog.module.scss";

interface ProofSetupDialogProps {
  open: boolean;
  onClose: () => void;
  /** Opens an OS file picker, reads the .icc bytes, and builds the proof
   *  LUT — owned by the useColorProfile hook. */
  onPickProofProfile: () => Promise<void>;
  /** Clears the active proof profile. */
  onClearProofProfile: () => void;
  /** Toggles Photoshop's "Simulate Paper Color" and rebuilds the LUT. */
  onToggleSimulatePaperColor: () => Promise<void>;
  /** Toggles the gamut-warning overlay and rebuilds the LUT. */
  onToggleGamutWarning: () => Promise<void>;
}

export function ProofSetupDialog({
  open,
  onClose,
  onPickProofProfile,
  onClearProofProfile,
  onToggleSimulatePaperColor,
  onToggleGamutWarning,
}: ProofSetupDialogProps): React.JSX.Element | null {
  const display = useDisplayStore();
  const profileName = display.proofProfile
    ? (parseProfileDescription(display.proofProfile) ?? "Embedded (unnamed)")
    : "None";

  return (
    <ModalDialog open={open} title="Proof Setup" width={440} onClose={onClose}>
      <div className={styles.body}>
        {/* ── Profile ──────────────────────────────────────────────────── */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Profile to Simulate</div>
          <div className={styles.profileRow}>
            <div
              className={styles.profileName}
              title={profileName}
            >
              {profileName}
            </div>
            <DialogButton width="100px" onClick={() => void onPickProofProfile()}>
              Pick…
            </DialogButton>
            <DialogButton
              width="100px"
              onClick={onClearProofProfile}
              disabled={!display.proofProfile}
            >
              Clear
            </DialogButton>
          </div>
          <p className={styles.helpText}>
            Pick an ICC profile representing the output device (e.g. a printer
            profile) you want Verve to simulate on screen. The rendering
            intent comes from <strong>Image &rsaquo; Color Settings</strong>{" "}
            &mdash; "Convert" intent.
          </p>
        </div>

        <hr className={styles.divider} />

        {/* ── Options ──────────────────────────────────────────────────── */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Options</div>

          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={display.simulatePaperColor}
              disabled={!display.proofProfile}
              onChange={() => void onToggleSimulatePaperColor()}
            />
            <span>
              <strong>Simulate Paper Color</strong>
              <span className={styles.help}>
                Preserve the proof's white-point and black-point on screen
              </span>
            </span>
          </label>

          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={display.gamutWarningEnabled}
              disabled={!display.proofProfile}
              onChange={() => void onToggleGamutWarning()}
            />
            <span>
              <strong>Gamut Warning</strong>
              <span className={styles.help}>
                Paint out-of-proof-gamut pixels with a neutral grey
              </span>
            </span>
          </label>
        </div>
      </div>

      <div className={styles.footer}>
        <DialogButton onClick={onClose} primary>
          Close
        </DialogButton>
      </div>
    </ModalDialog>
  );
}
