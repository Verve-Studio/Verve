import type { OutlineAdjustmentLayer, OutlineParams } from "@/types";
import type { AdjustmentRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { OutlineOptions } from "./OutlineOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import {
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";
import type { EffectRuntime } from "@/graphics/webgpu/EffectRuntime";

type OutlineOp = Extract<AdjustmentRenderOp, { kind: "outline" }>;

let texCache: {
  tempA: GPUTexture;
  tempB: GPUTexture;
  tempC: GPUTexture;
} | null = null;
let usedThisFrame = false;

function ensureTextures(
  device: GPUDevice,
  width: number,
  height: number,
): { tempA: GPUTexture; tempB: GPUTexture; tempC: GPUTexture } {
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
  texCache = { tempA: make(), tempB: make(), tempC: make() };
  return texCache;
}

const MODE_MAP = { outside: 0, inside: 1, center: 2 } as const;

/**
 * Get the outline pipelines (also used by Bevel / InnerShadow which reuse
 * the erode pipelines as channel-copy steps).
 */
export function getOutlinePipelines(runtime: EffectRuntime) {
  return {
    dilateH: runtime.getComputePipeline(
      "outline-dilate-h",
      "cs_outline_dilate_h",
    ),
    dilateV: runtime.getComputePipeline(
      "outline-dilate-v",
      "cs_outline_dilate_v",
    ),
    erodeH: runtime.getComputePipeline("outline-erode-h", "cs_outline_erode_h"),
    erodeV: runtime.getComputePipeline("outline-erode-v", "cs_outline_erode_v"),
    mask: runtime.getComputePipeline("outline-mask", "cs_outline_mask"),
    blurH: runtime.getComputePipeline("outline-blur-h", "cs_outline_blur_h"),
    blurV: runtime.getComputePipeline("outline-blur-v", "cs_outline_blur_v"),
    composite: runtime.getComputePipeline(
      "outline-composite",
      "cs_outline_composite",
    ),
  };
}

export const OutlineEffect: IPipelineEffect<
  OutlineAdjustmentLayer,
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
    const { color, opacity, thickness, position, softness } =
      layer.params as OutlineParams;
    return {
      kind: "outline",
      layerId: layer.id,
      colorR: color.r / 255,
      colorG: color.g / 255,
      colorB: color.b / 255,
      colorA: color.a / 255,
      opacity: opacity / 100,
      thickness: Math.round(thickness),
      position,
      softness,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex }, entry) {
    const { runtime } = engine;
    const { device, pixelWidth: w, pixelHeight: h } = runtime;
    const { tempA, tempB, tempC } = ensureTextures(device, w, h);
    const pipes = getOutlinePipelines(runtime);

    const T = Math.max(1, Math.round(entry.thickness));
    const dilateR = entry.position === "center" ? Math.ceil(T / 2) : T;
    const erodeR = entry.position === "center" ? Math.floor(T / 2) : T;
    const blurR =
      entry.softness > 0 ? Math.max(1, Math.round(entry.softness * 0.577)) : 0;

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

    if (entry.position === "outside") {
      morphPass(pipes.dilateH, srcTex, tempA, dilateParamsBuf);
      morphPass(pipes.dilateV, tempA, tempB, dilateParamsBuf);
    } else if (entry.position === "inside") {
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
      new Uint32Array([MODE_MAP[entry.position], 0, 0, 0]),
    );
    const morphATex =
      entry.position === "center"
        ? tempC
        : entry.position === "outside"
          ? tempB
          : srcTex;
    const morphBTex =
      entry.position === "center"
        ? tempB
        : entry.position === "inside"
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
    if (entry.softness > 0) {
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
    cf[0] = entry.colorR;
    cf[1] = entry.colorG;
    cf[2] = entry.colorB;
    cf[3] = entry.colorA;
    cf[4] = entry.opacity;
    const compParamsBuf = runtime.makeParamsBuf(compBuf);
    const maskFlagsBuf = runtime.makeMaskFlagsBuf(!!entry.selMaskLayer);
    const dummyMask = entry.selMaskLayer?.texture ?? srcTex;

    const compBG = device.createBindGroup({
      layout: pipes.composite.getBindGroupLayout(0),
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
    compPass.setPipeline(pipes.composite);
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
};
