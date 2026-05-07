import type { HalftoneAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { HalftoneOptions } from "@/ux/windows/effects/HalftoneOptions/HalftoneOptions";
import type { IPipelineEffect } from "./IPipelineEffect";

type HalftoneOp = Extract<AdjustmentRenderOp, { kind: "halftone" }>;

export const HalftoneEffect: IPipelineEffect<
  HalftoneAdjustmentLayer,
  HalftoneOp
> = {
  id: "halftone",
  label: "Halftone…",
  menu: { root: "effects", submenu: "fx-style" },
  defaultParams: {
    mode: "color",
    frequency: 10,
    offsetC: 0,
    offsetM: 0,
    offsetY: 0,
    offsetK: 0,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "halftone",
      layerId: layer.id,
      frequency: layer.params.frequency,
      offsetC: layer.params.offsetC,
      offsetM: layer.params.offsetM,
      offsetY: layer.params.offsetY,
      offsetK: layer.params.offsetK,
      mode: layer.params.mode,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const buf = new ArrayBuffer(32);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f[0] = entry.frequency;
    f[1] = entry.offsetC;
    f[2] = entry.offsetM;
    f[3] = entry.offsetY;
    f[4] = entry.offsetK;
    u[5] = entry.mode === "color" ? 0 : 1;
    engine.encodeStdAdjRenderPass(
      encoder,
      engine.halftonePipeline,
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: HalftoneOptions,
};
