import type { DisplaceEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { DisplaceOptions } from "./DisplaceOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

type DisplaceOp = Extract<EffectRenderOp, { kind: "displace" }>;

const EDGE_MAP = { transparent: 0, clamp: 1, mirror: 2 } as const;

export const DisplaceEffect: IPipelineEffect<
  DisplaceEffectLayer,
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
    return {
      kind: "displace",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const p = entry.params;
    const buf = new ArrayBuffer(32);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f[0] = p.horizontalScale;
    f[1] = p.verticalScale;
    f[2] = p.noiseFrequency;
    f[3] = p.seed;
    u[4] = EDGE_MAP[p.edgeMode];
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("displace", "fs_displace", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: DisplaceOptions,
};
