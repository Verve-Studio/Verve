import React, { useEffect, useState } from "react";
import { useAppContext } from "@/core/store/AppContext";
import { displayStore } from "@/ux/main/Canvas/displayStore";
import { lutStore, type LutTransform } from "@/core/lut";
import { LutSelectOptions } from "@/core/lut/lutSelectOptions";
import type { ToneMappingOperator } from "@/types";
import styles from "./DisplayPanel.module.scss";

// ─── Display panel ───────────────────────────────────────────────────────────
//
// Canvas-only display controls — never touch pixel data.
//
//   - View Transform: choose a LUT (Filmic/AgX/HLG/Rec.2020/loaded LUTs/OCIO
//     colour-spaces) or "None" to use the analytic tone-map operator.
//   - Tone Map: only meaningful when View Transform is None and the doc is
//     rgba32f — controls how out-of-range linear values are compressed
//     before the sRGB encode.
//   - Exposure: pre-tone-map gain in EV stops. Useful any time the doc is
//     rgba32f, regardless of view transform.

const OPERATOR_OPTIONS: { value: ToneMappingOperator; label: string }[] = [
  { value: "clamp", label: "Linear (Clamp)" },
  { value: "reinhard", label: "Reinhard" },
];

function useLutList(): LutTransform[] {
  const [list, setList] = useState<LutTransform[]>(() => lutStore.all());
  useEffect(() => lutStore.subscribe(() => setList(lutStore.all())), []);
  return list;
}

export function DisplayPanel(): React.JSX.Element {
  const { state } = useAppContext();
  const isHdr = state.pixelFormat === "rgba32f";
  const luts = useLutList();

  const [ev, setEv] = useState(displayStore.exposureEV);
  const [operator, setOperator] = useState<ToneMappingOperator>(
    displayStore.toneMappingOperator,
  );
  const [viewLutId, setViewLutId] = useState<string | null>(
    displayStore.viewTransformLutId,
  );

  useEffect(() => {
    const onUpdate = (): void => {
      setEv(displayStore.exposureEV);
      setOperator(displayStore.toneMappingOperator);
      setViewLutId(displayStore.viewTransformLutId);
    };
    displayStore.subscribe(onUpdate);
    return () => displayStore.unsubscribe(onUpdate);
  }, []);

  const handleViewLutChange = (
    e: React.ChangeEvent<HTMLSelectElement>,
  ): void => {
    const id = e.target.value;
    displayStore.setViewTransformLut(id === "" ? null : id);
  };

  const handleOperatorChange = (
    e: React.ChangeEvent<HTMLSelectElement>,
  ): void => {
    displayStore.setOperator(e.target.value as ToneMappingOperator);
  };

  const handleEvChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    displayStore.setEV(parseFloat(e.target.value));
  };
  const handleEvReset = (): void => displayStore.setEV(0);

  const evPct = (ev + 5) / 10;
  const showOperatorRow = viewLutId === null;

  return (
    <div className={styles.panel}>
      <div className={styles.row}>
        <label className={styles.label}>View Transform</label>
        <select
          className={styles.select}
          value={viewLutId ?? ""}
          onChange={handleViewLutChange}
          title="Display-only colour transform applied at the swap-chain blit. Never affects exports."
        >
          <option value="">— None —</option>
          <LutSelectOptions luts={luts} />
        </select>
      </div>

      {showOperatorRow && (
        <div className={[styles.row, !isHdr ? styles.disabled : ""].join(" ")}>
          <label className={styles.label}>Tone Map</label>
          <select
            className={styles.select}
            value={operator}
            onChange={handleOperatorChange}
            disabled={!isHdr}
            title="HDR → SDR compression operator (used when no view-transform LUT is active)"
          >
            {OPERATOR_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}

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

      {!isHdr && (
        <p className={styles.hint}>
          Tone Map and Exposure require Float32 colour mode.
        </p>
      )}
    </div>
  );
}
