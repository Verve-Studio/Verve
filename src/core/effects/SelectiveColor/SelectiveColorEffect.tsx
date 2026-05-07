import type { SelectiveColorAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { SelectiveColorPanel } from "./SelectiveColorPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type SelectiveColorOp = Extract<AdjustmentRenderOp, { kind: "selective-color" }>;

const ZERO_CHANNEL = { cyan: 0, magenta: 0, yellow: 0, black: 0 };

export const SelectiveColorEffect: IPipelineEffect<
  SelectiveColorAdjustmentLayer,
  SelectiveColorOp
> = {
  id: "selective-color",
  label: "Selective Color…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: {
    reds: { ...ZERO_CHANNEL },
    yellows: { ...ZERO_CHANNEL },
    greens: { ...ZERO_CHANNEL },
    cyans: { ...ZERO_CHANNEL },
    blues: { ...ZERO_CHANNEL },
    magentas: { ...ZERO_CHANNEL },
    whites: { ...ZERO_CHANNEL },
    neutrals: { ...ZERO_CHANNEL },
    blacks: { ...ZERO_CHANNEL },
    mode: "relative",
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "selective-color",
      layerId: layer.id,
      params: layer.params,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    engine.encodeSelectiveColorRenderPass(
      encoder,
      srcTex,
      dstTex,
      format,
      entry.params,
      entry.selMaskLayer,
    );
  },

  Panel: SelectiveColorPanel,
};
