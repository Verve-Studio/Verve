import type { EffectLayerOf, RGBAColor } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { InnerShadowOptions } from "./InnerShadowOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import {
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";
import type { EffectRuntime } from "@/graphics/webgpu/EffectRuntime";


export interface InnerShadowParams {
    /** Shadow color including alpha. r/g/b/a are 0–255. */
    color: RGBAColor;
    /** Overall shadow opacity, 0–100 (%). */
    opacity: number;
    /** Horizontal offset in pixels, −200 to +200. */
    offsetX: number;
    /** Vertical offset in pixels, −200 to +200. */
    offsetY: number;
    /** Erosion radius in pixels, 0–100. Controls spread of shadow inside shape. */
    spread: number;
    /** Blur radius in pixels, 0–100. Controls softness of shadow edges. */
    softness: number;
}

export type InnerShadowEffectLayer = EffectLayerOf<"inner-shadow", InnerShadowParams>;

type InnerShadowOp = Extract<EffectRenderOp, { kind: "inner-shadow" }>;

let texCache: {
  tempA: GPUTexture;
  tempB: GPUTexture;
  format: GPUTextureFormat;
} | null = null;
let usedThisFrame = false;

/** Scratch textures for the erode+blur ping-pong. Allocated in the doc
 *  format so the entire pipeline stays in f32 on HDR documents. */
function ensureTextures(
  device: GPUDevice,
  width: number,
  height: number,
  format: GPUTextureFormat,
): { tempA: GPUTexture; tempB: GPUTexture } {
  usedThisFrame = true;
  if (texCache && texCache.format === format) return texCache;
  if (texCache) {
    destroyTrackedTexture(texCache.tempA);
    destroyTrackedTexture(texCache.tempB);
    texCache = null;
  }
  const usage =
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.STORAGE_BINDING |
    GPUTextureUsage.COPY_DST |
    GPUTextureUsage.COPY_SRC;
  const make = (): GPUTexture =>
    createTrackedTexture(device, {
      size: { width, height },
      format,
      usage,
    });
  texCache = { tempA: make(), tempB: make(), format };
  return texCache;
}

/** Shared inner-shadow encode used by InnerShadow and InnerGlow effects. */
export function encodeInnerShadowPass(
  runtime: EffectRuntime,
  encoder: GPUCommandEncoder,
  srcTex: GPUTexture,
  dstTex: GPUTexture,
  args: {
    colorR: number;
    colorG: number;
    colorB: number;
    colorA: number;
    opacity: number;
    offsetX: number;
    offsetY: number;
    spread: number;
    softness: number;
    selMaskLayer: { texture: GPUTexture } | undefined;
  },
): void {
  const { device, pixelWidth: w, pixelHeight: h } = runtime;
  // Scratch + every compute pipeline in this pass runs in the doc format.
  const { tempA, tempB } = ensureTextures(device, w, h, dstTex.format);
  const erodeH = runtime.getComputePipelineForStorageFormat(
    "outline-erode-h",
    "cs_outline_erode_h",
    dstTex,
  );
  const erodeV = runtime.getComputePipelineForStorageFormat(
    "outline-erode-v",
    "cs_outline_erode_v",
    dstTex,
  );
  const blurH = runtime.getComputePipelineForStorageFormat(
    "drop-shadow-blur-h",
    "cs_shadow_blur_h",
    dstTex,
  );
  const blurV = runtime.getComputePipelineForStorageFormat(
    "drop-shadow-blur-v",
    "cs_shadow_blur_v",
    dstTex,
  );
  const composite = runtime.getComputePipelineForStorageFormat(
    "inner-shadow-composite",
    "cs_inner_shadow_composite",
    dstTex,
  );

  const erodeR = Math.round(args.spread);
  const blurR =
    args.softness > 0 ? Math.max(1, Math.round(args.softness * 0.577)) : 0;

  const dispatch = (
    pipeline: GPUComputePipeline,
    src: GPUTexture,
    dst: GPUTexture,
    paramsBuf: GPUBuffer,
  ): void => {
    const bg = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: dst.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
      ],
    });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
  };

  const erodeParamsBuf = runtime.makeParamsBuf(
    new Uint32Array([erodeR, 0, 0, 0]),
  );
  dispatch(erodeH, srcTex, tempA, erodeParamsBuf);
  dispatch(erodeV, tempA, tempB, erodeParamsBuf);

  let maskTex: GPUTexture = tempB;
  if (args.softness > 0) {
    const blurParamsBuf = runtime.makeParamsBuf(
      new Uint32Array([blurR, 0, 0, 0]),
    );
    let src = tempB;
    let dst = tempA;
    for (let i = 0; i < 3; i++) {
      dispatch(blurH, src, dst, blurParamsBuf);
      [src, dst] = [dst, src];
      dispatch(blurV, src, dst, blurParamsBuf);
      [src, dst] = [dst, src];
    }
    maskTex = src;
  }

  // Composite
  const compBuf = new ArrayBuffer(32);
  const cf = new Float32Array(compBuf);
  const ci = new Int32Array(compBuf);
  cf[0] = args.colorR;
  cf[1] = args.colorG;
  cf[2] = args.colorB;
  cf[3] = args.colorA;
  cf[4] = args.opacity;
  ci[5] = args.offsetX;
  ci[6] = args.offsetY;

  const compParamsBuf = runtime.makeParamsBuf(compBuf);
  const maskFlagsBuf = runtime.makeMaskFlagsBuf(!!args.selMaskLayer);
  const dummyMask = args.selMaskLayer?.texture ?? srcTex;

  const compBG = device.createBindGroup({
    layout: composite.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: maskTex.createView() },
      { binding: 2, resource: dstTex.createView() },
      { binding: 3, resource: { buffer: compParamsBuf } },
      { binding: 4, resource: dummyMask.createView() },
      { binding: 5, resource: { buffer: maskFlagsBuf } },
    ],
  });
  const compPass = encoder.beginComputePass();
  compPass.setPipeline(composite);
  compPass.setBindGroup(0, compBG);
  compPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
  compPass.end();
}

export const innerShadowCache = {
  onFrameEnd(): void {
    if (!usedThisFrame && texCache) {
      destroyTrackedTexture(texCache.tempA);
      destroyTrackedTexture(texCache.tempB);
      texCache = null;
    }
    usedThisFrame = false;
  },
  onDestroy(): void {
    if (texCache) {
      destroyTrackedTexture(texCache.tempA);
      destroyTrackedTexture(texCache.tempB);
      texCache = null;
    }
  },
};

export const InnerShadowEffect: IPipelineEffect<
  InnerShadowEffectLayer,
  InnerShadowOp
> = {
  id: "inner-shadow",
  label: "Inner Shadow…",
  menu: { root: "effects", submenu: "fx-shadow" },
  defaultParams: {
    color: { r: 0, g: 0, b: 0, a: 255 },
    opacity: 75,
    offsetX: 5,
    offsetY: 5,
    spread: 0,
    softness: 10,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "inner-shadow",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex }, entry) {
    const { color, opacity, offsetX, offsetY, spread, softness } = entry.params;
    encodeInnerShadowPass(engine.runtime, encoder, srcTex, dstTex, {
      colorR: color.r / 255,
      colorG: color.g / 255,
      colorB: color.b / 255,
      colorA: color.a / 255,
      opacity: opacity / 100,
      offsetX,
      offsetY,
      spread,
      softness,
      selMaskLayer: entry.selMaskLayer,
    });
  },

  onFrameEnd: innerShadowCache.onFrameEnd,
  onDestroy: innerShadowCache.onDestroy,

  Panel: InnerShadowOptions,
};
