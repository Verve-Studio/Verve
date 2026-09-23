import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { LensBlurPanel } from "./LensBlurPanel";
import type { IPipelineEffect } from "../IPipelineEffect";


export interface LensBlurParams {
    radius: number;
    bladeCount: number;
    bladeCurvature: number;
    rotation: number;
}

export type LensBlurEffectLayer = EffectLayerOf<"lens-blur", LensBlurParams>;

type LensBlurOp = Extract<EffectRenderOp, { kind: "lens-blur" }>;

function buildKernelEntries(
  radius: number,
  bladeCount: number,
  bladeCurvature: number,
  rotation: number,
): Float32Array {
  const PI = Math.PI;
  const bladeCurvF = bladeCurvature / 100.0;
  const rotRad = (rotation * PI) / 180.0;
  const bladeAngle = bladeCurvature < 100 ? (2.0 * PI) / bladeCount : 0.0;
  const halfBlade = bladeAngle / 2.0;
  const polyInradius = bladeCurvature < 100 ? Math.cos(PI / bladeCount) : 1.0;

  const entries: Array<[number, number, number]> = [];
  for (let ky = -radius; ky <= radius; ky++) {
    for (let kx = -radius; kx <= radius; kx++) {
      const nx = radius > 0 ? kx / radius : 0.0;
      const ny = radius > 0 ? ky / radius : 0.0;
      const r = Math.sqrt(nx * nx + ny * ny);
      if (r > 1.5) continue;

      let w: number;
      if (bladeCurvature >= 100) {
        w = r <= 1.0 ? 1.0 : 0.0;
      } else {
        const theta = Math.atan2(ny, nx) + rotRad;
        const sector =
          (((theta + 20.0 * PI) % bladeAngle) + bladeAngle) % bladeAngle;
        const polyR = polyInradius / Math.cos(sector - halfBlade);
        const effectiveR = polyR * (1.0 - bladeCurvF) + 1.0 * bladeCurvF;
        w = r <= effectiveR ? 1.0 : 0.0;
      }
      if (w > 0) entries.push([kx, ky, w]);
    }
  }

  const sum = entries.reduce((acc, e) => acc + e[2], 0);
  const inv = sum > 0 ? 1.0 / sum : 1.0;

  const result = new Float32Array(entries.length * 4);
  for (let i = 0; i < entries.length; i++) {
    result[i * 4 + 0] = entries[i][0];
    result[i * 4 + 1] = entries[i][1];
    result[i * 4 + 2] = entries[i][2] * inv;
    result[i * 4 + 3] = 0;
  }
  return result;
}

/** Radius (in pixels at the resolution the kernel runs at) above which the
 *  blur runs on a downsampled copy. π·24² ≈ 1.8k taps per pixel. */
const MAX_KERNEL_RADIUS = 24;

/** Kernel buffers per parameter set, so two Lens Blur layers with different
 *  settings don't rebuild the O(r²) kernel on every frame. */
const kernelCache = new Map<string, { buf: GPUBuffer; count: number }>();
const MAX_CACHED_KERNELS = 8;

function getKernel(
  device: GPUDevice,
  pendingDestroyBuffers: GPUBuffer[],
  radius: number,
  bladeCount: number,
  bladeCurvature: number,
  rotation: number,
): { buf: GPUBuffer; count: number } {
  const key = `${radius}|${bladeCount}|${bladeCurvature}|${rotation}`;
  const hit = kernelCache.get(key);
  if (hit) {
    kernelCache.delete(key);
    kernelCache.set(key, hit);
    return hit;
  }
  const entries = buildKernelEntries(radius, bladeCount, bladeCurvature, rotation);
  const buf = device.createBuffer({
    size: Math.max(entries.byteLength, 16),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, entries.buffer as ArrayBuffer, 0, entries.byteLength);
  const kernel = { buf, count: entries.length / 4 };
  kernelCache.set(key, kernel);
  if (kernelCache.size > MAX_CACHED_KERNELS) {
    const [oldestKey, oldest] = kernelCache.entries().next().value as [
      string,
      { buf: GPUBuffer; count: number },
    ];
    kernelCache.delete(oldestKey);
    // May still be referenced by this frame's encoder — destroy after submit.
    pendingDestroyBuffers.push(oldest.buf);
  }
  return kernel;
}

export const LensBlurEffect: IPipelineEffect<
  LensBlurEffectLayer,
  LensBlurOp
> = {
  id: "lens-blur",
  label: "Lens Blur…",
  menu: { root: "filters", submenu: "blur" },
  defaultParams: {
    radius: 10,
    bladeCount: 6,
    bladeCurvature: 0,
    rotation: 0,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "lens-blur",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const { radius, bladeCount, bladeCurvature, rotation } = entry.params;
    const blur = rt.getRenderPipelinePair("filter-lens-blur", "fs_lens_blur");
    const factor =
      radius > MAX_KERNEL_RADIUS ? Math.ceil(radius / MAX_KERNEL_RADIUS) : 1;
    const kernelRadius =
      factor === 1 ? radius : Math.max(1, Math.round(radius / factor));
    const kernel = getKernel(
      rt.device,
      rt.pendingDestroyBuffers,
      kernelRadius,
      bladeCount,
      bladeCurvature,
      rotation,
    );
    const paramsBuf = rt.makeParamsBuf(
      new Uint32Array([kernel.count, factor, 0, 0]),
    );

    if (factor === 1) {
      rt.encodeRenderPass(encoder, rt.selectPipeline(blur, dstTex), dstTex, [
        { binding: 0, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
        { binding: 3, resource: { buffer: kernel.buf } },
      ]);
      return;
    }

    // Large radius: downsample → blur with a proportionally smaller kernel →
    // bilinear upsample. Intermediates stay in the doc format.
    const down = rt.getRenderPipelinePair("filter-lens-blur", "fs_lens_down");
    const up = rt.getRenderPipelinePair("filter-lens-blur", "fs_lens_up");
    const sw = Math.ceil(srcTex.width / factor);
    const sh = Math.ceil(srcTex.height / factor);
    const small = rt.makeScratchTex(sw, sh, dstTex);
    const smallBlurred = rt.makeScratchTex(sw, sh, dstTex);
    rt.encodeRenderPass(encoder, rt.selectPipeline(down, small), small, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
    ]);
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(blur, smallBlurred),
      smallBlurred,
      [
        { binding: 0, resource: small.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
        { binding: 3, resource: { buffer: kernel.buf } },
      ],
    );
    rt.encodeRenderPass(encoder, rt.selectPipeline(up, dstTex), dstTex, [
      { binding: 0, resource: smallBlurred.createView() },
      { binding: 2, resource: { buffer: paramsBuf } },
    ]);
  },

  onDestroy() {
    for (const kernel of kernelCache.values()) kernel.buf.destroy();
    kernelCache.clear();
  },

  Panel: LensBlurPanel,
};
