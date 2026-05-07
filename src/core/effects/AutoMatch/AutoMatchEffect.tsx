import type { AutoMatchStats, EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { AutoMatchPanel } from "./AutoMatchPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";


  /**
   * Per-source statistics captured by the Auto Match analysis pass. Each
   * value is in linear-display units of 0..1 (luma channels) or raw 0..1
   * sRGB byte/255 (mean R/G/B). `count` is the number of opaque pixels that
   * contributed; when 0 the stats are invalid and the apply pass becomes a
   * pass-through.
   */
export interface AutoMatchParams {
    /** Pixel radius around the parent layer's bounding box used to gather
     *  context (rest-of-image) statistics. */
    samplingDistance: number;
    /** Overall match strength (0..100). 0 = pass-through, 100 = full match. */
    strength: number;
    /** Per-component micro-adjustments (0..200, default 100 = match exactly). */
    brightness: number;
    contrast: number;
    gamma: number;
    color: number;
    /** Saturation match (0..200). Scales the layer's chroma magnitude toward
     *  the surroundings'. 100 = match exactly, 0 = leave saturation alone,
     *  200 = double the match strength (clamped at the per-axis caps). */
    saturation: number;
    /** When true, clamps output luma to the surroundings' max luma. */
    clampHighlights: boolean;
    /** When true, clamps output luma below the surroundings' min luma. */
    clampShadows: boolean;
    /** Cached statistics produced by the analysis pass. Null until first analyze. */
    cachedStats: AutoMatchStats | null;
    /** Bumped every time analysis finishes; forces render-plan recomputation. */
    statsVersion: number;
}

export type AutoMatchEffectLayer = EffectLayerOf<"auto-match", AutoMatchParams>;

type AutoMatchOp = Extract<EffectRenderOp, { kind: "auto-match" }>;

export const AutoMatchEffect: IPipelineEffect<
  AutoMatchEffectLayer,
  AutoMatchOp
> = {
  id: "auto-match",
  label: "Auto Match…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: {
    samplingDistance: 100,
    strength: 100,
    brightness: 0,
    contrast: 100,
    gamma: 100,
    color: 100,
    saturation: 100,
    clampHighlights: true,
    clampShadows: true,
    cachedStats: null,
    statsVersion: 0,
  },

  buildPlanEntry(layer, { mask }) {
    const p = layer.params;
    const stats = p.cachedStats;
    const lz = stats?.layer;
    const cz = stats?.context;
    return {
      kind: "auto-match",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
      layerMeanL: lz?.meanL ?? 0,
      layerStdL: lz?.stdL ?? 0,
      layerMinL: lz?.minL ?? 0,
      layerMaxL: lz?.maxL ?? 1,
      layerMeanR: lz?.meanR ?? 0,
      layerMeanG: lz?.meanG ?? 0,
      layerMeanB: lz?.meanB ?? 0,
      layerChromaMag: lz?.chromaMag ?? 0,
      layerCount: lz?.count ?? 0,
      contextMeanL: cz?.meanL ?? 0,
      contextStdL: cz?.stdL ?? 0,
      contextMinL: cz?.minL ?? 0,
      contextMaxL: cz?.maxL ?? 1,
      contextMeanR: cz?.meanR ?? 0,
      contextMeanG: cz?.meanG ?? 0,
      contextMeanB: cz?.meanB ?? 0,
      contextChromaMag: cz?.chromaMag ?? 0,
      contextCount: cz?.count ?? 0,
      statsVersion: p.statsVersion,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const p = entry.params;
    // AutoMatchParams: 8 × vec4 = 128 bytes
    const buf = new ArrayBuffer(128);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f[0] = entry.layerMeanL;
    f[1] = entry.layerStdL;
    f[2] = entry.layerMinL;
    f[3] = entry.layerMaxL;
    f[4] = entry.layerMeanR;
    f[5] = entry.layerMeanG;
    f[6] = entry.layerMeanB;
    f[7] = entry.layerCount > 0 ? 1 : 0;
    f[8] = entry.contextMeanL;
    f[9] = entry.contextStdL;
    f[10] = entry.contextMinL;
    f[11] = entry.contextMaxL;
    f[12] = entry.contextMeanR;
    f[13] = entry.contextMeanG;
    f[14] = entry.contextMeanB;
    f[15] = entry.contextCount > 0 ? 1 : 0;
    f[16] = p.strength / 100;
    f[17] = p.brightness / 100;
    f[18] = p.contrast / 100;
    f[19] = p.gamma / 100;
    f[20] = p.color / 100;
    f[21] = p.saturation / 100;
    u[24] = p.clampHighlights ? 1 : 0;
    u[25] = p.clampShadows ? 1 : 0;
    f[28] = entry.layerChromaMag;
    f[29] = entry.contextChromaMag;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("auto-match", "fs_auto_match", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: AutoMatchPanel,
};
