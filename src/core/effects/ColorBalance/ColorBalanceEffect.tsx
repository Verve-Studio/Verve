import type { ColorBalanceAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { ColorBalancePanel } from "./ColorBalancePanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphicspipeline/webgpu/EffectRuntime";

type ColorBalanceOp = Extract<AdjustmentRenderOp, { kind: "color-balance" }>;

export const ColorBalanceEffect: IPipelineEffect<
  ColorBalanceAdjustmentLayer,
  ColorBalanceOp
> = {
  id: "color-balance",
  label: "Color Balance…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: {
    shadows: { cr: 0, mg: 0, yb: 0 },
    midtones: { cr: 0, mg: 0, yb: 0 },
    highlights: { cr: 0, mg: 0, yb: 0 },
    preserveLuminosity: true,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "color-balance",
      layerId: layer.id,
      params: layer.params,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const p = entry.params;
    const buf = new ArrayBuffer(48);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f[0] = p.shadows.cr;
    f[1] = p.shadows.mg;
    f[2] = p.shadows.yb;
    f[3] = p.midtones.cr;
    f[4] = p.midtones.mg;
    f[5] = p.midtones.yb;
    f[6] = p.highlights.cr;
    f[7] = p.highlights.mg;
    f[8] = p.highlights.yb;
    u[9] = p.preserveLuminosity ? 1 : 0;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("cb", "fs_color_balance", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: ColorBalancePanel,
};
