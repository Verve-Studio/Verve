import type { AddNoiseEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { AddNoisePanel } from "./AddNoisePanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type AddNoiseOp = Extract<EffectRenderOp, { kind: "add-noise" }>;

export const AddNoiseEffect: IPipelineEffect<
  AddNoiseEffectLayer,
  AddNoiseOp
> = {
  id: "add-noise",
  label: "Add Noise…",
  menu: { root: "filters", submenu: "noise" },
  defaultParams: {
    amount: 25,
    distribution: "uniform",
    monochromatic: false,
    seed: 0,
  },

  buildPlanEntry(layer, { mask }) {
    const { amount, distribution, monochromatic, seed } = layer.params;
    return {
      kind: "add-noise",
      layerId: layer.id,
      amount,
      distribution: distribution === "gaussian" ? 1 : 0,
      monochromatic: monochromatic ? 1 : 0,
      seed,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const pair = rt.getRenderPipelinePair("filter-add-noise", "fs_add_noise");
    const paramsBuf = rt.makeParamsBuf(
      new Uint32Array([
        entry.amount,
        entry.distribution,
        entry.monochromatic,
        entry.seed,
      ]),
    );
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(pair, dstTex),
      dstTex,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
      ],
    );
  },

  Panel: AddNoisePanel,
};
