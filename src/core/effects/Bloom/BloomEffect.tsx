import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { BloomOptions } from "./BloomOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import {
  STD_BINDINGS,
  type AdjBinding,
} from "@/graphics/webgpu/EffectRuntime";
import {
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";

const BloomIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.1"
    aria-hidden="true"
  >
    <circle cx="6" cy="6" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="6" cy="6" r="3" opacity="0.6" />
    <circle cx="6" cy="6" r="4.5" opacity="0.3" />
  </svg>
);


export interface BloomParams {
    threshold: number;
    strength: number;
    spread: number;
    quality: "full" | "half" | "quarter";
}

export type BloomEffectLayer = EffectLayerOf<"bloom", BloomParams>;

type BloomOp = Extract<EffectRenderOp, { kind: "bloom" }>;

// Composite binding pattern: srcTex, sampler, glowTex, params, selMask, maskFlags.
const COMPOSITE_BINDINGS: AdjBinding[] = [
  "tex",
  "sampler",
  "tex",
  "uniform",
  "tex",
  "uniform",
];

type BloomQuality = "full" | "half" | "quarter";

// Module-level texture cache for the bloom intermediate buffers.
let texCache: {
  quality: BloomQuality;
  format: GPUTextureFormat;
  extractTex: GPUTexture;
  blurATex: GPUTexture;
  blurBTex: GPUTexture;
} | null = null;
let usedThisFrame = false;

/** Scratch buffers for extract + downsampled blur ping-pong. Allocated in
 *  the doc format because the whole point of Bloom on HDR is to bloom
 *  pixels > 1.0 — clamping the extract output to rgba8 [0,1] would erase
 *  the highlights the effect is supposed to catch. */
function ensureTextures(
  device: GPUDevice,
  width: number,
  height: number,
  quality: BloomQuality,
  format: GPUTextureFormat,
): { extractTex: GPUTexture; blurATex: GPUTexture; blurBTex: GPUTexture } {
  usedThisFrame = true;
  if (texCache && texCache.quality === quality && texCache.format === format) {
    return texCache;
  }
  if (texCache) {
    destroyTrackedTexture(texCache.extractTex);
    destroyTrackedTexture(texCache.blurATex);
    destroyTrackedTexture(texCache.blurBTex);
  }
  const scaleFactor = quality === "full" ? 1 : quality === "half" ? 2 : 4;
  const bw = Math.ceil(width / scaleFactor);
  const bh = Math.ceil(height / scaleFactor);
  const usage =
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.RENDER_ATTACHMENT |
    GPUTextureUsage.COPY_DST |
    GPUTextureUsage.COPY_SRC;
  const make = (tw: number, th: number): GPUTexture =>
    createTrackedTexture(device, {
      size: { width: tw, height: th },
      format,
      usage,
    });
  texCache = {
    quality,
    format,
    extractTex: make(width, height),
    blurATex: make(bw, bh),
    blurBTex: make(bw, bh),
  };
  return texCache;
}

