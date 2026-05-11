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

const HalationIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    aria-hidden="true"
  >
    <circle cx="6" cy="6" r="1.8" fill="#e05a20" />
    <circle
      cx="6"
      cy="6"
      r="3.4"
      stroke="#e05a20"
      strokeWidth="0.9"
      opacity="0.55"
    />
    <circle
      cx="6"
      cy="6"
      r="5"
      stroke="#e05a20"
      strokeWidth="0.7"
      opacity="0.25"
    />
  </svg>
);


export interface HalationParams {
    threshold: number; // 0–1: luminance level above which halation activates
    spread: number; // 0–100 px: blur radius
    blur: number; // 1–5: number of H+V blur iterations (more = softer)
    strength: number; // 0–1: composite intensity
}

export type HalationEffectLayer = EffectLayerOf<"halation", HalationParams>;

type HalationOp = Extract<EffectRenderOp, { kind: "halation" }>;

let texCache: {
  glowATex: GPUTexture;
  glowBTex: GPUTexture;
  format: GPUTextureFormat;
} | null = null;
let usedThisFrame = false;

/** Glow ping-pong scratch. Allocated in the doc format so the warm
 *  halation glow keeps full HDR precision on f32 documents. */
function ensureTextures(
  device: GPUDevice,
  width: number,
  height: number,
  format: GPUTextureFormat,
): { glowATex: GPUTexture; glowBTex: GPUTexture } {
  usedThisFrame = true;
  if (texCache && texCache.format === format) return texCache;
  if (texCache) {
    destroyTrackedTexture(texCache.glowATex);
    destroyTrackedTexture(texCache.glowBTex);
    texCache = null;
  }
  const usage =
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.RENDER_ATTACHMENT |
    GPUTextureUsage.COPY_DST;
  const make = (): GPUTexture =>
    createTrackedTexture(device, {
      size: { width, height },
      format,
      usage,
    });
  texCache = { glowATex: make(), glowBTex: make(), format };
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
    const { glowATex, glowBTex } = ensureTextures(runtime.device, w, h, format);

    const dummyMask = entry.selMaskLayer?.texture ?? srcTex;
    const maskFlagsBuf = runtime.makeMaskFlagsBuf(!!entry.selMaskLayer);

    // Pass 1: Extract — target format matches the scratch (doc format).
    const extract = runtime.getRenderPipelineWithBGL(
      "halation-extract",
      "fs_halation_extract",
      format,
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
  icon: HalationIcon,
};
