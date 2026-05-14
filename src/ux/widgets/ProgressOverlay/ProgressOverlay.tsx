import React from "react";
import styles from "./ProgressOverlay.module.scss";

export interface ProgressOverlayProps {
  /** When false the component renders nothing. */
  visible: boolean;
  /** Primary status label shown below the spinner. */
  label?: string;
  /** Secondary status label shown below the main label. */
  sublabel?: string;
}

/** Modal scrim + centred card with a spinner and two status lines. Used for
 *  long-running operations that block the canvas (Content-Aware Fill, AI
 *  Rescale, Restore, Auto-Mask, Object Removal, …). Stateless — the caller
 *  owns the visibility flag and the label strings. */
export function ProgressOverlay({
  visible,
  label = "Working…",
  sublabel,
}: ProgressOverlayProps): React.JSX.Element | null {
  if (!visible) return null;
  return (
    <div className={styles.scrim}>
      <div className={styles.card}>
        <div className={styles.spinner} />
        <p className={styles.label}>{label}</p>
        {sublabel !== undefined && (
          <p className={styles.sublabel}>{sublabel}</p>
        )}
      </div>
    </div>
  );
}
