import type { BevelAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { BevelOptions } from "@/ux/windows/effects/BevelOptions/BevelOptions";
import type { IPipelineEffect } from "./IPipelineEffect";

type BevelOp = Extract<AdjustmentRenderOp, { kind: "bevel" }>;

export const BevelEffect: IPipelineEffect<BevelAdjustmentLayer, BevelOp> = {
  id: "bevel",
  label: "Bevel…",
  menu: { root: "effects", submenu: "fx-shadow" },
  defaultParams: { width: 5, softness: 3, angle: 135, strength: 80 },

  buildPlanEntry(layer, { mask }) {
    const { width, softness, angle, strength } = layer.params;
    return {
      kind: "bevel",
      layerId: layer.id,
      width,
      softness,
      angle,
      strength,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex }, entry) {
    engine.encodeBevelPass(
      encoder,
      srcTex,
      dstTex,
      entry.width,
      entry.softness,
      entry.angle,
      entry.strength,
      entry.selMaskLayer,
    );
  },

  Panel: BevelOptions,
};
