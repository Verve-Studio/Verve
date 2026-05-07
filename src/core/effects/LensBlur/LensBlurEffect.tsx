import type { LensBlurAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { LensBlurPanel } from "./LensBlurPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type LensBlurOp = Extract<AdjustmentRenderOp, { kind: "lens-blur" }>;

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

// Module-level kernel cache (persists across frames).
let cachedKernelKey: string | null = null;
let cachedKernelBuf: GPUBuffer | null = null;
let cachedKernelCount = 0;

export const LensBlurEffect: IPipelineEffect<
  LensBlurAdjustmentLayer,
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
    const { radius, bladeCount, bladeCurvature, rotation } = layer.params;
    return {
      kind: "lens-blur",
      layerId: layer.id,
      radius,
      bladeCount,
      bladeCurvature,
      rotation,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const pair = rt.getRenderPipelinePair("filter-lens-blur", "fs_lens_blur");
    const key = `${entry.radius}|${entry.bladeCount}|${entry.bladeCurvature}|${entry.rotation}`;
    if (cachedKernelKey !== key) {
      if (cachedKernelBuf) {
        rt.pendingDestroyBuffers.push(cachedKernelBuf);
      }
      const entries = buildKernelEntries(
        entry.radius,
        entry.bladeCount,
        entry.bladeCurvature,
        entry.rotation,
      );
      const buf = rt.device.createBuffer({
        size: Math.max(entries.byteLength, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      rt.device.queue.writeBuffer(
        buf,
        0,
        entries.buffer as ArrayBuffer,
        0,
        entries.byteLength,
      );
      cachedKernelBuf = buf;
      cachedKernelKey = key;
      cachedKernelCount = entries.length / 4;
    }
    const paramsBuf = rt.makeParamsBuf(
      new Uint32Array([cachedKernelCount, 0, 0, 0]),
    );
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(pair, dstTex),
      dstTex,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
        { binding: 3, resource: { buffer: cachedKernelBuf! } },
      ],
    );
  },

  onDestroy() {
    if (cachedKernelBuf) {
      cachedKernelBuf.destroy();
      cachedKernelBuf = null;
      cachedKernelKey = null;
      cachedKernelCount = 0;
    }
  },

  Panel: LensBlurPanel,
};
