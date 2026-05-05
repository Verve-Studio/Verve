import React, { useEffect, useState } from "react";
import { displayStore } from "@/core/store/displayStore";
import type { ToneMappingOperator } from "@/types";
import type { PixelFormat } from "@/types";
import styles from "./ToneMappingControls.module.scss";

interface ToneMappingControlsProps {
  pixelFormat: PixelFormat;
}

const OPERATOR_LABELS: { value: ToneMappingOperator; label: string }[] = [
  { value: "reinhard", label: "Reinhard" },
  { value: "clamp", label: "Linear" },
];

export function ToneMappingControls({
  pixelFormat,
}: ToneMappingControlsProps): React.JSX.Element | null {
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

  if (pixelFormat !== "rgba32f") return null;

  const handleEvChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    displayStore.setEV(parseFloat(e.target.value));
  };

  const handleOperatorChange = (
    e: React.ChangeEvent<HTMLSelectElement>,
  ): void => {
    displayStore.setOperator(e.target.value as ToneMappingOperator);
  };

  const evDisplay = ev >= 0 ? `+${ev.toFixed(1)}` : ev.toFixed(1);

  return (
    <div className={styles.controls}>
      <select
        className={styles.operatorSelect}
        value={operator}
        onChange={handleOperatorChange}
        title="Tone-mapping operator"
      >
        {OPERATOR_LABELS.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <span className={styles.evLabel}>EV</span>
      <input
        type="range"
        className={styles.evSlider}
        min={-5}
        max={5}
        step={0.1}
        value={ev}
        onChange={handleEvChange}
        title={`Exposure: ${evDisplay} EV`}
      />
      <span className={styles.evValue}>{evDisplay}</span>
    </div>
  );
}
