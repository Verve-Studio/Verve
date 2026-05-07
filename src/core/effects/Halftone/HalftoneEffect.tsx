import type { HalftoneEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { HalftoneOptions } from "./HalftoneOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

type HalftoneOp = Extract<EffectRenderOp, { kind: "halftone" }>;

export const HalftoneEffect: IPipelineEffect<
  HalftoneEffectLayer,
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
    f[0] = p.frequency;
    f[1] = p.offsetC;
    f[2] = p.offsetM;
    f[3] = p.offsetY;
    f[4] = p.offsetK;
    u[5] = p.mode === "color" ? 0 : 1;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("halftone", "fs_halftone", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: HalftoneOptions,
};
