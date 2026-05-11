import type { EffectLayerOf, RGBAColor } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { OutlineOptions } from "./OutlineOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import {
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";
import type { EffectRuntime } from "@/graphics/webgpu/EffectRuntime";

const OutlineIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    <rect x="3" y="3" width="6" height="6" />
    <rect x="1" y="1" width="10" height="10" />
  </svg>
);


export interface OutlineParams {
    /** Stroke color including alpha. r/g/b/a are 0–255. Default: { r:255, g:0, b:0, a:255 } */
    color: RGBAColor;
    /** Overall stroke opacity, 0–100 (%). Applied on top of color.a. Default: 100 */
    opacity: number;
    /** Stroke width in pixels, 1–100. Integer values only. Default: 3 */
    thickness: number;
    /** Controls which side of the silhouette boundary the stroke occupies. Default: 'outside' */
    position: "outside" | "inside" | "center";
    /** Gaussian-approximation blur radius for the stroke mask, 0–50 px. Default: 0 */
    softness: number;
}

export type OutlineEffectLayer = EffectLayerOf<"outline", OutlineParams>;

type OutlineOp = Extract<EffectRenderOp, { kind: "outline" }>;

let texCache: {
  tempA: GPUTexture;
  tempB: GPUTexture;
  tempC: GPUTexture;
  format: GPUTextureFormat;
} | null = null;
let usedThisFrame = false;

/** Scratch textures (3-way ping-pong for center-position outlines).
 *  Allocated in the doc format — the whole effect runs at full doc precision
 *  on f32 documents. */
