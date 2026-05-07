import type { CurvesAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import {
  buildCurvesLuts,
  createDefaultCurvesParams,
} from "@/core/operations/adjustments/curves";
import { CurvesPanel } from "./CurvesPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type CurvesOp = Extract<AdjustmentRenderOp, { kind: "curves" }>;

export const CurvesEffect: IPipelineEffect<CurvesAdjustmentLayer, CurvesOp> = {
  id: "curves",
  label: "Curves…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: createDefaultCurvesParams(),

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "curves",
      layerId: layer.id,
      params: layer.params,
      luts: buildCurvesLuts(layer.params),
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    engine.encodeCurvesRenderPass(
      encoder,
      srcTex,
      dstTex,
      format,
      entry.layerId,
      entry.luts,
      entry.selMaskLayer,
    );
  },

  Panel: CurvesPanel,
};
