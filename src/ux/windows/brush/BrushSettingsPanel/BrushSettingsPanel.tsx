import React, { useState, useCallback } from "react";
import { ToolWindow } from "@/ux/widgets/ToolWindow/ToolWindow";
import { CurveEditor } from "@/ux/widgets/CurveEditor/CurveEditor";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import { useBrushes } from "@/core/services/useBrushes";
import { brushPanelStore } from "@/core/store/brushPanelStore";
import type { Brush, DynamicCurve, DynamicSource } from "@/types";
import { identityCurve } from "@/types";
import styles from "./BrushSettingsPanel.module.scss";

const SOURCE_LABELS: { value: DynamicSource; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "pressure", label: "Pen Pressure" },
  { value: "velocity", label: "Stroke Speed" },
  { value: "tilt", label: "Pen Tilt" },
  { value: "rotation", label: "Pen Rotation" },
  { value: "direction", label: "Stroke Direction" },
  { value: "random", label: "Random" },
  { value: "fade", label: "Fade" },
];

// ─── Reusable dynamic editor (jitter + source + curve + minimum) ──────────────

interface DynamicEditorProps {
  label: string;
  value: DynamicCurve;
  onChange: (next: DynamicCurve) => void;
  /** Tooltip explaining what this dynamic modulates. */
  hint?: string;
  /** When true, show the curve editor inline (default true). */
  showCurve?: boolean;
}

function DynamicEditor({
  label,
  value,
  onChange,
  hint,
  showCurve = true,
}: DynamicEditorProps): React.JSX.Element {
  const set = (patch: Partial<DynamicCurve>): void =>
    onChange({ ...value, ...patch });
  return (
    <div className={styles.dynamicBlock}>
      <div className={styles.dynamicHeader} title={hint}>
        <span className={styles.dynamicLabel}>{label}</span>
      </div>
      <div className={styles.row}>
        <label className={styles.smallLabel}>Jitter</label>
        <SliderInput
          value={Math.round(value.jitter * 100)}
          min={0}
          max={100}
          suffix="%"
          inputWidth={36}
          onChange={(v) => set({ jitter: v / 100 })}
        />
      </div>
      <div className={styles.row}>
        <label className={styles.smallLabel}>Control</label>
        <select
          className={styles.select}
          value={value.source}
          onChange={(e) => set({ source: e.target.value as DynamicSource })}
        >
          {SOURCE_LABELS.map(({ value: v, label: l }) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.row}>
        <label className={styles.smallLabel}>Minimum</label>
        <SliderInput
          value={Math.round(value.minimum * 100)}
          min={0}
          max={100}
          suffix="%"
          inputWidth={36}
          onChange={(v) => set({ minimum: v / 100 })}
        />
      </div>
      {value.source === "fade" && (
        <div className={styles.row}>
          <label className={styles.smallLabel}>Steps</label>
          <SliderInput
            value={value.fadeStamps ?? 25}
            min={1}
            max={500}
            inputWidth={42}
            onChange={(v) => set({ fadeStamps: v })}
          />
        </div>
      )}
      {showCurve && (
        <div className={styles.curveRow}>
          <CurveEditor
            points={value.curve}
            onChange={(pts) => set({ curve: pts })}
            width={196}
            height={86}
          />
        </div>
      )}
    </div>
  );
}

// ─── Collapsible section ──────────────────────────────────────────────────────

interface SectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function Section({
  title,
  defaultOpen = false,
  children,
}: SectionProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={styles.section}>
      <button
        className={styles.sectionHeader}
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span className={styles.chevron}>{open ? "▾" : "▸"}</span>
        <span>{title}</span>
      </button>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </div>
  );
}

// ─── Brush picker (gallery) ───────────────────────────────────────────────────

