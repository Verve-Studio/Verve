import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { HalationOptions } from "./HalationOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";
import { BLOOM_COMPOSITE_BINDINGS } from "../Bloom/BloomEffect";
import {
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";


export interface HalationParams {
    threshold: number; // 0–1: luminance level above which halation activates
    spread: number; // 0–100 px: blur radius
    blur: number; // 1–5: number of H+V blur iterations (more = softer)
    strength: number; // 0–1: composite intensity
}

export type HalationEffectLayer = EffectLayerOf<"halation", HalationParams>;

type HalationOp = Extract<EffectRenderOp, { kind: "halation" }>;

let texCache: { glowATex: GPUTexture; glowBTex: GPUTexture } | null = null;
let usedThisFrame = false;

function ensureTextures(
  device: GPUDevice,
  width: number,
  height: number,
): { glowATex: GPUTexture; glowBTex: GPUTexture } {
  usedThisFrame = true;
  if (texCache) return texCache;
  const usage =
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.RENDER_ATTACHMENT |
    GPUTextureUsage.COPY_DST;
  const make = (): GPUTexture =>
    createTrackedTexture(device, {
      size: { width, height },
      format: "rgba8unorm",
      usage,
    });
  texCache = { glowATex: make(), glowBTex: make() };
  return texCache;
}

export const HalationEffect: IPipelineEffect<
  HalationEffectLayer,
  HalationOp
> = {
  id: "halation",
  label: "Halation…",
  menu: { root: "effects", submenu: "fx-lenseffects" },
  defaultParams: { threshold: 0.5, spread: 30, blur: 2, strength: 0.6 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "halation",
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
    const { glowATex, glowBTex } = ensureTextures(runtime.device, w, h);

    const dummyMask = entry.selMaskLayer?.texture ?? srcTex;
    const maskFlagsBuf = runtime.makeMaskFlagsBuf(!!entry.selMaskLayer);

    // Pass 1: Extract — needs explicit BGL
    const extract = runtime.getRenderPipelineWithBGL(
      "halation-extract",
      "fs_halation_extract",
      "rgba8unorm",
      STD_BINDINGS,
    );
    const extractParamsBuf = runtime.makeParamsBuf(
      new Float32Array([entry.params.threshold, 0, 0, 0]),
    );
    runtime.encodeRenderPass(
      encoder,
      extract.pipeline,
      glowATex,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: runtime.adjSampler },
        { binding: 2, resource: { buffer: extractParamsBuf } },
        { binding: 3, resource: dummyMask.createView() },
        { binding: 4, resource: { buffer: maskFlagsBuf } },
      ],
      extract.bgl,
    );

    // Passes 2..N: H+V box blur iterations (shared bloom pipelines)
    const blurRadius = Math.max(1, Math.round(entry.params.spread));
    const iterations = Math.max(1, Math.min(5, Math.round(entry.params.blur)));
    const boxH = runtime.getRenderPipelineAuto(
      "bloom-blur-h",
      "fs_bloom_blur_h",
      "rgba8unorm",
    );
    const boxV = runtime.getRenderPipelineAuto(
      "bloom-blur-v",
      "fs_bloom_blur_v",
      "rgba8unorm",
    );
    const blurParamsBuf = runtime.makeParamsBuf(
      new Uint32Array([blurRadius, 0, 0, 0]),
    );
    const boxHBGL = boxH.getBindGroupLayout(0);
    const boxVBGL = boxV.getBindGroupLayout(0);

    let workingSrc = glowATex;
    let workingDst = glowBTex;
    for (let i = 0; i < iterations; i++) {
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

    // Final pass: composite warm glow over source (reuse bloom-composite shader)
    const compPair = runtime.getRenderPipelinePair(
      "bloom-composite",
      "fs_bloom_composite",
      BLOOM_COMPOSITE_BINDINGS,
    );
    const compPipeline = runtime.selectPipeline(compPair, format);
    const compParamsBuf = runtime.makeParamsBuf(
      new Float32Array([entry.params.strength, 0, 0, 0]),
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
      destroyTrackedTexture(texCache.glowATex);
      destroyTrackedTexture(texCache.glowBTex);
      texCache = null;
    }
    usedThisFrame = false;
  },

  onDestroy() {
    if (texCache) {
      destroyTrackedTexture(texCache.glowATex);
      destroyTrackedTexture(texCache.glowBTex);
      texCache = null;
    }
  },

  Panel: HalationOptions,
};