export const BloomEffect: IPipelineEffect<BloomEffectLayer, BloomOp> = {
  id: "bloom",
  label: "Bloom…",
  menu: { root: "effects", submenu: "fx-lenseffects" },
  defaultParams: {
    threshold: 0.5,
    strength: 0.5,
    spread: 20,
    quality: "half",
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "bloom",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const { runtime } = engine;
    const w = runtime.pixelWidth;
    const h = runtime.pixelHeight;
    // Scratch is allocated in the doc format so HDR highlights (>1.0)
    // survive the extract+blur ping-pong without being clamped.
    const { extractTex, blurATex, blurBTex } = ensureTextures(
      runtime.device,
      w,
      h,
      entry.params.quality,
      format,
    );

    const scaleFactor =
      entry.params.quality === "full" ? 1 : entry.params.quality === "half" ? 2 : 4;
    const blurRadius = Math.max(1, Math.round(entry.params.spread / scaleFactor));

    const dummyMask = entry.selMaskLayer?.texture ?? srcTex;
    const maskFlagsBuf = runtime.makeMaskFlagsBuf(!!entry.selMaskLayer, format === "rgba16float" || format === "rgba32float");

    // Pass 1: Extract — target format matches the scratch (doc format).
    const extract = runtime.getRenderPipelineWithBGL(
      "bloom-extract",
      "fs_bloom_extract",
      format,
      STD_BINDINGS,
    );
    // Forward the doc-format flag to both extract + composite shaders so
    // the perceptual envelope kicks in for rgba32f docs (threshold + screen
    // blend get sRGB-encoded before the math, decoded back on the way out).
    const isLinear = format === "rgba16float" || format === "rgba32float";
    const extractParamsBuf = runtime.makeParamsBuf(
      new Float32Array([entry.params.threshold, isLinear ? 1 : 0, 0, 0]),
    );
    runtime.encodeRenderPass(
      encoder,
      extract.pipeline,
      extractTex,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: runtime.adjSampler },
        { binding: 2, resource: { buffer: extractParamsBuf } },
        { binding: 3, resource: dummyMask.createView() },
        { binding: 4, resource: { buffer: maskFlagsBuf } },
      ],
      extract.bgl,
    );

    // Pass 2: Downsample (skipped at full quality)
    let workingSrc = blurATex;
    let workingDst = blurBTex;

    if (entry.params.quality !== "full") {
      const downsamplePipeline = runtime.getRenderPipelineAuto(
        "bloom-downsample",
        "fs_bloom_downsample",
        format,
      );
      const dsParamsBuf = runtime.makeParamsBuf(
        new Uint32Array([scaleFactor, 0, 0, 0]),
      );
      runtime.encodeRenderPass(
        encoder,
        downsamplePipeline,
        blurATex,
        [
          { binding: 0, resource: extractTex.createView() },
          { binding: 2, resource: { buffer: dsParamsBuf } },
        ],
        downsamplePipeline.getBindGroupLayout(0),
      );
    } else {
      encoder.copyTextureToTexture(
        { texture: extractTex },
        { texture: blurATex },
        { width: w, height: h },
      );
    }

    // Passes 3–8: 3 × H+V box blur (shared with halation)
    const boxH = runtime.getRenderPipelineAuto(
      "bloom-blur-h",
      "fs_bloom_blur_h",
      format,
    );
    const boxV = runtime.getRenderPipelineAuto(
      "bloom-blur-v",
      "fs_bloom_blur_v",
      format,
    );
    const blurParamsBuf = runtime.makeParamsBuf(
      new Uint32Array([blurRadius, 0, 0, 0]),
    );
    const boxHBGL = boxH.getBindGroupLayout(0);
    const boxVBGL = boxV.getBindGroupLayout(0);
    for (let i = 0; i < 3; i++) {
      runtime.encodeRenderPass(encoder, boxH, workingDst, [
        { binding: 0, resource: workingSrc.createView() },
        { binding: 2, resource: { buffer: blurParamsBuf } },
      ], boxHBGL);
      [workingSrc, workingDst] = [workingDst, workingSrc];

      runtime.encodeRenderPass(encoder, boxV, workingDst, [
        { binding: 0, resource: workingSrc.createView() },
        { binding: 2, resource: { buffer: blurParamsBuf } },
      ], boxVBGL);
      [workingSrc, workingDst] = [workingDst, workingSrc];
    }

    // Pass 9: Composite
    const compPair = runtime.getRenderPipelinePair(
      "bloom-composite",
      "fs_bloom_composite",
      COMPOSITE_BINDINGS,
    );
    const compPipeline = runtime.selectPipeline(compPair, format);
    const compParamsBuf = runtime.makeParamsBuf(
      new Float32Array([entry.params.strength, isLinear ? 1 : 0, 0, 0]),
    );
    runtime.encodeRenderPass(
      encoder,
      compPipeline,
      dstTex,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: runtime.adjSampler },
        { binding: 2, resource: workingSrc.createView() },
        { binding: 3, resource: { buffer: compParamsBuf } },
        { binding: 4, resource: dummyMask.createView() },
        { binding: 5, resource: { buffer: maskFlagsBuf } },
      ],
      compPair.bgl,
    );
  },

  onFrameEnd() {
    if (!usedThisFrame && texCache) {
      destroyTrackedTexture(texCache.extractTex);
      destroyTrackedTexture(texCache.blurATex);
      destroyTrackedTexture(texCache.blurBTex);
      texCache = null;
    }
    usedThisFrame = false;
  },

  onDestroy() {
    if (texCache) {
      destroyTrackedTexture(texCache.extractTex);
      destroyTrackedTexture(texCache.blurATex);
      destroyTrackedTexture(texCache.blurBTex);
      texCache = null;
    }
  },

  Panel: BloomOptions,
  icon: BloomIcon,
};

/** Exported so HalationEffect (and friends) can reuse the composite pipeline. */
export const BLOOM_COMPOSITE_BINDINGS = COMPOSITE_BINDINGS;
