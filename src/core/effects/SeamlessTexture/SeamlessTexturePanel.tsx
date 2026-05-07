import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { SeamlessTextureAdjustmentLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "@/core/effects/_shared/filterPanel.module.scss";

interface Props {
  layer: SeamlessTextureAdjustmentLayer;
  parentLayerName: string;
}

export function SeamlessTexturePanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;
  const up = (patch: Partial<typeof p>): void =>
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...p, ...patch } },
    });

  return (
    <div className={styles.content}>
      {/* ── Break Repetition ── */}
      <div className={styles.row}>
        <span className={styles.label}>Break Repeat</span>
        <div className={styles.segmented}>
          <button
            className={`${styles.segBtn} ${p.breakRepetition ? styles.segBtnActive : ""}`}
            onClick={() => up({ breakRepetition: true })}
          >
            On
          </button>
          <button
            className={`${styles.segBtn} ${!p.breakRepetition ? styles.segBtnActive : ""}`}
            onClick={() => up({ breakRepetition: false })}
          >
            Off
          </button>
        </div>
        <span className={styles.unitSpacer} />
      </div>

      <div
        className={styles.row}
        style={{
          opacity: p.breakRepetition ? 1 : 0.4,
          pointerEvents: p.breakRepetition ? undefined : "none",
        }}
      >
        <span className={styles.label}>Cell Size</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={16}
            max={512}
            step={1}
            value={p.cellSize}
            style={
              {
                "--pct": String((p.cellSize - 16) / (512 - 16)),
              } as React.CSSProperties
            }
            onChange={(e) => up({ cellSize: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={16}
          max={512}
          step={1}
          value={p.cellSize}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ cellSize: Math.min(512, Math.max(16, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>

      <div
        className={styles.row}
        style={{
          opacity: p.breakRepetition ? 1 : 0.4,
          pointerEvents: p.breakRepetition ? undefined : "none",
        }}
      >
        <span className={styles.label}>Blend Radius</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={0}
            max={128}
            step={1}
            value={p.blendRadius}
            style={
              { "--pct": String(p.blendRadius / 128) } as React.CSSProperties
            }
            onChange={(e) => up({ blendRadius: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={0}
          max={128}
          step={1}
          value={p.blendRadius}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ blendRadius: Math.min(128, Math.max(0, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>

      <div className={styles.sep} />

      {/* ── Seamless Borders ── */}
      <div className={styles.row}>
        <span className={styles.label}>Seamless</span>
        <div className={styles.segmented}>
          <button
            className={`${styles.segBtn} ${p.seamlessBorders ? styles.segBtnActive : ""}`}
            onClick={() => up({ seamlessBorders: true })}
          >
            On
          </button>
          <button
            className={`${styles.segBtn} ${!p.seamlessBorders ? styles.segBtnActive : ""}`}
            onClick={() => up({ seamlessBorders: false })}
          >
            Off
          </button>
        </div>
        <span className={styles.unitSpacer} />
      </div>

      <div
        className={styles.row}
        style={{
          opacity: p.seamlessBorders ? 1 : 0.4,
          pointerEvents: p.seamlessBorders ? undefined : "none",
        }}
      >
        <span className={styles.label}>Border Radius</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={1}
            max={256}
            step={1}
            value={p.borderRadius}
            style={
              {
                "--pct": String((p.borderRadius - 1) / 255),
              } as React.CSSProperties
            }
            onChange={(e) => up({ borderRadius: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={1}
          max={256}
          step={1}
          value={p.borderRadius}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ borderRadius: Math.min(256, Math.max(1, Math.round(v))) });
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>

      <div className={styles.sep} />

      {/* ── Seed ── */}
      <div className={styles.seedRow}>
        <span className={styles.label}>Seed</span>
        <span className={styles.seedValue}>{p.seed}</span>
        <button
          className={styles.seedBtn}
          onClick={() => up({ seed: (Math.random() * 0xffffffff) >>> 0 })}
        >
          Randomize
        </button>
      </div>

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            up({
              breakRepetition: true,
              cellSize: 128,
              blendRadius: 16,
              seamlessBorders: true,
              borderRadius: 32,
              seed: 0,
            })
          }
        >
          Reset
        </button>
      </div>
    </div>
  );
}
