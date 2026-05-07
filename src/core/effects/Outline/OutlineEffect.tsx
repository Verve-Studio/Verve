import type { OutlineAdjustmentLayer, OutlineParams } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { OutlineOptions } from "./OutlineOptions";
import type { IPipelineEffect } from "../IPipelineEffect";

type OutlineOp = Extract<AdjustmentRenderOp, { kind: "outline" }>;

export const OutlineEffect: IPipelineEffect<
  OutlineAdjustmentLayer,
  OutlineOp
> = {
  id: "outline",
  label: "Outline…",
  menu: { root: "effects", submenu: "fx-shadow" },
  defaultParams: {
    color: { r: 255, g: 0, b: 0, a: 255 },
    opacity: 100,
    thickness: 3,
    position: "outside",
    softness: 0,
  },

  buildPlanEntry(layer, { mask }) {
    const { color, opacity, thickness, position, softness } =
      layer.params as OutlineParams;
    return {
      kind: "outline",
      layerId: layer.id,
      colorR: color.r / 255,
      colorG: color.g / 255,
      colorB: color.b / 255,
      colorA: color.a / 255,
      opacity: opacity / 100,
      thickness: Math.round(thickness),
      position,
      softness,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex }, entry) {
    engine.encodeOutlinePass(
      encoder,
      srcTex,
      dstTex,
      entry.colorR,
      entry.colorG,
      entry.colorB,
      entry.colorA,
      entry.opacity,
      entry.thickness,
      entry.position,
      entry.softness,
      entry.selMaskLayer,
    );
  },

  Panel: OutlineOptions,
};
