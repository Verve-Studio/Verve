import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { HalftoneEffectLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./HalftoneOptions.module.scss";

interface HalftoneOptionsProps {
  layer: HalftoneEffectLayer;
  parentLayerName: string;
}

function pct(v: number, lo: number, hi: number): string {
  return String((v - lo) / (hi - lo));
}

function offsetPct(v: number): string {
  return `${((v + 50) / 100) * 100}%`;
}

const CHAN_COLORS: Record<"C" | "M" | "Y" | "K", string> = {
  C: "#3dbcbc",
  M: "#bc4d8c",
  Y: "#c8c800",
  K: "#909090",
};

export function HalftoneOptions({
  layer,
  parentLayerName,
}: HalftoneOptionsProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;

  const update = (patch: Partial<typeof p>): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...p, ...patch } },
    });
  };

  return (
    <div className={styles.content}>
      {/* Mode row */}
      <div className={styles.row}>
        <span className={styles.label}>Mode</span>
        <div className={styles.segGroup}>
          <button
            className={`${styles.segBtn}${p.mode === "color" ? ` ${styles.active}` : ""}`}
            onClick={() => update({ mode: "color" })}
          >
            Color (CMYK)
          </button>
          <button
            className={`${styles.segBtn}${p.mode === "bw" ? ` ${styles.active}` : ""}`}
            onClick={() => update({ mode: "bw" })}
          >
            B&amp;W
          </button>
        </div>
      </div>

      <div className={styles.separator} />

      {/* Frequency row */}
      <div className={styles.row}>
        <span className={styles.label}>Frequency</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={2}
            max={50}
            step={1}
            value={p.frequency}
            style={{ "--pct": pct(p.frequency, 2, 50) } as React.CSSProperties}
            onChange={(e) => update({ frequency: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={2}
          max={50}
          step={1}
          value={p.frequency}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              update({ frequency: Math.min(50, Math.max(2, Math.round(v))) });
          }}
        />
        <span className={styles.freqUnit}>c/100px</span>
      </div>

      {p.mode === "color" && (
        <>
          <div className={styles.separator} />

          <div className={styles.sectionHeader}>Channel Offsets</div>

          {(["C", "M", "Y", "K"] as const).map((ch) => {
            const key = `offset${ch}` as
              | "offsetC"
              | "offsetM"
              | "offsetY"
              | "offsetK";
            const val = p[key];
            return (
              <div key={ch} className={styles.chanRow}>
                <span
                  className={styles.chanLabel}
                  style={{ color: CHAN_COLORS[ch] }}
                >
                  {ch}
                </span>
                <div className={styles.trackWrap}>
                  <input
                    type="range"
                    className={styles.offsetTrack}
                    min={-50}
                    max={50}
                    step={1}
                    value={val}
                    style={{ "--pct": offsetPct(val) } as React.CSSProperties}
                    onChange={(e) => update({ [key]: Number(e.target.value) })}
                  />
                </div>
                <input
                  type="number"
                  className={styles.numInput}
                  min={-50}
                  max={50}
                  step={1}
                  value={val}
                  onChange={(e) => {
                    const v = e.target.valueAsNumber;
                    if (!isNaN(v))
                      update({
                        [key]: Math.min(50, Math.max(-50, Math.round(v))),
                      });
                  }}
                />
                <span className={styles.unitLabel}>%</span>
              </div>
            );
          })}
        </>
      )}

      <div className={styles.separator} />

      {/* Footer */}
      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            update({
              mode: "color",
              frequency: 10,
              offsetC: 0,
              offsetM: 0,
              offsetY: 0,
              offsetK: 0,
            })
          }
          title="Reset to defaults"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
