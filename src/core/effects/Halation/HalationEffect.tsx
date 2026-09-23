import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { HalationOptions } from "./HalationOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";
import { BLOOM_COMPOSITE_BINDINGS } from "../Bloom/BloomEffect";
import {
  createTrackedTexture,
} from "@/core/store/memoryStore";
import { TextureSetCache } from "../_shared/textureSetCache";
import type { EffectRuntime } from "@/graphics/webgpu/EffectRuntime";

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

const texCache = new TextureSetCache<{ glowATex: GPUTexture; glowBTex: GPUTexture }>();

/** Glow ping-pong scratch. Allocated in the doc format so the warm
 *  halation glow keeps full HDR precision on f32 documents. */
function ensureTextures(
  runtime: EffectRuntime,
  width: number,
  height: number,
  format: GPUTextureFormat,
): { glowATex: GPUTexture; glowBTex: GPUTexture } {
  const usage =
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.RENDER_ATTACHMENT |
    GPUTextureUsage.COPY_DST;
  const make = (): GPUTexture =>
    createTrackedTexture(runtime.device, {
      size: { width, height },
      format,
      usage,
    });
  return texCache.get(runtime, `${width}x${height}:${format}`, () => ({
    glowATex: make(), glowBTex: make(),
  }));
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
    // The glow is blurred at half resolution: up to 5 iterations × H+V of a
    // ~200-tap box blur used to run at full resolution. The composite
    // samples the glow back up.
    const gw = Math.ceil(w / 2);
    const gh = Math.ceil(h / 2);
    const { glowATex, glowBTex } = ensureTextures(runtime, gw, gh, format);
    // Full-res extract target, only needed for this encode.
    const extractTex = createTrackedTexture(runtime.device, {
      size: { width: w, height: h },
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    runtime.pendingDestroyTextures.push(extractTex);

    const dummyMask = entry.selMaskLayer?.texture ?? srcTex;
    const maskFlagsBuf = runtime.makeMaskFlagsBuf(!!entry.selMaskLayer, format === "rgba16float" || format === "rgba32float");

    // Pass 1: Extract — target format matches the scratch (doc format).
    const extract = runtime.getRenderPipelineWithBGL(
      "halation-extract",
      "fs_halation_extract",
      format,
      STD_BINDINGS,
    );
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

    // Box-filter 2× downsample into the glow buffer (shared bloom shader).
    const downsample = runtime.getRenderPipelineAuto(
      "bloom-downsample",
      "fs_bloom_downsample",
      format,
    );
    runtime.encodeRenderPass(
      encoder,
      downsample,
      glowATex,
      [
        { binding: 0, resource: extractTex.createView() },
        { binding: 2, resource: { buffer: runtime.makeParamsBuf(new Uint32Array([2, 0, 0, 0])) } },
      ],
      downsample.getBindGroupLayout(0),
    );

    // Passes 2..N: H+V box blur iterations (shared bloom pipelines), at half
    // resolution, so the radius is halved to keep the same visual spread.
    const blurRadius = Math.max(1, Math.round(entry.params.spread / 2));
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
    texCache.onFrameEnd();
  },

  onDestroy() {
    texCache.destroyAll();
  },

  Panel: HalationOptions,
  icon: HalationIcon,
};
