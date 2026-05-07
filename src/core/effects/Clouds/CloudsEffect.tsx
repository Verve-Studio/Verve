import type { CloudsEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { CloudsPanel } from "./CloudsPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type CloudsOp = Extract<EffectRenderOp, { kind: "clouds" }>;

export const CloudsEffect: IPipelineEffect<CloudsEffectLayer, CloudsOp> = {
  id: "clouds",
  label: "Clouds…",
  menu: { root: "filters", submenu: "render" },
  defaultParams: {
    scale: 100,
    opacity: 100,
    colorMode: "grayscale",
    fgR: 0,
    fgG: 0,
    fgB: 0,
    bgR: 255,
    bgG: 255,
    bgB: 255,
    seed: 0,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "clouds",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const w = dstTex.width;
    const h = dstTex.height;
    const { scale, opacity, colorMode, fgR, fgG, fgB, bgR, bgG, bgB, seed } =
      entry.params;
    const fgColor = (fgR | (fgG << 8) | (fgB << 16)) >>> 0;
    const bgColor = (bgR | (bgG << 8) | (bgB << 16)) >>> 0;
    const pair = rt.getRenderPipelinePair("filter-clouds", "fs_clouds");
    const paramsData = new Uint32Array([
      scale,
      opacity,
      colorMode === "color" ? 1 : 0,
      fgColor,
      bgColor,
      w,
      h,
      0,
    ]);
    const paramsBuf = rt.makeParamsBuf(paramsData);
    const perm = new Uint32Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    let s = (seed ^ 0xdeadbeef) >>> 0;
    for (let i = 255; i > 0; i--) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const idx = s % (i + 1);
      const tmp = perm[i];
      perm[i] = perm[idx];
      perm[idx] = tmp;
    }
    const permBuf = rt.device.createBuffer({
      size: Math.max(perm.byteLength, 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    rt.device.queue.writeBuffer(permBuf, 0, perm);
    rt.pendingDestroyBuffers.push(permBuf);
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(pair, dstTex),
      dstTex,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
        { binding: 3, resource: { buffer: permBuf } },
      ],
    );
  },

  Panel: CloudsPanel,
};
