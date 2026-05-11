import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { WatercolorPanel } from "./WatercolorPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

export interface WatercolorParams {
  /** 1-14. Higher values preserve more detail; lower values produce a
   *  bigger, washier blend. */
  brushDetail: number;
  /** 0-10. How strongly pigment pools darken at edges. */
  shadowIntensity: number;
  /** 1-3. Strength of the paper-grain modulation. */
  texture: number;
}

export type WatercolorEffectLayer = EffectLayerOf<"watercolor", WatercolorParams>;
type WatercolorOp = Extract<EffectRenderOp, { kind: "watercolor" }>;

export const WatercolorEffect: IPipelineEffect<
  WatercolorEffectLayer,
  WatercolorOp
> = {
  id: "watercolor",
  label: "Watercolor…",
  menu: { root: "filters", submenu: "artistic" },
  defaultParams: { brushDetail: 9, shadowIntensity: 1, texture: 1 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "watercolor",
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
    f[0] = p.brushDetail;
    f[1] = p.shadowIntensity;
    f[2] = p.texture;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair(
        "filter-watercolor",
        "fs_watercolor",
        STD_BINDINGS,
      ),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: WatercolorPanel,
};