function BrushPicker({
  brushes,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onDuplicate,
}: {
  brushes: Brush[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className={styles.gallery}>
      <div className={styles.galleryItems}>
        {brushes.map((b) => (
          <button
            key={b.id}
            className={
              b.id === activeId ? styles.galleryItemActive : styles.galleryItem
            }
            onClick={() => onSelect(b.id)}
            title={`${b.name} (${b.scope})`}
          >
            <span className={styles.galleryDot}>●</span>
            <span className={styles.galleryName}>{b.name}</span>
            <span className={styles.galleryScope}>{b.scope[0].toUpperCase()}</span>
          </button>
        ))}
      </div>
      <div className={styles.galleryActions}>
        <button onClick={onCreate} title="New brush">+</button>
        <button onClick={() => onDuplicate(activeId)} title="Duplicate active">⧉</button>
        <button onClick={() => onDelete(activeId)} title="Delete active">−</button>
      </div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

interface BrushSettingsPanelProps {
  onClose: () => void;
  /** Optional capture-from-selection handler, supplied by the mount in MainWindow where the canvas is in scope. */
  onCaptureFromSelection?: () => Promise<void> | void;
}

export function BrushSettingsPanel({
  onClose,
  onCaptureFromSelection,
}: BrushSettingsPanelProps): React.JSX.Element {
  const {
    allBrushes,
    activeBrush,
    selectBrush,
    createBrush,
    updateBrush,
    deleteBrush,
    duplicateBrush,
  } = useBrushes();

  const update = useCallback(
    (patch: Partial<Brush>) => {
      void updateBrush({ ...activeBrush, ...patch });
    },
    [activeBrush, updateBrush],
  );

  const setTip = (patch: Partial<Brush["tip"]>): void =>
    update({ tip: { ...activeBrush.tip, ...patch } });
  const setScatter = (patch: Partial<Brush["scatter"]>): void =>
    update({ scatter: { ...activeBrush.scatter, ...patch } });
  const setShapeDyn = (patch: Partial<Brush["shapeDyn"]>): void =>
    update({ shapeDyn: { ...activeBrush.shapeDyn, ...patch } });
  const setColorDyn = (patch: Partial<Brush["colorDyn"]>): void =>
    update({ colorDyn: { ...activeBrush.colorDyn, ...patch } });
  const setPose = (patch: Partial<Brush["pose"]>): void =>
    update({ pose: { ...activeBrush.pose, ...patch } });
  const setNoise = (patch: Partial<Brush["noise"]>): void =>
    update({ noise: { ...activeBrush.noise, ...patch } });
  const setTexture = (patch: Partial<Brush["texture"]>): void =>
    update({ texture: { ...activeBrush.texture, ...patch } });
  const setWet = (patch: Partial<Brush["wetEdges"]>): void =>
    update({ wetEdges: { ...activeBrush.wetEdges, ...patch } });
  const setBuildUp = (patch: Partial<Brush["buildUp"]>): void =>
    update({ buildUp: { ...activeBrush.buildUp, ...patch } });
  const setSmudge = (patch: Partial<Brush["smudge"]>): void =>
    update({ smudge: { ...activeBrush.smudge, ...patch } });
  const setSmoothing = (patch: Partial<Brush["smoothing"]>): void =>
    update({ smoothing: { ...activeBrush.smoothing, ...patch } });

  return (
    <ToolWindow title="Brush Settings" onClose={onClose} width={264}>
      <div className={styles.body}>
        <div className={styles.headerRow}>
          <input
            className={styles.nameInput}
            value={activeBrush.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="Brush name"
          />
        </div>

        <BrushPicker
          brushes={allBrushes}
          activeId={activeBrush.id}
          onSelect={selectBrush}
          onCreate={() => void createBrush({}, "user")}
          onDelete={(id) => void deleteBrush(id)}
          onDuplicate={(id) => void duplicateBrush(id, "user")}
        />

        {onCaptureFromSelection && (
          <button
            type="button"
            className={styles.resetBtn}
            title="Create a new brush whose tip is taken from the current selection. (PR1: bitmap; PR2 will compute an SDF for clean scaling.)"
            onClick={() => void onCaptureFromSelection()}
          >
            Capture brush from selection
          </button>
        )}

        {/* ── Brush Tip ───────────────────────────────────────── */}
        <Section title="Brush Tip" defaultOpen={true}>
          <div className={styles.row}>
            <label className={styles.smallLabel}>Size</label>
            <SliderInput
              value={activeBrush.tip.size}
              min={1}
              max={500}
              inputWidth={42}
              onChange={(v) => setTip({ size: v })}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.smallLabel}>Spacing</label>
            <SliderInput
              value={activeBrush.tip.spacing}
              min={1}
              max={200}
              suffix="%"
              inputWidth={42}
              onChange={(v) => setTip({ spacing: v })}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.smallLabel}>Hardness</label>
            <SliderInput
              value={activeBrush.tip.hardness}
              min={0}
              max={100}
              suffix="%"
              inputWidth={42}
              onChange={(v) => setTip({ hardness: v })}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.smallLabel}>Roundness</label>
            <SliderInput
              value={Math.round(activeBrush.tip.roundness * 100)}
              min={10}
              max={100}
              suffix="%"
              inputWidth={42}
              onChange={(v) => setTip({ roundness: v / 100 })}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.smallLabel}>Angle</label>
            <SliderInput
              value={Math.round((activeBrush.tip.angle * 180) / Math.PI)}
              min={-180}
              max={180}
              suffix="°"
              inputWidth={42}
              onChange={(v) => setTip({ angle: (v * Math.PI) / 180 })}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.smallLabel}>Opacity</label>
            <SliderInput
              value={activeBrush.opacity}
              min={1}
              max={100}
              suffix="%"
              inputWidth={42}
              onChange={(v) => update({ opacity: v })}
            />
          </div>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={activeBrush.antiAlias}
              onChange={(e) => update({ antiAlias: e.target.checked })}
            />
            Anti-alias edge
          </label>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={activeBrush.velocityTracking}
              onChange={(e) =>
                update({ velocityTracking: e.target.checked })
              }
            />
            Velocity affects size & opacity
          </label>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={activeBrush.pressureSize}
              onChange={(e) => update({ pressureSize: e.target.checked })}
            />
            Pen pressure → size
          </label>
        </Section>

        {/* ── Shape Dynamics ──────────────────────────────────── */}
        <Section title="Shape Dynamics">
          <DynamicEditor
            label="Size Jitter"
            value={activeBrush.shapeDyn.sizeJitter}
            onChange={(v) => setShapeDyn({ sizeJitter: v })}
          />
          <DynamicEditor
            label="Angle Jitter"
            value={activeBrush.shapeDyn.angleJitter}
            onChange={(v) => setShapeDyn({ angleJitter: v })}
          />
          <DynamicEditor
            label="Roundness Jitter"
            value={activeBrush.shapeDyn.roundnessJitter}
            onChange={(v) => setShapeDyn({ roundnessJitter: v })}
          />
          <div className={styles.row}>
            <label className={styles.smallLabel}>Flip X jitter</label>
            <SliderInput
              value={Math.round(activeBrush.tip.flipXJitter * 100)}
              min={0}
              max={100}
              suffix="%"
              inputWidth={42}
              onChange={(v) => setTip({ flipXJitter: v / 100 })}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.smallLabel}>Flip Y jitter</label>
            <SliderInput
              value={Math.round(activeBrush.tip.flipYJitter * 100)}
              min={0}
              max={100}
              suffix="%"
              inputWidth={42}
              onChange={(v) => setTip({ flipYJitter: v / 100 })}
            />
          </div>
        </Section>

        {/* ── Scattering ──────────────────────────────────────── */}
        <Section title="Scattering">
          <div className={styles.row}>
            <label className={styles.smallLabel}>Amount</label>
            <SliderInput
              value={Math.round(activeBrush.scatter.amount * 100)}
              min={0}
              max={500}
              suffix="%"
              inputWidth={42}
              onChange={(v) => setScatter({ amount: v / 100 })}
            />
          </div>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={activeBrush.scatter.bothAxes}
              onChange={(e) => setScatter({ bothAxes: e.target.checked })}
            />
            Both axes
          </label>
          <DynamicEditor
            label="Scatter Jitter"
            value={activeBrush.scatter.jitter}
            onChange={(v) => setScatter({ jitter: v })}
          />
          <div className={styles.row}>
            <label className={styles.smallLabel}>Count</label>
            <SliderInput
              value={activeBrush.scatter.count}
              min={1}
              max={16}
              inputWidth={42}
              onChange={(v) => setScatter({ count: v })}
            />
          </div>
          <DynamicEditor
            label="Count Jitter"
            value={activeBrush.scatter.countJitter}
            onChange={(v) => setScatter({ countJitter: v })}
          />
        </Section>

        {/* ── Color Dynamics ──────────────────────────────────── */}
        <Section title="Color Dynamics">
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={activeBrush.colorDyn.perStamp}
              onChange={(e) => setColorDyn({ perStamp: e.target.checked })}
            />
            Apply per stamp (off = once per stroke)
          </label>
          <DynamicEditor
            label="FG/BG Jitter"
            value={activeBrush.colorDyn.fgBgJitter}
            onChange={(v) => setColorDyn({ fgBgJitter: v })}
          />
          <DynamicEditor
            label="Hue Jitter"
            value={activeBrush.colorDyn.hueJitter}
            onChange={(v) => setColorDyn({ hueJitter: v })}
          />
          <DynamicEditor
            label="Saturation Jitter"
            value={activeBrush.colorDyn.saturationJitter}
            onChange={(v) => setColorDyn({ saturationJitter: v })}
          />
          <DynamicEditor
            label="Brightness Jitter"
            value={activeBrush.colorDyn.brightnessJitter}
            onChange={(v) => setColorDyn({ brightnessJitter: v })}
          />
          <DynamicEditor
            label="Purity Jitter"
            value={activeBrush.colorDyn.purityJitter}
            onChange={(v) => setColorDyn({ purityJitter: v })}
          />
        </Section>

        {/* ── Brush Pose ──────────────────────────────────────── */}
        <Section title="Brush Pose">
          <div className={styles.row}>
            <label className={styles.smallLabel}>Tilt scale</label>
            <SliderInput
              value={Math.round(activeBrush.pose.tiltScale * 100)}
              min={0}
              max={100}
              suffix="%"
              inputWidth={42}
              onChange={(v) => setPose({ tiltScale: v / 100 })}
            />
          </div>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={activeBrush.pose.directionFollow}
              onChange={(e) =>
                setPose({ directionFollow: e.target.checked })
              }
            />
            Tip follows stroke direction
          </label>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={activeBrush.pose.rotationFollow}
              onChange={(e) =>
                setPose({ rotationFollow: e.target.checked })
              }
            />
            Tip follows pen rotation
          </label>
          <div className={styles.row}>
            <label className={styles.smallLabel}>Pressure squash</label>
            <SliderInput
              value={Math.round(activeBrush.pose.pressureSquash * 100)}
              min={0}
              max={100}
              suffix="%"
              inputWidth={42}
              onChange={(v) => setPose({ pressureSquash: v / 100 })}
            />
          </div>
        </Section>

        {/* ── Noise ───────────────────────────────────────────── */}
        <Section title="Noise">
          <div className={styles.row}>
            <label className={styles.smallLabel}>Amount</label>
            <SliderInput
              value={Math.round(activeBrush.noise.amount * 100)}
              min={0}
              max={100}
              suffix="%"
              inputWidth={42}
              onChange={(v) => setNoise({ amount: v / 100 })}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.smallLabel}>Scale</label>
            <SliderInput
              value={activeBrush.noise.scale}
              min={1}
              max={64}
              inputWidth={42}
              onChange={(v) => setNoise({ scale: v })}
            />
          </div>
        </Section>

        {/* ── Texture (paper grain) ───────────────────────────── */}
        <Section title="Texture">
          <div className={styles.row}>
            <label className={styles.smallLabel}>Amount</label>
            <SliderInput
              value={Math.round(activeBrush.texture.amount * 100)}
              min={0}
              max={100}
              suffix="%"
              inputWidth={42}
              onChange={(v) => setTexture({ amount: v / 100 })}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.smallLabel}>Scale</label>
            <SliderInput
              value={activeBrush.texture.scale}
              min={4}
              max={512}
              inputWidth={42}
              onChange={(v) => setTexture({ scale: v })}
            />
          </div>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={activeBrush.texture.followBrush}
              onChange={(e) =>
                setTexture({ followBrush: e.target.checked })
              }
            />
            Follow brush
          </label>
        </Section>

        {/* ── Wet Edges ───────────────────────────────────────── */}
        <Section title="Wet Edges">
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={activeBrush.wetEdges.enabled}
              onChange={(e) => setWet({ enabled: e.target.checked })}
            />
            Enabled
          </label>
          <div className={styles.row}>
            <label className={styles.smallLabel}>Amount</label>
            <SliderInput
              value={Math.round(activeBrush.wetEdges.amount * 100)}
              min={0}
              max={100}
              suffix="%"
              inputWidth={42}
              onChange={(v) => setWet({ amount: v / 100 })}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.smallLabel}>Width</label>
            <SliderInput
              value={activeBrush.wetEdges.width}
              min={1}
              max={32}
              inputWidth={42}
              onChange={(v) => setWet({ width: v })}
            />
          </div>
        </Section>

        {/* ── Build Up ────────────────────────────────────────── */}
        <Section title="Build Up">
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={activeBrush.buildUp.enabled}
              onChange={(e) => setBuildUp({ enabled: e.target.checked })}
            />
            Airbrush mode
          </label>
          <div className={styles.row}>
            <label className={styles.smallLabel}>Rate</label>
            <SliderInput
              value={activeBrush.buildUp.rate}
              min={1}
              max={120}
              inputWidth={42}
              onChange={(v) => setBuildUp({ rate: v })}
            />
          </div>
        </Section>

        {/* ── Smudge ──────────────────────────────────────────── */}
        <Section title="Smudge">
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={activeBrush.smudge.enabled}
              onChange={(e) => setSmudge({ enabled: e.target.checked })}
            />
            Enabled (drag underlying pixels)
          </label>
          <div className={styles.row}>
            <label
              className={styles.smallLabel}
              title="How long the carried color persists. 0 = picks up local color each stamp; 100 = perfect smear."
            >
              Strength
            </label>
            <SliderInput
              value={Math.round(activeBrush.smudge.strength * 100)}
              min={0}
              max={100}
              suffix="%"
              inputWidth={42}
              onChange={(v) => setSmudge({ strength: v / 100 })}
            />
          </div>
          <div className={styles.row}>
            <label
              className={styles.smallLabel}
              title="0 = pure smudge (no fresh paint); 100 = pure paint (no smudge); in-between is finger painting."
            >
              Color rate
            </label>
            <SliderInput
              value={Math.round(activeBrush.smudge.colorRate * 100)}
              min={0}
              max={100}
              suffix="%"
              inputWidth={42}
              onChange={(v) => setSmudge({ colorRate: v / 100 })}
            />
          </div>
        </Section>

        {/* ── Smoothing ───────────────────────────────────────── */}
        <Section title="Smoothing">
          <div className={styles.row}>
            <label className={styles.smallLabel}>Stabiliser</label>
            <SliderInput
              value={activeBrush.smoothing.ema}
              min={0}
              max={100}
              suffix="%"
              inputWidth={42}
              onChange={(v) => setSmoothing({ ema: v })}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.smallLabel}>Pull-string</label>
            <SliderInput
              value={Math.round(activeBrush.smoothing.pullString * 100)}
              min={0}
              max={100}
              suffix="%"
              inputWidth={42}
              onChange={(v) => setSmoothing({ pullString: v / 100 })}
            />
          </div>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={activeBrush.smoothing.catchUp}
              onChange={(e) => setSmoothing({ catchUp: e.target.checked })}
            />
            Catch up at stroke end
          </label>
          <div className={styles.row}>
            <label className={styles.smallLabel}>Motion blur</label>
            <SliderInput
              value={activeBrush.motionBlur}
              min={0}
              max={100}
              suffix="%"
              inputWidth={42}
              onChange={(v) => update({ motionBlur: v })}
            />
          </div>
        </Section>

        {/* ── Reset ────────────────────────────────────────────── */}
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.resetBtn}
            title="Reset all dynamics to identity"
            onClick={() =>
              update({
                shapeDyn: {
                  sizeJitter: identityCurve(),
                  angleJitter: identityCurve(),
                  roundnessJitter: identityCurve(),
                },
                colorDyn: {
                  ...activeBrush.colorDyn,
                  fgBgJitter: identityCurve(),
                  hueJitter: identityCurve(),
                  saturationJitter: identityCurve(),
                  brightnessJitter: identityCurve(),
                  purityJitter: identityCurve(),
                },
                scatter: {
                  ...activeBrush.scatter,
                  jitter: identityCurve(),
                  countJitter: identityCurve(),
                },
              })
            }
          >
            Reset Dynamics
          </button>
        </div>
      </div>
    </ToolWindow>
  );
}

// ─── Mount wrapper ────────────────────────────────────────────────────────────

/**
 * Subscribes to brushPanelStore and renders the panel when visible. Drop this
 * once in MainWindow; the BrushOptions tool-options bar toggles the singleton.
 */
export function BrushSettingsPanelMount({
  onCaptureFromSelection,
}: {
  onCaptureFromSelection?: () => Promise<void> | void;
} = {}): React.JSX.Element | null {
  const [visible, setVisible] = useState(brushPanelStore.isVisible());
  React.useEffect(() => {
    return brushPanelStore.subscribe(() =>
      setVisible(brushPanelStore.isVisible()),
    );
  }, []);
  if (!visible) return null;
  return (
    <BrushSettingsPanel
      onClose={() => brushPanelStore.close()}
      onCaptureFromSelection={onCaptureFromSelection}
    />
  );
}
