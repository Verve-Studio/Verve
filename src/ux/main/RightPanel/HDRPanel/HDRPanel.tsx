import React, { useEffect, useState } from "react";
import { useAppContext } from "@/core/store/AppContext";
import { displayStore } from "@/core/store/displayStore";
import type { ToneMappingOperator } from "@/types";
import styles from "./HDRPanel.module.scss";

const OPERATOR_OPTIONS: { value: ToneMappingOperator; label: string }[] = [
  { value: "clamp", label: "Linear (Clamp)" },
  { value: "reinhard", label: "Reinhard" },
];

export function HDRPanel(): React.JSX.Element {
  const { state } = useAppContext();
  const isHdr = state.pixelFormat === "rgba32f";

  const [ev, setEv] = useState(displayStore.exposureEV);
  const [operator, setOperator] = useState<ToneMappingOperator>(
    displayStore.toneMappingOperator,
  );

  useEffect(() => {
    const onUpdate = (): void => {
      setEv(displayStore.exposureEV);
      setOperator(displayStore.toneMappingOperator);
    };
    displayStore.subscribe(onUpdate);
    return () => displayStore.unsubscribe(onUpdate);
  }, []);

  const handleEvChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    displayStore.setEV(parseFloat(e.target.value));
  };

  const handleOperatorChange = (
    e: React.ChangeEvent<HTMLSelectElement>,
  ): void => {
    displayStore.setOperator(e.target.value as ToneMappingOperator);
  };

  const handleEvReset = (): void => {
    displayStore.setEV(0);
  };

  const evPct = (ev + 5) / 10;

  return (
    <div className={styles.panel} aria-disabled={!isHdr}>
      {!isHdr && (
        <p className={styles.hint}>Available in Float32 color mode only.</p>
      )}

      <div className={[styles.row, !isHdr ? styles.disabled : ""].join(" ")}>
        <label className={styles.label}>View Transform</label>
        <select
          className={styles.select}
          value={operator}
          onChange={handleOperatorChange}
          disabled={!isHdr}
          title="Tone-mapping operator for viewport preview"
        >
          {OPERATOR_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className={[styles.row, !isHdr ? styles.disabled : ""].join(" ")}>
        <label className={styles.label}>Exposure</label>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            style={{ "--pct": evPct } as React.CSSProperties}
            min={-5}
            max={5}
            step={0.1}
            value={ev}
            onChange={handleEvChange}
            disabled={!isHdr}
            title={`Exposure: ${ev >= 0 ? "+" : ""}${ev.toFixed(1)} EV`}
          />
        </div>
        <span
          className={styles.value}
          onDoubleClick={handleEvReset}
          title="Double-click to reset"
        >
          {ev >= 0 ? "+" : ""}
          {ev.toFixed(1)}
        </span>
      </div>
    </div>
  );
}
