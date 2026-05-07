import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { LensDistortionEffectLayer } from "@/core/effects/LensDistortion/LensDistortionEffect";
import { effectRegistry } from "@/core/effects";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./LensDistortionOptions.module.scss";

// ─── Props ────────────────────────────────────────────────────────────────────

interface LensDistortionOptionsProps {
  layer: LensDistortionEffectLayer;
  parentLayerName: string;
}

const getDefaultParams = (): LensDistortionEffectLayer["params"] =>
  effectRegistry.get("lens-distortion")!.defaultParams as LensDistortionEffectLayer["params"];

type DistortionType = LensDistortionEffectLayer["params"]["type"];
type EdgeMode = LensDistortionEffectLayer["params"]["edgeMode"];

const TYPE_LABEL: Record<DistortionType, string> = {
  radial: "Radial",
  fisheye: "Fisheye",
  mustache: "Mustache",
  perspective: "Perspective",
};

// ─── Component ────────────────────────────────────────────────────────────────

export function LensDistortionOptions({
  layer,
  parentLayerName,
}: LensDistortionOptionsProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;

  const update = (
    patch: Partial<LensDistortionEffectLayer["params"]>,
  ): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...patch } },
    });
  };

  const pct = (v: number, min: number, max: number): string =>
    String((v - min) / (max - min));

  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (v: number) => void,
    suffix?: string,
  ): React.JSX.Element => (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div className={styles.trackWrap}>
        <input
          type="range"
          className={styles.track}
          min={min}
          max={max}
          step={1}
          value={value}
          style={{ "--pct": pct(value, min, max) } as React.CSSProperties}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      <input
        type="number"
        className={styles.numInput}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (!isNaN(v)) onChange(Math.min(max, Math.max(min, Math.round(v))));
        }}
      />
      {suffix !== undefined && (
        <span style={{ fontSize: 10, color: "#7a7a7a", width: 14 }}>
          {suffix}
        </span>
      )}
    </div>
  );

  const isPerspective = p.type === "perspective";
  const isMustache = p.type === "mustache";

  return (
    <div className={styles.content}>
      {/* ── Type ───────────────────────────────────────────────────────────── */}
      <div className={styles.row}>
        <span className={styles.label}>Type</span>
        <div className={styles.segmented}>
          {(
            ["radial", "fisheye", "mustache", "perspective"] as DistortionType[]
          ).map((t) => (
            <button
              key={t}
              className={`${styles.segBtn}${p.type === t ? ` ${styles.segBtnActive}` : ""}`}
              onClick={() => update({ type: t })}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </div>

      {/* ── Strength / Tilt — selected based on type ───────────────────────── */}
      {!isPerspective &&
        slider(
          p.type === "fisheye" ? "FOV" : "Strength",
          p.strength,
          p.type === "fisheye" ? 0 : -100,
          100,
          (v) => update({ strength: v }),
        )}

      {isMustache &&
        slider("Secondary", p.secondary, -100, 100, (v) =>
          update({ secondary: v }),
        )}

      {isPerspective && (
        <>
          {slider("Tilt X", p.tiltX, -100, 100, (v) => update({ tiltX: v }))}
          {slider("Tilt Y", p.tiltY, -100, 100, (v) => update({ tiltY: v }))}
        </>
      )}

      <div className={styles.divider} />
      <div className={styles.sectionLabel}>Framing</div>

      {slider(
        "Center X",
        Math.round(p.centerX * 100),
        0,
        100,
        (v) => update({ centerX: v / 100 }),
        "%",
      )}
      {slider(
        "Center Y",
        Math.round(p.centerY * 100),
        0,
        100,
        (v) => update({ centerY: v / 100 }),
        "%",
      )}
      {slider("Zoom", p.zoom, 25, 200, (v) => update({ zoom: v }), "%")}

      <div className={styles.row}>
        <span className={styles.label}>Edges</span>
        <div className={styles.segmented}>
          {(["transparent", "clamp", "mirror"] as EdgeMode[]).map((m) => (
            <button
              key={m}
              className={`${styles.segBtn}${p.edgeMode === m ? ` ${styles.segBtnActive}` : ""}`}
              onClick={() => update({ edgeMode: m })}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Distorting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            dispatch({
              type: "UPDATE_ADJUSTMENT_LAYER",
              payload: { ...layer, params: { ...getDefaultParams() } },
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
