import React from "react";
import styles from "./ContentAwareFillProgress.module.scss";

export interface ContentAwareFillProgressProps {
  /** When false the component renders nothing. */
  visible: boolean;
  /** Status label shown below the spinner. */
  label?: string;
  /** Secondary status label shown below the main label. */
  sublabel?: string;
}

export function ContentAwareFillProgress({
  visible,
  label = "Filling\u2026",
  sublabel,
}: ContentAwareFillProgressProps): React.JSX.Element | null {
  if (!visible) return null;
  return (
    <div className={styles.scrim}>
      <div className={styles.card}>
        <div className={styles.spinner} />
        <p className={styles.label}>{label}</p>
        <p className={styles.sublabel}>{sublabel ?? "Analyzing image\u2026"}</p>
      </div>
    </div>
  );
}
