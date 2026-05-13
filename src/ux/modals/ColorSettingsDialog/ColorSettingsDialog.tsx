// ─── Color Settings dialog ───────────────────────────────────────────────────
//
// Tier-2c settings panel: lets the user change the global colour-management
// defaults. Edits write through `preferencesStore.set()` immediately, so
// "Close" is the only footer action — Cancel-on-a-settings-panel would be
// confusing (Photoshop's Color Settings has Cancel but its model is a draft;
// matching its draft semantics is over-engineering here).
//
// The working-space row is informational only — Tier 2 keeps the working
// space implicit (sRGB for rgba8, linear-sRGB for rgba32f). Tier 3 may
// expose a working-space picker; the row makes that future obvious.

import React from "react";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import {
  preferencesStore,
  usePreferences,
  type RenderingIntentPreference,
  type MissingProfilePolicy,
} from "@/core/store/preferencesStore";
import styles from "./ColorSettingsDialog.module.scss";

interface ColorSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

const INTENT_LABEL: Record<RenderingIntentPreference, string> = {
  perceptual: "Perceptual",
  "relative-colorimetric": "Relative Colorimetric",
  saturation: "Saturation",
  "absolute-colorimetric": "Absolute Colorimetric",
};

export function ColorSettingsDialog({
  open,
  onClose,
}: ColorSettingsDialogProps): React.JSX.Element | null {
  const prefs = usePreferences();

  return (
    <ModalDialog
      open={open}
      title="Color Settings"
      width={460}
      onClose={onClose}
    >
      <div className={styles.body}>
        {/* ── Working Space ────────────────────────────────────────────── */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Working Space</div>
          <p className={styles.helpText}>
            The internal colour space Verve uses for compositing and effects.
            Fixed per pixel format:
          </p>
          <ul className={styles.workingSpaceList}>
            <li>
              <span className={styles.kbd}>RGB/8</span> &mdash; sRGB
              IEC&nbsp;61966-2.1 (gamma-encoded)
            </li>
            <li>
              <span className={styles.kbd}>RGB/32&nbsp;Float</span> &mdash;
              linear-sRGB primaries, scene-linear
            </li>
          </ul>
        </div>

        <hr className={styles.divider} />

        {/* ── Rendering intents ────────────────────────────────────────── */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Rendering Intents</div>

          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel}>Import</label>
            <select
              className={styles.select}
              value={prefs.colorImportIntent}
              onChange={(e) =>
                preferencesStore.set({
                  colorImportIntent: e.target
                    .value as RenderingIntentPreference,
                })
              }
            >
              {(Object.keys(INTENT_LABEL) as RenderingIntentPreference[]).map(
                (k) => (
                  <option key={k} value={k}>
                    {INTENT_LABEL[k]}
                  </option>
                ),
              )}
            </select>
          </div>

          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel}>Convert</label>
            <select
              className={styles.select}
              value={prefs.colorConvertIntent}
              onChange={(e) =>
                preferencesStore.set({
                  colorConvertIntent: e.target
                    .value as RenderingIntentPreference,
                })
              }
            >
              {(Object.keys(INTENT_LABEL) as RenderingIntentPreference[]).map(
                (k) => (
                  <option key={k} value={k}>
                    {INTENT_LABEL[k]}
                  </option>
                ),
              )}
            </select>
          </div>

          <div className={styles.fieldRow}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={prefs.colorUseBpc}
                onChange={(e) =>
                  preferencesStore.set({ colorUseBpc: e.target.checked })
                }
              />
              <span>Use Black Point Compensation</span>
            </label>
          </div>
        </div>

        <hr className={styles.divider} />

        {/* ── Missing-profile policy ────────────────────────────────────── */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Missing Profile Policy</div>
          <p className={styles.helpText}>
            What to do when an image arrives without an embedded ICC profile.
          </p>
          <div className={styles.fieldRow}>
            <select
              className={styles.select}
              value={prefs.colorMissingProfilePolicy}
              onChange={(e) =>
                preferencesStore.set({
                  colorMissingProfilePolicy: e.target
                    .value as MissingProfilePolicy,
                })
              }
            >
              <option value="assume-working-space">
                Assume working-space profile
              </option>
              <option value="ask" disabled>
                Ask each time (coming soon)
              </option>
            </select>
          </div>
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
