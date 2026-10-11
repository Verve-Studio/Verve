import React from "react";
import styles from "./ToggleSwitch.module.scss";

export interface ToggleSwitchProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  title?: string;
}

/** A small on / off switch. */
export function ToggleSwitch({
  checked,
  onChange,
  disabled,
  title,
}: ToggleSwitchProps): React.JSX.Element {
  return (
    <label
      className={`${styles.toggle} ${disabled ? styles.toggleDisabled : ""}`}
      title={title}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={styles.toggleTrack} />
    </label>
  );
}
