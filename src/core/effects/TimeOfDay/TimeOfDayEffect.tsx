import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";
import {
  hueDirection,
  PURKINJE_FULL,
  TIME_OF_DAY_MODES,
  TIME_OF_DAY_PROFILES,
} from "@/utils/paletteGenerators";
import type { TimeOfDay } from "@/utils/paletteGenerators";
import type { IPipelineEffect } from "../IPipelineEffect";
import { customField, numberField } from "../_shared/effectParams";
import { TimeOfDayPanel } from "./TimeOfDayPanel";

const TimeOfDayIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.1"
    strokeLinecap="round"
    aria-hidden="true"
  >
    {/* half sun / half moon */}
    <path d="M6 2.5a3.5 3.5 0 0 0 0 7z" fill="currentColor" stroke="none" />
    <circle cx="6" cy="6" r="3.5" />
    <line x1="6" y1="0.5" x2="6" y2="1.3" />
    <line x1="6" y1="10.7" x2="6" y2="11.5" />
    <line x1="10.7" y1="6" x2="11.5" y2="6" />
    <line x1="9.4" y1="2.6" x2="9.9" y2="2.1" />
    <line x1="9.4" y1="9.4" x2="9.9" y2="9.9" />
  </svg>
);

export interface TimeOfDayParams {
  mode: TimeOfDay;
  /** Light tint hue, HSL degrees. */
  tintHue: number;
  /** 0–1. */
  tintStrength: number;
  /** 0–1 darkens; negative brightens (Day's exposure). */
  darkness: number;
  /** 0–1: how much of each colour's own chroma survives. */
  colorRetention: number;
  /** 0–1: how far shadows deepen and take the shadow tint. */
  shadowDepth: number;
  /** 0–1: how strongly highlights take the key light. */
  highlightStrength: number;
  /** Key light (sun / moon) hue, HSL degrees. */
  lightHue: number;
  /** Ambient shadow hue (sky fill), HSL degrees. */
  shadowHue: number;
  /** 0–100: blend between the original and the relit image. */
  amount: number;
}

export type TimeOfDayEffectLayer = EffectLayerOf<"time-of-day", TimeOfDayParams>;

type TimeOfDayOp = Extract<EffectRenderOp, { kind: "time-of-day" }>;

/** Params for `mode` from its first preset (used on create and on switch). */
export function timeOfDayModeParams(
  mode: TimeOfDay,
  keep?: Pick<TimeOfDayParams, "shadowDepth" | "highlightStrength" | "amount">,
): TimeOfDayParams {
  const { label: _label, ...preset } = TIME_OF_DAY_PROFILES[mode].presets[0];
  return {
    mode,
    ...preset,
    shadowDepth: keep?.shadowDepth ?? 0.6,
    highlightStrength: keep?.highlightStrength ?? 0.6,
    amount: keep?.amount ?? 100,
  };
}

// Hue → OKLab direction is a few colour conversions; plan entries are
// immutable, so memoise per params object.
const directionCache = new WeakMap<
  TimeOfDayParams,
  { tint: [number, number]; shadow: [number, number]; light: [number, number] }
>();

function directions(p: TimeOfDayParams): {
  tint: [number, number];
  shadow: [number, number];
  light: [number, number];
} {
  let d = directionCache.get(p);
  if (!d) {
    d = {
      tint: hueDirection(p.tintHue),
      shadow: hueDirection(p.shadowHue),
      light: hueDirection(p.lightHue),
    };
    directionCache.set(p, d);
  }
  return d;
}

export const TimeOfDayEffect: IPipelineEffect<TimeOfDayEffectLayer, TimeOfDayOp> = {
  id: "time-of-day",
  label: "Time of Day…",
  menu: { root: "adjustments", submenu: "adj-color" },
  defaultParams: timeOfDayModeParams("night"),
  paramFields: [
    // Switching mode loads that mode's lead preset, as the panel's mode
    // buttons do; the sliders below are applied after it and override it.
    customField<TimeOfDayParams>({
      id: "mode",
      label: "Time of Day",
      spec: {
        kind: "enum",
        options: TIME_OF_DAY_MODES.map((m) => ({ value: m, label: TIME_OF_DAY_PROFILES[m].label })),
      },
      get: (p) => p.mode,
      set: (p, v) => {
        const mode = TIME_OF_DAY_MODES.find((m) => m === v);
        return mode === undefined || mode === p.mode ? p : timeOfDayModeParams(mode, p);
      },
    }),
    numberField("tintHue", "Light Tint", { min: 0, max: 360, int: true }),
    numberField("tintStrength", "Light Strength", { min: 0, max: 1, step: 0.01 }),
    // Day shows this inverted as Exposure (−50..50 → darkness 0.5..−0.5);
    // the other modes show Darkness 0..100. Clamp to the mode's range.
    customField<TimeOfDayParams>({
      id: "darkness",
      label: "Darkness",
      spec: { kind: "float", min: -0.5, max: 1, step: 0.01 },
      get: (p) => p.darkness,
      set: (p, v) => {
        const [lo, hi] = TIME_OF_DAY_PROFILES[p.mode].exposureInverted ? [-0.5, 0.5] : [0, 1];
        const n = typeof v === "number" && Number.isFinite(v) ? v : p.darkness;
        return { ...p, darkness: Math.min(hi, Math.max(lo, n)) };
      },
    }),
    numberField("colorRetention", "Keep Color", { min: 0, max: 1, step: 0.01 }),
    numberField("shadowDepth", "Shadow Depth", { min: 0, max: 1, step: 0.01 }),
    numberField("shadowHue", "Shadow Hue", { min: 0, max: 360, int: true }),
    numberField("highlightStrength", "Highlight Strength", { min: 0, max: 1, step: 0.01 }),
    numberField("lightHue", "Light Hue", { min: 0, max: 360, int: true }),
    numberField("amount", "Amount", { min: 0, max: 100, int: true }),
  ],

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "time-of-day",
      layerId: layer.id,
      params: layer.params,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const p = entry.params;
    const prof = TIME_OF_DAY_PROFILES[p.mode];
    const dir = directions(p);
    // Layout must match `TodParams` in time-of-day.wgsl (20 × f32 = 80 B).
    const f = new Float32Array(20);
    f[0] = dir.tint[0];
    f[1] = dir.tint[1];
    f[2] = dir.shadow[0];
    f[3] = dir.shadow[1];
    f[4] = dir.light[0];
    f[5] = dir.light[1];
    f[6] = p.tintStrength;
    f[7] = p.colorRetention;
    f[8] = 1 - p.darkness * prof.darknessScale;
    f[9] = prof.purkinje;
    f[10] = Math.min(1, prof.purkinje / PURKINJE_FULL);
    f[11] = prof.tintChroma;
    f[12] = prof.shadowChroma;
    f[13] = prof.lightChroma;
    f[14] = p.shadowDepth;
    f[15] = p.highlightStrength;
    f[16] = Math.max(0, Math.min(100, p.amount)) / 100;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("time-of-day", "fs_time_of_day", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      f.buffer,
      entry.selMaskLayer,
    );
  },

  Panel: TimeOfDayPanel,
  icon: TimeOfDayIcon,
};