function ensureTextures(
  device: GPUDevice,
  width: number,
  height: number,
  format: GPUTextureFormat,
): { tempA: GPUTexture; tempB: GPUTexture; tempC: GPUTexture } {
  usedThisFrame = true;
  if (texCache && texCache.format === format) return texCache;
  if (texCache) {
    destroyTrackedTexture(texCache.tempA);
    destroyTrackedTexture(texCache.tempB);
    destroyTrackedTexture(texCache.tempC);
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
  texCache = { tempA: make(), tempB: make(), tempC: make(), format };
  return texCache;
}

const MODE_MAP = { outside: 0, inside: 1, center: 2 } as const;

/**
 * Get the outline pipelines (also used by Bevel / InnerShadow which reuse
 * the erode pipelines as channel-copy steps). Specialised for the target
 * storage format so the shaders' `texture_storage_2d<rgba8unorm, …>`
 * declarations get rewritten to match the doc format. The composite is
 * fetched separately because the caller needs the same pipeline reference
 * for its bind group.
 */
export function getOutlinePipelines(
  runtime: EffectRuntime,
  dstTex: GPUTexture,
) {
  return {
    dilateH: runtime.getComputePipelineForStorageFormat(
      "outline-dilate-h",
      "cs_outline_dilate_h",
      dstTex,
    ),
    dilateV: runtime.getComputePipelineForStorageFormat(
      "outline-dilate-v",
      "cs_outline_dilate_v",
      dstTex,
    ),
    erodeH: runtime.getComputePipelineForStorageFormat(
      "outline-erode-h",
      "cs_outline_erode_h",
      dstTex,
    ),
    erodeV: runtime.getComputePipelineForStorageFormat(
      "outline-erode-v",
      "cs_outline_erode_v",
      dstTex,
    ),
    mask: runtime.getComputePipelineForStorageFormat(
      "outline-mask",
      "cs_outline_mask",
      dstTex,
    ),
    blurH: runtime.getComputePipelineForStorageFormat(
      "outline-blur-h",
      "cs_outline_blur_h",
      dstTex,
    ),
    blurV: runtime.getComputePipelineForStorageFormat(
      "outline-blur-v",
      "cs_outline_blur_v",
      dstTex,
    ),
  };
}

export const OutlineEffect: IPipelineEffect<
  OutlineEffectLayer,
  OutlineOp
> = {
  id: "outline",
  label: "Outline…",
  menu: { root: "effects", submenu: "fx-shadow" },
  defaultParams: {
    color: { r: 255, g: 0, b: 0, a: 255 },
    opacity: 100,
    thickness: 3,
    position: "outside",
    softness: 0,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "outline",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params as OutlineParams,
    };
  },

  encode({ engine, encoder, srcTex, dstTex }, entry) {
    const { runtime } = engine;
    const { device, pixelWidth: w, pixelHeight: h } = runtime;
    const { tempA, tempB, tempC } = ensureTextures(device, w, h, dstTex.format);
    const pipes = getOutlinePipelines(runtime, dstTex);
    const compositePipeline = runtime.getComputePipelineForStorageFormat(
      "outline-composite",
      "cs_outline_composite",
      dstTex,
    );

    const { color, opacity, thickness, position, softness } = entry.params;
    const colorR = color.r / 255;
    const colorG = color.g / 255;
    const colorB = color.b / 255;
    const colorA = color.a / 255;
    const opacityN = opacity / 100;
    const T = Math.max(1, Math.round(thickness));
    const dilateR = position === "center" ? Math.ceil(T / 2) : T;
    const erodeR = position === "center" ? Math.floor(T / 2) : T;
    const blurR =
      softness > 0 ? Math.max(1, Math.round(softness * 0.577)) : 0;

    const morphPass = (
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

    const dilateParamsBuf = runtime.makeParamsBuf(
      new Uint32Array([dilateR, 0, 0, 0]),
    );

    if (position === "outside") {
      morphPass(pipes.dilateH, srcTex, tempA, dilateParamsBuf);
      morphPass(pipes.dilateV, tempA, tempB, dilateParamsBuf);
    } else if (position === "inside") {
      morphPass(pipes.erodeH, srcTex, tempA, dilateParamsBuf);
      morphPass(pipes.erodeV, tempA, tempB, dilateParamsBuf);
    } else {
      const erodeParamsBuf = runtime.makeParamsBuf(
        new Uint32Array([erodeR, 0, 0, 0]),
      );
      morphPass(pipes.dilateH, srcTex, tempA, dilateParamsBuf);
      morphPass(pipes.dilateV, tempA, tempC, dilateParamsBuf);
      morphPass(pipes.erodeH, srcTex, tempA, erodeParamsBuf);
      morphPass(pipes.erodeV, tempA, tempB, erodeParamsBuf);
    }

    const maskParamsBuf = runtime.makeParamsBuf(
      new Uint32Array([MODE_MAP[position], 0, 0, 0]),
    );
    const morphATex =
      position === "center"
        ? tempC
        : position === "outside"
          ? tempB
          : srcTex;
    const morphBTex =
      position === "center"
        ? tempB
        : position === "inside"
          ? tempB
          : srcTex;

    const maskBG = device.createBindGroup({
      layout: pipes.mask.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: morphATex.createView() },
        { binding: 2, resource: morphBTex.createView() },
        { binding: 3, resource: tempA.createView() },
        { binding: 4, resource: { buffer: maskParamsBuf } },
      ],
    });
    const maskPass = encoder.beginComputePass();
    maskPass.setPipeline(pipes.mask);
    maskPass.setBindGroup(0, maskBG);
    maskPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    maskPass.end();

    let strokeMaskTex: GPUTexture = tempA;
    if (softness > 0) {
      const blurParamsBuf = runtime.makeParamsBuf(
        new Uint32Array([blurR, 0, 0, 0]),
      );
      let workingSrc = tempA;
      let workingDst = tempB;
      for (let i = 0; i < 3; i++) {
        morphPass(pipes.blurH, workingSrc, workingDst, blurParamsBuf);
        [workingSrc, workingDst] = [workingDst, workingSrc];
        morphPass(pipes.blurV, workingSrc, workingDst, blurParamsBuf);
        [workingSrc, workingDst] = [workingDst, workingSrc];
      }
      strokeMaskTex = workingSrc;
    }

    // Composite
    const compBuf = new ArrayBuffer(32);
    const cf = new Float32Array(compBuf);
    cf[0] = colorR;
    cf[1] = colorG;
    cf[2] = colorB;
    cf[3] = colorA;
    cf[4] = opacityN;
    const compParamsBuf = runtime.makeParamsBuf(compBuf);
    const maskFlagsBuf = runtime.makeMaskFlagsBuf(!!entry.selMaskLayer);
    const dummyMask = entry.selMaskLayer?.texture ?? srcTex;

    const compBG = device.createBindGroup({
      layout: compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: strokeMaskTex.createView() },
        { binding: 2, resource: dstTex.createView() },
        { binding: 3, resource: { buffer: compParamsBuf } },
        { binding: 4, resource: dummyMask.createView() },
        { binding: 5, resource: { buffer: maskFlagsBuf } },
      ],
    });
    const compPass = encoder.beginComputePass();
    compPass.setPipeline(compositePipeline);
    compPass.setBindGroup(0, compBG);
    compPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    compPass.end();
  },

  onFrameEnd() {
    if (!usedThisFrame && texCache) {
      destroyTrackedTexture(texCache.tempA);
      destroyTrackedTexture(texCache.tempB);
      destroyTrackedTexture(texCache.tempC);
      texCache = null;
    }
    usedThisFrame = false;
  },

  onDestroy() {
    if (texCache) {
      destroyTrackedTexture(texCache.tempA);
      destroyTrackedTexture(texCache.tempB);
      destroyTrackedTexture(texCache.tempC);
      texCache = null;
    }
  },

  Panel: OutlineOptions,
  icon: OutlineIcon,
};
