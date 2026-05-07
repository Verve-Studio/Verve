import type { ChromaticAberrationAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { ChromaticAberrationOptions } from "./ChromaticAberrationOptions";
import type { IPipelineEffect } from "../IPipelineEffect";

type ChromaticAberrationOp = Extract<
  AdjustmentRenderOp,
  { kind: "chromatic-aberration" }
>;

export const ChromaticAberrationEffect: IPipelineEffect<
  ChromaticAberrationAdjustmentLayer,
  ChromaticAberrationOp
> = {
  id: "chromatic-aberration",
  label: "Chromatic Aberration…",
  menu: { root: "effects", submenu: "fx-glow" },
  defaultParams: { type: "radial", distance: 5, angle: 0 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "chromatic-aberration",
      layerId: layer.id,
      caType: layer.params.type,
      distance: layer.params.distance,
      angle: layer.params.angle,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const buf = new ArrayBuffer(16);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    u[0] = entry.caType === "radial" ? 0 : 1;
    f[1] = entry.distance;
    f[2] = entry.angle;
    engine.encodeStdAdjRenderPass(
      encoder,
      engine.caPipeline,
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: ChromaticAberrationOptions,
};
