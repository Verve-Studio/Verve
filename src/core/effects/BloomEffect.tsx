import type { BloomAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { BloomOptions } from "@/ux/windows/effects/BloomOptions/BloomOptions";
import type { IPipelineEffect } from "./IPipelineEffect";

type BloomOp = Extract<AdjustmentRenderOp, { kind: "bloom" }>;

export const BloomEffect: IPipelineEffect<BloomAdjustmentLayer, BloomOp> = {
  id: "bloom",
  label: "Bloom…",
  menu: { root: "effects", submenu: "fx-glow" },
  defaultParams: {
    threshold: 0.5,
    strength: 0.5,
    spread: 20,
    quality: "half",
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "bloom",
      layerId: layer.id,
      threshold: layer.params.threshold,
      strength: layer.params.strength,
      spread: layer.params.spread,
      quality: layer.params.quality,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    engine.encodeBloomRenderPass(
      encoder,
      srcTex,
      dstTex,
      format,
      entry.threshold,
      entry.strength,
      entry.spread,
      entry.quality,
      entry.selMaskLayer,
    );
  },

  Panel: BloomOptions,
};
