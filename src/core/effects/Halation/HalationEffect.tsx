import type { HalationAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { HalationOptions } from "./HalationOptions";
import type { IPipelineEffect } from "../IPipelineEffect";

type HalationOp = Extract<AdjustmentRenderOp, { kind: "halation" }>;

export const HalationEffect: IPipelineEffect<
  HalationAdjustmentLayer,
  HalationOp
> = {
  id: "halation",
  label: "Halation…",
  menu: { root: "effects", submenu: "fx-glow" },
  defaultParams: { threshold: 0.5, spread: 30, blur: 2, strength: 0.6 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "halation",
      layerId: layer.id,
      threshold: layer.params.threshold,
      spread: layer.params.spread,
      blur: layer.params.blur,
      strength: layer.params.strength,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    engine.encodeHalationRenderPass(
      encoder,
      srcTex,
      dstTex,
      format,
      entry.threshold,
      entry.spread,
      entry.blur,
      entry.strength,
      entry.selMaskLayer,
    );
  },

  Panel: HalationOptions,
};
