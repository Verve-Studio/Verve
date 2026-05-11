import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { PlasticWrapPanel } from "./PlasticWrapPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

export interface PlasticWrapParams {
  highlightStrength: number; // 0-20
  detail: number; // 1-15
  smoothness: number; // 1-15
}

export type PlasticWrapEffectLayer = EffectLayerOf<
  "plastic-wrap",
  PlasticWrapParams
>;
type PlasticWrapOp = Extract<EffectRenderOp, { kind: "plastic-wrap" }>;

export const PlasticWrapEffect: IPipelineEffect<
  PlasticWrapEffectLayer,
  PlasticWrapOp
> = {
  id: "plastic-wrap",
  label: "Plastic Wrap…",
  menu: { root: "filters", submenu: "artistic" },
  defaultParams: { highlightStrength: 15, detail: 10, smoothness: 7 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "plastic-wrap",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const p = entry.params;
    const buf = new ArrayBuffer(16);
    const f = new Float32Array(buf);
    f[0] = p.highlightStrength;
    f[1] = p.detail;
    f[2] = p.smoothness;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair(
        "filter-plastic-wrap",
        "fs_plastic_wrap",
        STD_BINDINGS,
      ),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: PlasticWrapPanel,
};
