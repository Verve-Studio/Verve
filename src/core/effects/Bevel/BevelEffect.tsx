import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { BevelOptions } from "./BevelOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import {
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";


export interface BevelParams {
    /** Dilation radius in pixels (1–50). Controls bevel width. */
    width: number;
    /** Blur radius in pixels (0–50). Controls softness of bevel edges. */
    softness: number;
    /** Light direction in degrees (0–360). 0° = right, 90° = down. */
    angle: number;
    /** Bevel intensity, 0–100 (%). */
    strength: number;
}

export type BevelEffectLayer = EffectLayerOf<"bevel", BevelParams>;

type BevelOp = Extract<EffectRenderOp, { kind: "bevel" }>;

let texCache: {
  tempA: GPUTexture;
  tempB: GPUTexture;
  format: GPUTextureFormat;
} | null = null;
let usedThisFrame = false;

/** Scratch ping-pong for the bevel's erode+blur height-map. Allocated in
 *  the doc format so the height map keeps full precision on f32 documents
 *  (no banding in wide soft bevels). */
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

export const BevelEffect: IPipelineEffect<BevelEffectLayer, BevelOp> = {
  id: "bevel",
  label: "Bevel…",
  menu: { root: "effects", submenu: "fx-shadow" },
  defaultParams: { width: 5, softness: 3, angle: 135, strength: 80 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "bevel",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex }, entry) {
    const { runtime } = engine;
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
      "bevel-composite",
      "cs_bevel_composite",
      dstTex,
    );

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

    // Pass 1+2: ErodeH/V radius=1 to channel-copy src.a → tempB.r
    const copyParamsBuf = runtime.makeParamsBuf(
      new Uint32Array([1, 0, 0, 0]),
    );
    dispatch(erodeH, srcTex, tempA, copyParamsBuf);
    dispatch(erodeV, tempA, tempB, copyParamsBuf);

    // Pass 3+4: Box blur radius = width
    const heightR = Math.max(1, Math.round(entry.params.width));
    const heightParamsBuf = runtime.makeParamsBuf(
      new Uint32Array([heightR, 0, 0, 0]),
    );
    dispatch(blurH, tempB, tempA, heightParamsBuf);
    dispatch(blurV, tempA, tempB, heightParamsBuf);

    // Pass 5+6: optional softness blur
    let heightTex: GPUTexture = tempB;
    if (entry.params.softness > 0) {
      const softR = Math.max(1, Math.round(entry.params.softness / 2));
      const softParamsBuf = runtime.makeParamsBuf(
        new Uint32Array([softR, 0, 0, 0]),
      );
      dispatch(blurH, tempB, tempA, softParamsBuf);
      dispatch(blurV, tempA, tempB, softParamsBuf);
      heightTex = tempB;
    }

    // Composite pass
    const compBuf = new ArrayBuffer(16);
    const cf = new Float32Array(compBuf);
    cf[0] = entry.params.strength / 100;
    cf[1] = entry.params.angle;
    cf[2] = 2 * heightR;

    const compParamsBuf = runtime.makeParamsBuf(compBuf);
    const maskFlagsBuf = runtime.makeMaskFlagsBuf(
      !!entry.selMaskLayer,
      dstTex.format === "rgba16float" || dstTex.format === "rgba32float",
    );
    const dummyMask = entry.selMaskLayer?.texture ?? srcTex;

    const compBG = device.createBindGroup({
      layout: composite.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: heightTex.createView() },
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
  },

  onFrameEnd() {
    if (!usedThisFrame && texCache) {
      destroyTrackedTexture(texCache.tempA);
      destroyTrackedTexture(texCache.tempB);
      texCache = null;
    }
    usedThisFrame = false;
  },

  onDestroy() {
    if (texCache) {
      destroyTrackedTexture(texCache.tempA);
      destroyTrackedTexture(texCache.tempB);
      texCache = null;
    }
  },

  Panel: BevelOptions,
};
