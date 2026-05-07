import type { BlackAndWhiteEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { BlackAndWhitePanel } from "./BlackAndWhitePanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

type BlackAndWhiteOp = Extract<EffectRenderOp, { kind: "black-and-white" }>;

export const BlackAndWhiteEffect: IPipelineEffect<
  BlackAndWhiteEffectLayer,
  BlackAndWhiteOp
> = {
  id: "black-and-white",
  label: "Black and White…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: {
    reds: 40,
    yellows: 60,
    greens: 40,
    cyans: 60,
    blues: 20,
    magentas: 80,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "black-and-white",
      layerId: layer.id,
      params: layer.params,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const p = entry.params;
    const params = new Float32Array([
      p.reds,
      p.yellows,
      p.greens,
      p.cyans,
      p.blues,
      p.magentas,
      0,
      0,
    ]);
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("bw", "fs_black_and_white", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      params.buffer as ArrayBuffer,
      entry.selMaskLayer,
    );
  },

  Panel: BlackAndWhitePanel,
};
