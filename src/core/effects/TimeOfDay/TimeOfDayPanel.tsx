import React from "react";
import { useAppDispatch } from "@/core/store/AppContext";
import type {
  TimeOfDayEffectLayer,
  TimeOfDayParams,
} from "@/core/effects/TimeOfDay/TimeOfDayEffect";
import { timeOfDayModeParams } from "@/core/effects/TimeOfDay/TimeOfDayEffect";
import {
  hslToRgba,
  TIME_OF_DAY_MODES,
  TIME_OF_DAY_PROFILES,
} from "@/utils/paletteGenerators";
import type { TimeOfDay, TimeOfDayPreset } from "@/utils/paletteGenerators";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import { TimeOfDayIcon } from "@/ux/widgets/TimeOfDayIcon/TimeOfDayIcon";
import styles from "./TimeOfDayPanel.module.scss";

// ─── Props ────────────────────────────────────────────────────────────────────

interface TimeOfDayPanelProps {
  layer: TimeOfDayEffectLayer;
  parentLayerName: string;
}

const cssHsl = (hue: number, s: number, l: number): string => {
  const c = hslToRgba(hue, s, l);
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
};

// ─── Slider row ───────────────────────────────────────────────────────────────

/** Label + range + number field. `scale` maps the stored value to the shown
 *  one (0–1 stored → 0–100 shown; −100 inverts for Day's exposure). */
function Row({
  label,
  value,
  min,
  max,
  scale = 1,
  hue = false,
  swatch,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  scale?: number;
  hue?: boolean;
  swatch?: string;
  onChange: (v: number) => void;
}): React.JSX.Element {
  const shown = Math.round(value * scale);
  const set = (v: number): void =>
    onChange(Math.max(min, Math.min(max, Math.round(v))) / scale);
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      {swatch && <span className={styles.swatch} style={{ background: swatch }} />}
      <div className={styles.trackWrap}>
        <input
          type="range"
          className={hue ? styles.hueTrack : styles.track}
          min={min}
          max={max}
          step={1}
          value={shown}
          style={
            hue
              ? undefined
              : ({ "--pct": String((shown - min) / (max - min)) } as React.CSSProperties)
          }
          onChange={(e) => set(Number(e.target.value))}
        />
      </div>
      <input
        type="number"
        className={styles.numInput}
        min={min}
        max={max}
        step={1}
        value={shown}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (!isNaN(v)) set(v);
        }}
      />
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TimeOfDayPanel({
  layer,
  parentLayerName,
}: TimeOfDayPanelProps): React.JSX.Element {
  const dispatch = useAppDispatch();
  const p = layer.params;
  const prof = TIME_OF_DAY_PROFILES[p.mode];

  const update = (patch: Partial<TimeOfDayParams>): void =>
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...p, ...patch } },
    });

  // Switching the time of day loads that mode's lead preset (its light is a
  // different kind of light), keeping the tonal and amount settings.
  const setMode = (mode: TimeOfDay): void => {
    if (mode === p.mode) return;
    update(timeOfDayModeParams(mode, p));
  };
  const applyPreset = ({ label: _label, ...preset }: TimeOfDayPreset): void =>
    update(preset);
  const presetActive = (q: TimeOfDayPreset): boolean =>
    q.tintHue === p.tintHue &&
    q.tintStrength === p.tintStrength &&
    q.darkness === p.darkness &&
    q.colorRetention === p.colorRetention &&
    q.lightHue === p.lightHue &&
    q.shadowHue === p.shadowHue;

  return (
    <div className={styles.content}>
      {/* Time of day */}
      <div className={styles.modes} role="radiogroup" aria-label="Time of day">
        {TIME_OF_DAY_MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={p.mode === m}
            className={`${styles.mode}${p.mode === m ? ` ${styles.modeActive}` : ""}`}
            onClick={() => setMode(m)}
            title={TIME_OF_DAY_PROFILES[m].label}
          >
            <TimeOfDayIcon mode={m} />
            <span>{TIME_OF_DAY_PROFILES[m].label}</span>
          </button>
        ))}
      </div>

      <div className={styles.presets}>
        {prof.presets.map((q) => (
          <button
            key={q.label}
            type="button"
            className={`${styles.preset}${presetActive(q) ? ` ${styles.presetActive}` : ""}`}
            onClick={() => applyPreset(q)}
          >
            <span
              className={styles.presetDot}
              style={{ background: cssHsl(q.tintHue, 0.6, 0.45) }}
            />
            {q.label}
          </button>
        ))}
      </div>

      {/* Light */}
      <div className={styles.sectionTitle}>Light</div>
      <Row
        label="Tint"
        hue
        swatch={cssHsl(p.tintHue, 0.6, 0.45)}
        value={p.tintHue}
        min={0}
        max={360}
        onChange={(v) => update({ tintHue: v })}
      />
      <Row
        label="Strength"
        value={p.tintStrength}
        min={0}
        max={100}
        scale={100}
        onChange={(v) => update({ tintStrength: v })}
      />
      <Row
        label={prof.exposureLabel}
        value={p.darkness}
        min={prof.exposureRange[0]}
        max={prof.exposureRange[1]}
        scale={prof.exposureInverted ? -100 : 100}
        onChange={(v) => update({ darkness: v })}
      />
      <Row
        label="Keep color"
        value={p.colorRetention}
        min={0}
        max={100}
        scale={100}
        onChange={(v) => update({ colorRetention: v })}
      />

      {/* Tonal ranges */}
      <div className={styles.sectionTitle}>Shadows</div>
      <Row
        label="Depth"
        value={p.shadowDepth}
        min={0}
        max={100}
        scale={100}
        onChange={(v) => update({ shadowDepth: v })}
      />
      <Row
        label="Shadow hue"
        hue
        swatch={cssHsl(p.shadowHue, 0.5, 0.3)}
        value={p.shadowHue}
        min={0}
        max={360}
        onChange={(v) => update({ shadowHue: v })}
      />

      <div className={styles.sectionTitle}>{prof.highlightTitle}</div>
      <Row
        label="Strength"
        value={p.highlightStrength}
        min={0}
        max={100}
        scale={100}
        onChange={(v) => update({ highlightStrength: v })}
      />
      <Row
        label={prof.lightHueLabel}
        hue
        swatch={cssHsl(p.lightHue, 0.55, 0.75)}
        value={p.lightHue}
        min={0}
        max={360}
        onChange={(v) => update({ lightHue: v })}
      />

      <div className={styles.divider} />
      <Row
        label="Amount"
        value={p.amount}
        min={0}
        max={100}
        onChange={(v) => update({ amount: v })}
      />

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() => update(timeOfDayModeParams(p.mode))}
          title={`Reset to the ${prof.presets[0].label} defaults`}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
