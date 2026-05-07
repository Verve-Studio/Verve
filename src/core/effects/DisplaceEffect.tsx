import type { DisplaceAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { DisplaceOptions } from "@/ux/windows/effects/DisplaceOptions/DisplaceOptions";
import type { IPipelineEffect } from "./IPipelineEffect";

type DisplaceOp = Extract<AdjustmentRenderOp, { kind: "displace" }>;

const EDGE_MAP = { transparent: 0, clamp: 1, mirror: 2 } as const;

export const DisplaceEffect: IPipelineEffect<
  DisplaceAdjustmentLayer,
  DisplaceOp
> = {
  id: "displace",
  label: "Displace…",
  menu: { root: "effects", submenu: "fx-distortion" },
  defaultParams: {
    horizontalScale: 30,
    verticalScale: 30,
    noiseFrequency: 8,
    seed: 0,
    edgeMode: "mirror",
  },

  buildPlanEntry(layer, { mask }) {
    const p = layer.params;
    return {
      kind: "displace",
      layerId: layer.id,
      horizontalScale: p.horizontalScale,
      verticalScale: p.verticalScale,
      noiseFrequency: p.noiseFrequency,
      seed: p.seed,
      edgeMode: EDGE_MAP[p.edgeMode],
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const buf = new ArrayBuffer(32);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f[0] = entry.horizontalScale;
    f[1] = entry.verticalScale;
    f[2] = entry.noiseFrequency;
    f[3] = entry.seed;
    u[4] = entry.edgeMode;
    engine.encodeStdAdjRenderPass(
      encoder,
      engine.displacePipeline,
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: DisplaceOptions,
};
