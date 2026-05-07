import type { InnerShadowAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { InnerShadowOptions } from "./InnerShadowOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import {
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";
import type { AdjustmentRuntime } from "@/graphicspipeline/webgpu/AdjustmentRuntime";

type InnerShadowOp = Extract<AdjustmentRenderOp, { kind: "inner-shadow" }>;

let texCache: { tempA: GPUTexture; tempB: GPUTexture } | null = null;
let usedThisFrame = false;

function ensureTextures(
  device: GPUDevice,
  width: number,
  height: number,
): { tempA: GPUTexture; tempB: GPUTexture } {
  usedThisFrame = true;
  if (texCache) return texCache;
  const usage =
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.STORAGE_BINDING |
    GPUTextureUsage.COPY_DST |
    GPUTextureUsage.COPY_SRC;
  const make = (): GPUTexture =>
    createTrackedTexture(device, {
      size: { width, height },
      format: "rgba8unorm",
      usage,
    });
  texCache = { tempA: make(), tempB: make() };
  return texCache;
}

/** Shared inner-shadow encode used by InnerShadow and InnerGlow effects. */
export function encodeInnerShadowPass(
  runtime: AdjustmentRuntime,
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
  const { tempA, tempB } = ensureTextures(device, w, h);

  const erodeH = runtime.getComputePipeline(
    "outline-erode-h",
    "cs_outline_erode_h",
  );
  const erodeV = runtime.getComputePipeline(
    "outline-erode-v",
    "cs_outline_erode_v",
  );
  const blurH = runtime.getComputePipeline(
    "drop-shadow-blur-h",
    "cs_shadow_blur_h",
  );
  const blurV = runtime.getComputePipeline(
    "drop-shadow-blur-v",
    "cs_shadow_blur_v",
  );
  const composite = runtime.getComputePipeline(
    "inner-shadow-composite",
    "cs_inner_shadow_composite",
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
  InnerShadowAdjustmentLayer,
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
    const { color, opacity, offsetX, offsetY, spread, softness } = layer.params;
    return {
      kind: "inner-shadow",
      layerId: layer.id,
      colorR: color.r / 255,
      colorG: color.g / 255,
      colorB: color.b / 255,
      colorA: color.a / 255,
      opacity: opacity / 100,
      offsetX,
      offsetY,
      spread,
      softness,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex }, entry) {
    encodeInnerShadowPass(engine.runtime, encoder, srcTex, dstTex, {
      colorR: entry.colorR,
      colorG: entry.colorG,
      colorB: entry.colorB,
      colorA: entry.colorA,
      opacity: entry.opacity,
      offsetX: entry.offsetX,
      offsetY: entry.offsetY,
      spread: entry.spread,
      softness: entry.softness,
      selMaskLayer: entry.selMaskLayer,
    });
  },

  onFrameEnd: innerShadowCache.onFrameEnd,
  onDestroy: innerShadowCache.onDestroy,

  Panel: InnerShadowOptions,
};
