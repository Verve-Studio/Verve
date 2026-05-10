import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { SeamlessTextureEffectLayer } from "@/core/effects/SeamlessTexture/SeamlessTextureEffect";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "@/core/effects/_shared/filterPanel.module.scss";

interface Props {
  layer: SeamlessTextureEffectLayer;
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

      {(() => {
        const legacyR = p.borderRadius ?? 32;
        const rx = p.borderRadiusX ?? legacyR;
        const ry = p.borderRadiusY ?? legacyR;
        const linked = p.linkBorderRadius ?? true;
        const setX = (v: number): void => {
          const clamped = Math.min(256, Math.max(0, Math.round(v)));
          up(linked
            ? { borderRadiusX: clamped, borderRadiusY: clamped }
            : { borderRadiusX: clamped });
        };
        const setY = (v: number): void => {
          const clamped = Math.min(256, Math.max(0, Math.round(v)));
          up(linked
            ? { borderRadiusX: clamped, borderRadiusY: clamped }
            : { borderRadiusY: clamped });
        };
        const toggleLink = (): void => {
          // When re-linking, snap Y to X so the values match before linked
          // edits start applying to both.
          if (!linked) up({ linkBorderRadius: true, borderRadiusY: rx });
          else up({ linkBorderRadius: false });
        };
        const dim = {
          opacity: p.seamlessBorders ? 1 : 0.4,
          pointerEvents: p.seamlessBorders ? undefined : ("none" as const),
        };
        return (
          <>
            <div className={styles.row} style={dim}>
              <span className={styles.label}>H Border</span>
              <div className={styles.trackWrap}>
                <input
                  type="range"
                  className={styles.track}
                  min={0}
                  max={256}
                  step={1}
                  value={rx}
                  style={{ "--pct": String(rx / 256) } as React.CSSProperties}
                  onChange={(e) => setX(Number(e.target.value))}
                />
              </div>
              <input
                type="number"
                className={styles.numInput}
                min={0}
                max={256}
                step={1}
                value={rx}
                onChange={(e) => {
                  const v = e.target.valueAsNumber;
                  if (!isNaN(v)) setX(v);
                }}
              />
              <button
                className={styles.linkBtn}
                onClick={toggleLink}
                title={linked ? "Unlink H/V" : "Link H/V"}
                aria-pressed={linked}
              >
                {linked ? (
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                    <path d="M6.5 9.5l3-3M6 6.5h-1a2.5 2.5 0 100 5h1m4-5h1a2.5 2.5 0 110 5h-1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                    <path d="M6 6.5h-1a2.5 2.5 0 100 5h1m4-5h1a2.5 2.5 0 110 5h-1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    <path d="M2 2l12 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            </div>
            <div className={styles.row} style={dim}>
              <span className={styles.label}>V Border</span>
              <div className={styles.trackWrap}>
                <input
                  type="range"
                  className={styles.track}
                  min={0}
                  max={256}
                  step={1}
                  value={ry}
                  style={{ "--pct": String(ry / 256) } as React.CSSProperties}
                  onChange={(e) => setY(Number(e.target.value))}
                />
              </div>
              <input
                type="number"
                className={styles.numInput}
                min={0}
                max={256}
                step={1}
                value={ry}
                onChange={(e) => {
                  const v = e.target.valueAsNumber;
                  if (!isNaN(v)) setY(v);
                }}
              />
              <span className={styles.unitSpacer} />
            </div>
            {(() => {
              const strengthPct = Math.round((p.borderStrength ?? 0.5) * 100);
              const setStrength = (v: number): void => {
                const clamped = Math.min(100, Math.max(0, Math.round(v)));
                up({ borderStrength: clamped / 100 });
              };
              return (
                <div className={styles.row} style={dim}>
                  <span className={styles.label}>Strength</span>
                  <div className={styles.trackWrap}>
                    <input
                      type="range"
                      className={styles.track}
                      min={0}
                      max={100}
                      step={1}
                      value={strengthPct}
                      style={{ "--pct": String(strengthPct / 100) } as React.CSSProperties}
                      onChange={(e) => setStrength(Number(e.target.value))}
                    />
                  </div>
                  <input
                    type="number"
                    className={styles.numInput}
                    min={0}
                    max={100}
                    step={1}
                    value={strengthPct}
                    onChange={(e) => {
                      const v = e.target.valueAsNumber;
                      if (!isNaN(v)) setStrength(v);
                    }}
                  />
                  <span className={styles.unitLabel}>%</span>
                </div>
              );
            })()}
          </>
        );
      })()}

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
              borderRadiusX: 32,
              borderRadiusY: 32,
              linkBorderRadius: true,
              borderStrength: 0.5,
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
