import React, { useEffect, useMemo, useRef, useState } from "react";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import {
  normalizePaletteForDisplay,
  sortSwatchesByHue,
} from "@/utils/swatchSort";
import {
  generateColorWheel,
  hslToRgba,
  timeOfDayRampGroups,
  timeOfDayRows,
  TIME_OF_DAY_MODES,
  TIME_OF_DAY_PROFILES,
} from "@/utils/paletteGenerators";
import type {
  SchemeType,
  TimeOfDay,
  TimeOfDayPreset,
  TimeOfDaySettings,
} from "@/utils/paletteGenerators";
import {
  DEVICE_PALETTES,
  DEVICE_KEYS,
  DEVICE_LABELS,
} from "@/utils/devicePalettes";
import type { DevicePaletteKey } from "@/utils/devicePalettes";
import type { RGBAColor } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import styles from "./GeneratePaletteDialog.module.scss";
import { clampF32ToUint8 } from "@/utils/pixelFormatConvert";
import { quantizeOffThread } from "@/wasm/pixelopsWorkerClient";

// ─── Types ────────────────────────────────────────────────────────────────────

type Mode = "color-wheel" | "extract" | "device" | "time-of-day";

export interface GeneratePaletteDialogProps {
  open: boolean;
  onClose: () => void;
  canvasHandleRef: { readonly current: CanvasHandle | null };
  swatches: RGBAColor[];
  hasActiveDocument: boolean;
  /** `groups` (indices into `palette`) replace the swatch groups; ramp
   *  groups keep each original colour next to its gradient. */
  onApply: (
    palette: RGBAColor[],
    groups: Array<{ name: string; swatchIndices: number[]; ramp?: boolean }>,
  ) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sliderPct(value: number, min: number, max: number): string {
  return `${((value - min) / (max - min)) * 100}%`;
}

function rgbaToHex(c: RGBAColor): string {
  return `#${[c.r, c.g, c.b]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

/** Relit settings per time of day, each mode starting from its defaults. */
type TodSettingsByMode = Record<TimeOfDay, TimeOfDaySettings>;

const todDefaults = (): TodSettingsByMode => ({
  dawn: { ...TIME_OF_DAY_PROFILES.dawn.defaults },
  day: { ...TIME_OF_DAY_PROFILES.day.defaults },
  dusk: { ...TIME_OF_DAY_PROFILES.dusk.defaults },
  night: { ...TIME_OF_DAY_PROFILES.night.defaults },
});

/** Section with a clickable header; shows a one-line summary when closed. */
function CollapsibleSection({
  title,
  summary,
  swatch,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  swatch?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={styles.section}>
      <button
        type="button"
        className={styles.sectionHeader}
        aria-expanded={open}
        onClick={onToggle}
      >
        <svg
          className={`${styles.sectionChevron}${open ? ` ${styles.sectionChevronOpen}` : ""}`}
          viewBox="0 0 8 8"
          width="8"
          height="8"
          aria-hidden
        >
          <path d="M2 1l4 3-4 3z" fill="currentColor" />
        </svg>
        <span className={styles.sectionTitle}>{title}</span>
        {swatch && (
          <span className={styles.sectionSwatch} style={{ background: swatch }} />
        )}
        {!open && <span className={styles.sectionSummary}>{summary}</span>}
      </button>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </div>
  );
}

/** Small glyph per time of day: sunrise, sun, sunset, moon. */
function TimeOfDayIcon({ mode }: { mode: TimeOfDay }): React.JSX.Element {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.3,
    strokeLinecap: "round" as const,
    "aria-hidden": true,
  };
  switch (mode) {
    case "dawn":
      return (
        <svg {...common}>
          <path d="M3 12a5 5 0 0 1 10 0" />
          <path d="M1 12h14M8 3v2M3.2 6.2l1.2 1.2M12.8 6.2l-1.2 1.2" />
          <path d="M6 1.8L8 0.6l2 1.2" />
        </svg>
      );
    case "day":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13" />
        </svg>
      );
    case "dusk":
      return (
        <svg {...common}>
          <path d="M3 12a5 5 0 0 1 10 0" />
          <path d="M1 12h14M8 3v2M3.2 6.2l1.2 1.2M12.8 6.2l-1.2 1.2" />
          <path d="M6 14.2L8 15.4l2-1.2" />
        </svg>
      );
    case "night":
      return (
        <svg {...common}>
          <path d="M13 10.5A6 6 0 0 1 5.5 3a6 6 0 1 0 7.5 7.5z" />
        </svg>
      );
  }
}

/** Labelled slider + number field. `scale` maps the stored value to the
 *  displayed one (e.g. 0–1 stored, 0–100 shown). */
function SliderRow({
  label,
  value,
  min,
  max,
  scale = 1,
  unit,
  hue = false,
  swatch,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  scale?: number;
  unit?: string;
  hue?: boolean;
  swatch?: string;
  onChange: (v: number) => void;
}): React.JSX.Element {
  const shown = Math.round(value * scale);
  const set = (v: number): void =>
    onChange(Math.max(min, Math.min(max, v)) / scale);
  return (
    <div className={styles.sliderRow}>
      <span className={styles.sliderLabel}>{label}</span>
      {swatch && (
        <div className={styles.hueSwatch} style={{ background: swatch }} />
      )}
      <div className={styles.sliderTrack}>
        <input
          type="range"
          className={hue ? styles.hueSlider : styles.psSlider}
          style={
            hue
              ? undefined
              : ({ "--pct": sliderPct(shown, min, max) } as React.CSSProperties)
          }
          min={min}
          max={max}
          value={shown}
          onChange={(e) => set(Number(e.target.value))}
        />
      </div>
      <input
        type="number"
        className={styles.numInput}
        min={min}
        max={max}
        value={shown}
        onChange={(e) => set(Number(e.target.value))}
      />
      <span className={styles.unit}>{unit ?? ""}</span>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GeneratePaletteDialog({
  open,
  onClose,
  canvasHandleRef,
  swatches,
  hasActiveDocument,
  onApply,
}: GeneratePaletteDialogProps): React.JSX.Element | null {
  // ── Shared state ─────────────────────────────────────────────────
  const [mode, setMode] = useState<Mode>("color-wheel");

  // ── Color Wheel state ─────────────────────────────────────────────
  const [baseHue, setBaseHue] = useState(200);
  const [scheme, setScheme] = useState<SchemeType>("analogous");
  const [colorCount, setColorCount] = useState(8);
  const [saturation, setSaturation] = useState(0.65);
  const [lightness, setLightness] = useState(0.52);

  // ── Extract state ─────────────────────────────────────────────────
  const [extractCount, setExtractCount] = useState(32);
  const [extractPalette, setExtractPalette] = useState<RGBAColor[]>([]);
  const [extractPending, setExtractPending] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  // ── Device state ──────────────────────────────────────────────────
  const [deviceKey, setDeviceKey] = useState<DevicePaletteKey>("cga");

  // ── Time of Day state ─────────────────────────────────────────────
  // Each time of day keeps its own settings, so switching modes to compare
  // doesn't lose tweaks. Section open/closed state survives re-opening.
  const [todMode, setTodMode] = useState<TimeOfDay>("night");
  const [todByMode, setTodByMode] = useState<TodSettingsByMode>(todDefaults);
  const [sectionsOpen, setSectionsOpen] = useState({
    shadows: false,
    highlights: false,
  });
  const todProfile = TIME_OF_DAY_PROFILES[todMode];
  const tod = todByMode[todMode];
  const setTodField = <K extends keyof TimeOfDaySettings>(
    key: K,
    value: TimeOfDaySettings[K],
  ): void =>
    setTodByMode((all) => ({
      ...all,
      [todMode]: { ...all[todMode], [key]: value },
    }));
  const applyTodPreset = ({ label: _label, ...p }: TimeOfDayPreset): void =>
    setTodByMode((all) => ({ ...all, [todMode]: { ...all[todMode], ...p } }));
  const toggleSection = (key: "shadows" | "highlights"): void =>
    setSectionsOpen((o) => ({ ...o, [key]: !o[key] }));

  // ── Reset on open ─────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setMode("color-wheel");
    setBaseHue(200);
    setScheme("analogous");
    setColorCount(8);
    setSaturation(0.65);
    setLightness(0.52);
    setExtractCount(32);
    setExtractPalette([]);
    setExtractPending(false);
    setExtractError(null);
    setDeviceKey("cga");
    setTodMode("night");
    setTodByMode(todDefaults());
  }, [open]);

  // ── Auto-switch disabled modes ────────────────────────────────────
  useEffect(() => {
    if (mode === "extract" && !hasActiveDocument) setMode("color-wheel");
    if (mode === "time-of-day" && swatches.length === 0) setMode("color-wheel");
  }, [mode, hasActiveDocument, swatches.length]);

  // ── Time of Day rows: one ramp per source swatch, in the order the
  //    swatch panel shows the sources ──────────────────────────────────
  const todRows = useMemo<RGBAColor[][]>(() => {
    if (mode !== "time-of-day" || swatches.length === 0) return [];
    const sources = sortSwatchesByHue(swatches).map((e) => e.color);
    return timeOfDayRows({ mode: todMode, sourceSwatches: sources, ...tod });
  }, [mode, swatches, todMode, tod]);

  // ── Synchronous preview ───────────────────────────────────────────
  const syncPreview = useMemo<RGBAColor[]>(() => {
    switch (mode) {
      case "color-wheel":
        return generateColorWheel({
          baseHue,
          scheme,
          count: colorCount,
          saturation,
          lightness,
        });
      case "device":
        return DEVICE_PALETTES[deviceKey];
      case "time-of-day":
        return todRows.flat();
      default:
        return [];
    }
  }, [
    mode,
    baseHue,
    scheme,
    colorCount,
    saturation,
    lightness,
    deviceKey,
    todRows,
  ]);

  // ── Async extract preview (debounced) ─────────────────────────────
  const extractTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (mode !== "extract" || !hasActiveDocument) return;

    if (extractTimerRef.current) clearTimeout(extractTimerRef.current);
    extractTimerRef.current = setTimeout(() => {
      void (async () => {
        setExtractPending(true);
        setExtractError(null);
        try {
          const handle = canvasHandleRef.current;
          if (!handle) return;
          const result = await handle.rasterizeComposite("export");
          // rgba32f composites are scene-linear floats — encode to sRGB
          // bytes first (the quantizer works on 8-bit RGBA).
          const bytes =
            result.data instanceof Float32Array
              ? clampF32ToUint8(result.data)
              : (result.data as Uint8Array);
          // The quantizer returns exactly `extractCount` distinct colours
          // (fewer only when the image has fewer). No near-colour merging
          // here — it used to throw away requested colours.
          const { palette, count } = await quantizeOffThread(bytes, extractCount);
          const raw: RGBAColor[] = new Array(count);
          for (let i = 0; i < count; i++) {
            raw[i] = {
              r: palette[i * 4],
              g: palette[i * 4 + 1],
              b: palette[i * 4 + 2],
              a: palette[i * 4 + 3],
            };
          }
          setExtractPalette(normalizePaletteForDisplay(raw));
        } catch (err) {
          setExtractPalette([]);
          setExtractError(err instanceof Error ? err.message : String(err));
        } finally {
          setExtractPending(false);
        }
      })();
    }, 150);

    return () => {
      if (extractTimerRef.current) clearTimeout(extractTimerRef.current);
    };
  }, [mode, extractCount, hasActiveDocument, canvasHandleRef]);

  // ── Combined preview ──────────────────────────────────────────────
  // Hue-sorted through the shared pipeline (matching how the SwatchPanel
  // orders loose swatches) — except Time of Day, whose palette is a list of
  // ramps that must stay in order: each original followed by its gradient.
  const preview = useMemo<RGBAColor[]>(() => {
    if (mode === "time-of-day") return syncPreview;
    const raw = mode === "extract" ? extractPalette : syncPreview;
    return normalizePaletteForDisplay(raw);
  }, [mode, syncPreview, extractPalette]);

  // ── Apply ─────────────────────────────────────────────────────────
  function handleApply(): void {
    if (mode === "time-of-day") {
      onApply(todRows.flat(), timeOfDayRampGroups(todRows, todMode));
    } else {
      onApply(preview.slice(), []);
    }
    onClose();
  }

  const todPerColor =
    (tod.includeSource ? 1 : 0) + tod.shadowSteps + 1 + tod.highlightSteps;

  // ── Render ────────────────────────────────────────────────────────
  const extractDisabled = !hasActiveDocument;
  const todDisabled = swatches.length === 0;
  const applyDisabled = mode === "extract" && extractPalette.length === 0;

  return (
    <ModalDialog
      open={open}
      title="Generate Palette"
      width={472}
      onClose={onClose}
    >
      {/* ── Tab strip ──────────────────────────────────────────────── */}
      <div className={styles.tabStrip} role="tablist">
        {(
          [
            {
              id: "color-wheel" as Mode,
              label: "Color Wheel",
              disabled: false,
            },
            {
              id: "extract" as Mode,
              label: "Extract from Image",
              disabled: extractDisabled,
            },
            {
              id: "device" as Mode,
              label: "Device Emulation",
              disabled: false,
            },
            {
              id: "time-of-day" as Mode,
              label: "Time of Day",
              disabled: todDisabled,
            },
          ] as { id: Mode; label: string; disabled: boolean }[]
        ).map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={mode === tab.id}
            aria-disabled={tab.disabled}
            className={[
              styles.tab,
              mode === tab.id ? styles.tabActive : "",
              tab.disabled ? styles.tabDisabled : "",
            ].join(" ")}
            onClick={() => {
              if (!tab.disabled) setMode(tab.id);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Mode body ──────────────────────────────────────────────── */}
      <div className={styles.modeBody}>
        {/* ── Color Wheel ─────────────────────────────────────── */}
        {mode === "color-wheel" && (
          <div className={styles.modePanel}>
            {/* Base Hue */}
            <div className={styles.sliderRow}>
              <span className={styles.sliderLabel}>Base Hue</span>
              <div
                className={styles.hueSwatch}
                style={{
                  background: `hsl(${baseHue}, ${Math.round(saturation * 100)}%, ${Math.round(lightness * 100)}%)`,
                }}
              />
              <div className={styles.sliderTrack}>
                <input
                  type="range"
                  className={styles.hueSlider}
                  min={0}
                  max={360}
                  value={baseHue}
                  onChange={(e) => setBaseHue(Number(e.target.value))}
                />
              </div>
              <input
                type="number"
                className={styles.numInput}
                min={0}
                max={360}
                value={baseHue}
                onChange={(e) =>
                  setBaseHue(Math.max(0, Math.min(360, Number(e.target.value))))
                }
              />
              <span className={styles.unit}>°</span>
            </div>

            {/* Scheme */}
            <div className={styles.sliderRow}>
              <span className={styles.sliderLabel}>Scheme</span>
              <select
                className={styles.psSelect}
                value={scheme}
                onChange={(e) => setScheme(e.target.value as SchemeType)}
              >
                <option value="analogous">Analogous</option>
                <option value="complementary">Complementary</option>
                <option value="triadic">Triadic</option>
                <option value="tetradic">Tetradic</option>
                <option value="split-complementary">Split-Complementary</option>
              </select>
            </div>

            {/* Colors count */}
            <div className={styles.sliderRow}>
              <span className={styles.sliderLabel}>Colors</span>
              <div className={styles.sliderTrack}>
                <input
                  type="range"
                  className={styles.psSlider}
                  style={
                    {
                      "--pct": sliderPct(colorCount, 2, 24),
                    } as React.CSSProperties
                  }
                  min={2}
                  max={24}
                  value={colorCount}
                  onChange={(e) => setColorCount(Number(e.target.value))}
                />
              </div>
              <input
                type="number"
                className={styles.numInput}
                min={2}
                max={24}
                value={colorCount}
                onChange={(e) =>
                  setColorCount(
                    Math.max(2, Math.min(24, Number(e.target.value))),
                  )
                }
              />
            </div>

            {/* Saturation */}
            <div className={styles.sliderRow}>
              <span className={styles.sliderLabel}>Saturation</span>
              <div className={styles.sliderTrack}>
                <input
                  type="range"
                  className={styles.psSlider}
                  style={
                    {
                      "--pct": sliderPct(saturation * 100, 0, 100),
                    } as React.CSSProperties
                  }
                  min={0}
                  max={100}
                  value={Math.round(saturation * 100)}
                  onChange={(e) => setSaturation(Number(e.target.value) / 100)}
                />
              </div>
              <input
                type="number"
                className={styles.numInput}
                min={0}
                max={100}
                value={Math.round(saturation * 100)}
                onChange={(e) =>
                  setSaturation(
                    Math.max(0, Math.min(100, Number(e.target.value))) / 100,
                  )
                }
              />
              <span className={styles.unit}>%</span>
            </div>

            {/* Lightness */}
            <div className={styles.sliderRow}>
              <span className={styles.sliderLabel}>Lightness</span>
              <div className={styles.sliderTrack}>
                <input
                  type="range"
                  className={styles.psSlider}
                  style={
                    {
                      "--pct": sliderPct(lightness * 100, 0, 100),
                    } as React.CSSProperties
                  }
                  min={0}
                  max={100}
                  value={Math.round(lightness * 100)}
                  onChange={(e) => setLightness(Number(e.target.value) / 100)}
                />
              </div>
              <input
                type="number"
                className={styles.numInput}
                min={0}
                max={100}
                value={Math.round(lightness * 100)}
                onChange={(e) =>
                  setLightness(
                    Math.max(0, Math.min(100, Number(e.target.value))) / 100,
                  )
                }
              />
              <span className={styles.unit}>%</span>
            </div>
          </div>
        )}

        {/* ── Extract from Image ──────────────────────────────── */}
        {mode === "extract" && (
          <div className={styles.modePanel}>
            {!hasActiveDocument && (
              <div className={styles.infoBanner}>
                <span className={styles.infoBannerIcon}>⚠</span>
                <span className={styles.infoBannerText}>
                  No document is currently open. Open an image to use Extract
                  from Image.
                </span>
              </div>
            )}
            <div className={styles.sliderRow}>
              <span className={styles.sliderLabel}>Colors</span>
              <div className={styles.sliderTrack}>
                <input
                  type="range"
                  className={styles.psSlider}
                  style={
                    {
                      "--pct": sliderPct(extractCount, 2, 256),
                    } as React.CSSProperties
                  }
                  min={2}
                  max={256}
                  value={extractCount}
                  disabled={!hasActiveDocument}
                  onChange={(e) => setExtractCount(Number(e.target.value))}
                />
              </div>
              <input
                type="number"
                className={styles.numInput}
                min={2}
                max={256}
                value={extractCount}
                disabled={!hasActiveDocument}
                onChange={(e) =>
                  setExtractCount(
                    Math.max(2, Math.min(256, Number(e.target.value))),
                  )
                }
              />
            </div>
            {extractError && (
              <div className={styles.infoBanner}>
                <span className={styles.infoBannerIcon}>⚠</span>
                <span className={styles.infoBannerText}>
                  Could not analyze the image: {extractError}
                </span>
              </div>
            )}
            {!extractPending &&
              !extractError &&
              extractPalette.length > 0 &&
              extractPalette.length < extractCount && (
                <div className={styles.nightInfo}>
                  <span className={styles.nightInfoText}>
                    The image only contains{" "}
                    <span className={styles.nightInfoHl}>
                      {extractPalette.length}
                    </span>{" "}
                    distinct colors.
                  </span>
                </div>
              )}
          </div>
        )}

        {/* ── Device Emulation ────────────────────────────────── */}
        {mode === "device" && (
          <div className={styles.modePanel}>
            <div
              className={styles.deviceList}
              role="listbox"
              aria-label="Device palette"
            >
              {DEVICE_KEYS.map((key) => (
                <div
                  key={key}
                  role="option"
                  aria-selected={deviceKey === key}
                  className={[
                    styles.deviceRow,
                    deviceKey === key ? styles.deviceRowSelected : "",
                  ].join(" ")}
                  onClick={() => setDeviceKey(key)}
                >
                  <div className={styles.deviceRadio} />
                  <span className={styles.deviceName}>
                    {DEVICE_LABELS[key]}
                  </span>
                  <span className={styles.deviceCount}>
                    {DEVICE_PALETTES[key].length} colors
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Time of Day ─────────────────────────────────────── */}
        {mode === "time-of-day" && (
          <div className={styles.modePanel}>
            {todDisabled ? (
              <div className={styles.infoBanner}>
                <span className={styles.infoBannerIcon}>⚠</span>
                <span className={styles.infoBannerText}>
                  Your swatch collection is empty. Add some colors to relight
                  them for a time of day.
                </span>
              </div>
            ) : (
              <>
                {/* Time of day selector */}
                <div
                  className={styles.todModes}
                  role="radiogroup"
                  aria-label="Time of day"
                >
                  {TIME_OF_DAY_MODES.map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={todMode === m}
                      className={[
                        styles.todMode,
                        todMode === m ? styles.todModeActive : "",
                      ].join(" ")}
                      onClick={() => setTodMode(m)}
                    >
                      <TimeOfDayIcon mode={m} />
                      {TIME_OF_DAY_PROFILES[m].label}
                    </button>
                  ))}
                </div>

                {/* Light */}
                <div className={styles.presetRow}>
                  <span className={styles.sliderLabel}>Preset</span>
                  {todProfile.presets.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      className={[
                        styles.presetBtn,
                        tod.tintHue === p.tintHue &&
                        tod.darkness === p.darkness &&
                        tod.tintStrength === p.tintStrength &&
                        tod.colorRetention === p.colorRetention
                          ? styles.presetBtnActive
                          : "",
                      ].join(" ")}
                      onClick={() => applyTodPreset(p)}
                    >
                      <span
                        className={styles.presetDot}
                        style={{
                          background: rgbaToHex(hslToRgba(p.tintHue, 0.6, 0.45)),
                        }}
                      />
                      {p.label}
                    </button>
                  ))}
                </div>
                <SliderRow
                  label="Light tint"
                  hue
                  swatch={rgbaToHex(hslToRgba(tod.tintHue, 0.6, 0.45))}
                  value={tod.tintHue}
                  min={0}
                  max={360}
                  unit="°"
                  onChange={(v) => setTodField("tintHue", Math.round(v))}
                />
                <SliderRow
                  label="Tint strength"
                  value={tod.tintStrength}
                  min={0}
                  max={100}
                  scale={100}
                  unit="%"
                  onChange={(v) => setTodField("tintStrength", v)}
                />
                <SliderRow
                  label={todProfile.exposureLabel}
                  value={tod.darkness}
                  min={todProfile.exposureRange[0]}
                  max={todProfile.exposureRange[1]}
                  scale={todProfile.exposureInverted ? -100 : 100}
                  unit="%"
                  onChange={(v) => setTodField("darkness", v)}
                />
                <SliderRow
                  label="Keep color"
                  value={tod.colorRetention}
                  min={0}
                  max={100}
                  scale={100}
                  unit="%"
                  onChange={(v) => setTodField("colorRetention", v)}
                />

                {/* Shadows */}
                <CollapsibleSection
                  title="Shadows"
                  summary={
                    tod.shadowSteps === 0
                      ? "Off"
                      : `${tod.shadowSteps} step${tod.shadowSteps > 1 ? "s" : ""} · ${Math.round(tod.shadowDepth * 100)}% depth`
                  }
                  open={sectionsOpen.shadows}
                  onToggle={() => toggleSection("shadows")}
                >
                  <SliderRow
                    label="Steps"
                    value={tod.shadowSteps}
                    min={0}
                    max={3}
                    onChange={(v) => setTodField("shadowSteps", Math.round(v))}
                  />
                  {tod.shadowSteps > 0 && (
                    <SliderRow
                      label="Depth"
                      value={tod.shadowDepth}
                      min={0}
                      max={100}
                      scale={100}
                      unit="%"
                      onChange={(v) => setTodField("shadowDepth", v)}
                    />
                  )}
                </CollapsibleSection>

                {/* Highlights */}
                <CollapsibleSection
                  title={todProfile.highlightTitle}
                  summary={
                    tod.highlightSteps === 0
                      ? "Off"
                      : `${tod.highlightSteps} step${tod.highlightSteps > 1 ? "s" : ""} · ${Math.round(tod.highlightStrength * 100)}% strength`
                  }
                  swatch={rgbaToHex(hslToRgba(tod.lightHue, 0.55, 0.75))}
                  open={sectionsOpen.highlights}
                  onToggle={() => toggleSection("highlights")}
                >
                  <SliderRow
                    label="Steps"
                    value={tod.highlightSteps}
                    min={0}
                    max={3}
                    onChange={(v) =>
                      setTodField("highlightSteps", Math.round(v))
                    }
                  />
                  {tod.highlightSteps > 0 && (
                    <>
                      <SliderRow
                        label="Strength"
                        value={tod.highlightStrength}
                        min={0}
                        max={100}
                        scale={100}
                        unit="%"
                        onChange={(v) => setTodField("highlightStrength", v)}
                      />
                      <SliderRow
                        label={todProfile.lightHueLabel}
                        hue
                        swatch={rgbaToHex(hslToRgba(tod.lightHue, 0.55, 0.75))}
                        value={tod.lightHue}
                        min={0}
                        max={360}
                        unit="°"
                        onChange={(v) => setTodField("lightHue", Math.round(v))}
                      />
                    </>
                  )}
                </CollapsibleSection>

                {/* Output */}
                <div className={styles.todOutputRow}>
                  <label className={styles.checkRow}>
                    <input
                      type="checkbox"
                      checked={tod.includeSource}
                      onChange={(e) =>
                        setTodField("includeSource", e.target.checked)
                      }
                    />
                    Keep the original colors
                  </label>
                  <span className={styles.nightInfoText}>
                    <span className={styles.nightInfoHl}>{todPerColor}</span>{" "}
                    per swatch ·{" "}
                    <span className={styles.nightInfoHl}>
                      {swatches.length * todPerColor}
                    </span>{" "}
                    total
                  </span>
                </div>

              </>
            )}
          </div>
        )}
      </div>
      {/* /modeBody */}

      {/* ── Preview section ────────────────────────────────────────── */}
      <div className={styles.previewSection}>
        <div className={styles.previewHeader}>
          <span className={styles.previewTitle}>Preview</span>
          <span className={styles.previewCount}>
            {mode === "extract" && extractPending
              ? "Analyzing…"
              : `${preview.length} color${preview.length !== 1 ? "s" : ""}`}
          </span>
        </div>

        {mode === "extract" && extractPending ? (
          <div className={styles.extractLoading}>Analyzing image…</div>
        ) : preview.length === 0 ? (
          <div className={styles.previewGrid}>
            <span className={styles.previewEmpty}>No colors to preview.</span>
          </div>
        ) : mode === "time-of-day" ? (
          <div
            className={`${styles.previewGrid} ${styles.previewRows}`}
            role="list"
            aria-label="Color preview, one ramp per row"
          >
            {todRows.map((row, r) => (
              <div key={r} className={styles.previewRow} role="listitem">
                {row.map((c, i) => {
                  const hex = rgbaToHex(c);
                  const role =
                    i === 0 && tod.includeSource ? "Original" : undefined;
                  return (
                    <div
                      key={i}
                      className={`${styles.colorChip}${role ? ` ${styles.colorChipOriginal}` : ""}`}
                      style={{ background: hex }}
                      title={role ? `${role} ${hex}` : hex}
                      aria-label={hex}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          <div
            className={styles.previewGrid}
            role="list"
            aria-label="Color preview"
          >
            {preview.map((c, i) => {
              const hex = rgbaToHex(c);
              return (
                <div
                  key={`${hex}-${i}`}
                  role="listitem"
                  className={styles.colorChip}
                  style={{ background: hex }}
                  title={hex}
                  aria-label={hex}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <div className={styles.footer}>
        <DialogButton onClick={onClose}>Cancel</DialogButton>
        <DialogButton primary disabled={applyDisabled} onClick={handleApply}>
          Apply
        </DialogButton>
      </div>
    </ModalDialog>
  );
}
