import type { EffectLayerOf, RGBAColor } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { DropShadowOptions } from "./DropShadowOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import {
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";
import type { EffectRuntime } from "@/graphics/webgpu/EffectRuntime";


export interface DropShadowParams {
    /** Shadow color including alpha channel. r/g/b/a are 0–255. Default: { r:0, g:0, b:0, a:255 } */
    color: RGBAColor;
    /** Overall shadow opacity, 0–100 (%). Applied on top of color.a. Default: 75 */
    opacity: number;
    /** Horizontal offset in canvas pixels, −200 to +200. Default: 5 */
    offsetX: number;
    /** Vertical offset in canvas pixels, −200 to +200. Default: 5 */
    offsetY: number;
    /** Morphological dilation radius in pixels, 0–100. Default: 0 */
    spread: number;
    /** Gaussian blur radius in pixels, 0–100. Default: 10 */
    softness: number;
    /** How the shadow composites with layers beneath it. Default: 'multiply' */
    blendMode: "normal" | "multiply" | "screen";
    /** When true, the shadow is masked by the inverse of the source alpha. Default: true */
    knockout: boolean;
}

export type DropShadowEffectLayer = EffectLayerOf<"drop-shadow", DropShadowParams>;

type DropShadowOp = Extract<EffectRenderOp, { kind: "drop-shadow" }>;

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

const BLEND_MODE_MAP: Record<"normal" | "multiply" | "screen", number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
};

/**
 * Shared drop-shadow encode logic. Used by both DropShadow and Glow effects
 * (Glow is drop-shadow with offsetX/offsetY = 0).
 */
export function encodeDropShadowPass(
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
    blendMode: "normal" | "multiply" | "screen";
    knockout: boolean;
    selMaskLayer:
      | { texture: GPUTexture }
      | undefined;
  },
): void {
  const { device, pixelWidth: w, pixelHeight: h } = runtime;
  const { tempA, tempB } = ensureTextures(device, w, h);

  const dilateH = runtime.getComputePipeline(
    "drop-shadow-dilate-h",
    "cs_shadow_dilate_h",
  );
  const dilateV = runtime.getComputePipeline(
    "drop-shadow-dilate-v",
    "cs_shadow_dilate_v",
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
    "drop-shadow-composite",
    "cs_shadow_composite",
  );

  const spreadR = Math.round(args.spread);
  const blurR =
    args.softness > 0 ? Math.max(1, Math.round(args.softness * 0.577)) : 0;

  const dilateParamsBuf = runtime.makeParamsBuf(
    new Uint32Array([spreadR, 0, 0, 0]),
  );

  // Pass 1: DilateH
  const dilateHBG = device.createBindGroup({
    layout: dilateH.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: tempA.createView() },
      { binding: 2, resource: { buffer: dilateParamsBuf } },
    ],
  });
  const p1 = encoder.beginComputePass();
  p1.setPipeline(dilateH);
  p1.setBindGroup(0, dilateHBG);
  p1.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
  p1.end();

  // Pass 2: DilateV
  const dilateVBG = device.createBindGroup({
    layout: dilateV.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: tempA.createView() },
      { binding: 1, resource: tempB.createView() },
      { binding: 2, resource: { buffer: dilateParamsBuf } },
    ],
  });
  const p2 = encoder.beginComputePass();
  p2.setPipeline(dilateV);
  p2.setBindGroup(0, dilateVBG);
  p2.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
  p2.end();

  // Optional blur passes
  let maskTex: GPUTexture = tempB;
  if (args.softness > 0) {
    const blurParamsBuf = runtime.makeParamsBuf(
      new Uint32Array([blurR, 0, 0, 0]),
    );
    let workingSrc = tempB;
    let workingDst = tempA;
    for (let i = 0; i < 3; i++) {
      const hBG = device.createBindGroup({
        layout: blurH.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: workingSrc.createView() },
          { binding: 1, resource: workingDst.createView() },
          { binding: 2, resource: { buffer: blurParamsBuf } },
        ],
      });
      const hPass = encoder.beginComputePass();
      hPass.setPipeline(blurH);
      hPass.setBindGroup(0, hBG);
      hPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      hPass.end();
      [workingSrc, workingDst] = [workingDst, workingSrc];

      const vBG = device.createBindGroup({
        layout: blurV.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: workingSrc.createView() },
          { binding: 1, resource: workingDst.createView() },
          { binding: 2, resource: { buffer: blurParamsBuf } },
        ],
      });
      const vPass = encoder.beginComputePass();
      vPass.setPipeline(blurV);
      vPass.setBindGroup(0, vBG);
      vPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      vPass.end();
      [workingSrc, workingDst] = [workingDst, workingSrc];
    }
    maskTex = workingSrc;
  }

  // Composite pass
  const compBuf = new ArrayBuffer(48);
  const cf = new Float32Array(compBuf);
  const ci = new Int32Array(compBuf);
  const cu = new Uint32Array(compBuf);
  cf[0] = args.colorR;
  cf[1] = args.colorG;
  cf[2] = args.colorB;
  cf[3] = args.colorA;
  cf[4] = args.opacity;
  ci[5] = args.offsetX;
  ci[6] = args.offsetY;
  cu[7] = BLEND_MODE_MAP[args.blendMode];
  cu[8] = args.knockout ? 1 : 0;

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

/** Hooks for sharing the texture cache lifetime across DropShadow + Glow. */
export const dropShadowCache = {
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

export const DropShadowEffect: IPipelineEffect<
  DropShadowEffectLayer,
  DropShadowOp
> = {
  id: "drop-shadow",
  label: "Drop Shadow…",
  menu: { root: "effects", submenu: "fx-shadow" },
  defaultParams: {
    color: { r: 0, g: 0, b: 0, a: 255 },
    opacity: 75,
    offsetX: 5,
    offsetY: 5,
    spread: 0,
    softness: 10,
    blendMode: "multiply",
    knockout: true,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "drop-shadow",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex }, entry) {
    const {
      color,
      opacity,
      offsetX,
      offsetY,
      spread,
      softness,
      blendMode,
      knockout,
    } = entry.params;
    encodeDropShadowPass(engine.runtime, encoder, srcTex, dstTex, {
      colorR: color.r / 255,
      colorG: color.g / 255,
      colorB: color.b / 255,
      colorA: color.a / 255,
      opacity: opacity / 100,
      offsetX,
      offsetY,
      spread,
      softness,
      blendMode,
      knockout,
      selMaskLayer: entry.selMaskLayer,
    });
  },

  onFrameEnd: dropShadowCache.onFrameEnd,
  onDestroy: dropShadowCache.onDestroy,

  Panel: DropShadowOptions,
};
