import type { CurvesChannel, CurvesChannelCurve, CurvesControlPoint, CurvesPresetRef, CurvesVisualAids, EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import {
  buildCurvesLuts,
  createDefaultCurvesParams,
  nextPointId,
  withDirtyPresetRef,
  type CurvesLuts,
} from "./curves";
import { CurvesPanel } from "./CurvesPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { customField, type EffectParamField } from "../_shared/effectParams";
import type { AdjBinding } from "@/graphics/webgpu/EffectRuntime";

const CurvesIcon = (
  <svg
    viewBox="0 0 12 12"
    fill="none"
    width="12"
    height="12"
    stroke="currentColor"
    strokeWidth="1.1"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M1.5 9.5 C3.2 9.5 3.9 5.8 5.7 5.8 C7 5.8 7.2 7.4 8.7 7.4 C10 7.4 10.5 3.2 10.5 2.2" />
    <circle cx="1.5" cy="9.5" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="10.5" cy="2.2" r="0.8" fill="currentColor" stroke="none" />
  </svg>
);
import {
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";


export interface CurvesParams {
    version: 1;
    channels: Record<CurvesChannel, CurvesChannelCurve>;
    ui: {
      selectedChannel: CurvesChannel;
      visualAids: CurvesVisualAids;
      presetRef: CurvesPresetRef | null;
    };
}

export type CurvesEffectLayer = EffectLayerOf<"curves", CurvesParams>;

type CurvesOp = Extract<EffectRenderOp, { kind: "curves" }>;

const CURVES_BINDINGS: AdjBinding[] = [
  "tex",
  "sampler",
  "tex",
  "uniform",
  "sampler-f", // unused since the LUTs became r32float (read with textureLoad)
  "tex",
  "tex",
  "tex",
  "tex",
];

type CurvesLutTextures = {
  rgb: GPUTexture;
  red: GPUTexture;
  green: GPUTexture;
  blue: GPUTexture;
};

// Module-level state — per-layer-id LUT cache. Keyed by layerId so multiple
// curves layers coexist without trampling each other.
const lutTextures = new Map<string, CurvesLutTextures>();
const lutSources = new Map<string, CurvesLuts>();
const usedThisFrame = new Set<string>();

function ensureLutTextures(
  device: GPUDevice,
  layerId: string,
  luts: CurvesLuts,
): CurvesLutTextures {
  usedThisFrame.add(layerId);
  // `buildCurvesLuts` memoizes per params object, so identity is enough.
  const existing = lutTextures.get(layerId);
  if (existing && lutSources.get(layerId) === luts) return existing;

  const writeLut = (data: Float32Array): GPUTexture => {
    const tex = createTrackedTexture(device, {
      size: { width: 256, height: 1 },
      format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: tex },
      data as Float32Array<ArrayBuffer>,
      { bytesPerRow: 256 * 4, rowsPerImage: 1 },
      { width: 256, height: 1 },
    );
    return tex;
  };

  if (existing) {
    destroyTrackedTexture(existing.rgb);
    destroyTrackedTexture(existing.red);
    destroyTrackedTexture(existing.green);
    destroyTrackedTexture(existing.blue);
  }

  const next: CurvesLutTextures = {
    rgb: writeLut(luts.rgb),
    red: writeLut(luts.red),
    green: writeLut(luts.green),
    blue: writeLut(luts.blue),
  };
  lutTextures.set(layerId, next);
  lutSources.set(layerId, luts);
  return next;
}

// ─── Param fields ───────────────────────────────────────────────────────────

/** Curve points as text: "x,y x,y …" (0–255, rounded). */
function formatCurvePoints(points: readonly CurvesControlPoint[]): string {
  return points.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(" ");
}

const clampCurveByte = (v: number): number =>
  Math.max(0, Math.min(255, Math.round(v)));

/**
 * Parse "x,y x,y …" into a valid point list for `channel`, mirroring what the
 * Curves panel allows: integer 0–255 coordinates, strictly increasing x, and
 * endpoints pinned at x = 0 / x = 255 (their y is free). Missing endpoints
 * keep the existing endpoint's output. Returns null when the text holds no
 * parsable pair.
 */
function parseCurvePoints(
  text: string,
  channel: CurvesChannel,
  existing: readonly CurvesControlPoint[],
): CurvesControlPoint[] | null {
  const byX = new Map<number, number>();
  const pairRe = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/g;
  for (const m of text.matchAll(pairRe)) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    byX.set(clampCurveByte(x), clampCurveByte(y));
  }
  if (byX.size === 0) return null;

  const first = existing[0];
  const last = existing[existing.length - 1];
  if (!byX.has(0)) byX.set(0, first ? clampCurveByte(first.y) : 0);
  if (!byX.has(255)) byX.set(255, last ? clampCurveByte(last.y) : 255);

  const sorted = [...byX.entries()].sort((a, b) => a[0] - b[0]);
  const out: CurvesControlPoint[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const [x, y] = sorted[i];
    const isFirst = i === 0;
    const isLast = i === sorted.length - 1;
    const id =
      isFirst && first
        ? first.id
        : isLast && last
          ? last.id
          : nextPointId(channel, out);
    out.push({ id, x, y });
  }
  return out;
}

function curveField(
  channel: CurvesChannel,
  label: string,
): EffectParamField<CurvesParams> {
  return customField<CurvesParams>({
    id: `${channel}Curve`,
    label,
    spec: { kind: "string", placeholder: "0,0 128,140 255,255" },
    get: (p) => formatCurvePoints(p.channels[channel].points),
    set: (p, v) => {
      const points = parseCurvePoints(
        String(v),
        channel,
        p.channels[channel].points,
      );
      if (!points) return p;
      return {
        ...p,
        channels: { ...p.channels, [channel]: { points } },
        ui: {
          ...p.ui,
          presetRef: withDirtyPresetRef(p.ui.presetRef, true),
        },
      };
    },
  });
}

export const CurvesEffect: IPipelineEffect<CurvesEffectLayer, CurvesOp> = {
  id: "curves",
  label: "Curves…",
  menu: { root: "adjustments", submenu: "adj-tone" },
  defaultParams: createDefaultCurvesParams(),
  paramFields: [
    curveField("rgb", "RGB Curve"),
    curveField("red", "Red Curve"),
    curveField("green", "Green Curve"),
    curveField("blue", "Blue Curve"),
  ],

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "curves",
      layerId: layer.id,
      params: layer.params,
      luts: buildCurvesLuts(layer.params),
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const { runtime } = engine;
    const pair = runtime.getRenderPipelinePair(
      "curves",
      "fs_curves",
      CURVES_BINDINGS,
    );
    const pipeline = runtime.selectPipeline(pair, format);
    const textures = ensureLutTextures(runtime.device, entry.layerId, entry.luts);

    const maskFlagsBuf = runtime.makeMaskFlagsBuf(!!entry.selMaskLayer, format === "rgba16float" || format === "rgba32float");
    const dummyMask = entry.selMaskLayer?.texture ?? srcTex;

    runtime.encodeRenderPass(encoder, pipeline, dstTex, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: runtime.adjSampler },
      { binding: 2, resource: dummyMask.createView() },
      { binding: 3, resource: { buffer: maskFlagsBuf } },
      { binding: 4, resource: runtime.lutSampler },
      { binding: 5, resource: textures.rgb.createView() },
      { binding: 6, resource: textures.red.createView() },
      { binding: 7, resource: textures.green.createView() },
      { binding: 8, resource: textures.blue.createView() },
    ], pair.bgl);
  },

  onFrameEnd() {
    for (const [layerId, luts] of lutTextures) {
      if (usedThisFrame.has(layerId)) continue;
      destroyTrackedTexture(luts.rgb);
      destroyTrackedTexture(luts.red);
      destroyTrackedTexture(luts.green);
      destroyTrackedTexture(luts.blue);
      lutTextures.delete(layerId);
      lutSources.delete(layerId);
    }
    usedThisFrame.clear();
  },

  onDestroy() {
    for (const luts of lutTextures.values()) {
      destroyTrackedTexture(luts.rgb);
      destroyTrackedTexture(luts.red);
      destroyTrackedTexture(luts.green);
      destroyTrackedTexture(luts.blue);
    }
    lutTextures.clear();
    lutSources.clear();
    usedThisFrame.clear();
  },

  Panel: CurvesPanel,
  icon: CurvesIcon,
};
