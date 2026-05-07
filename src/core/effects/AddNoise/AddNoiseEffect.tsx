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
    return {
      kind: "add-noise",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const pair = rt.getRenderPipelinePair("filter-add-noise", "fs_add_noise");
    const { amount, distribution, monochromatic, seed } = entry.params;
    const paramsBuf = rt.makeParamsBuf(
      new Uint32Array([
        amount,
        distribution === "gaussian" ? 1 : 0,
        monochromatic ? 1 : 0,
        seed,
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
