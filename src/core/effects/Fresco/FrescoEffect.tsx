import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { FrescoPanel } from "./FrescoPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

export interface FrescoParams {
  brushSize: number;
  brushDetail: number;
  texture: number;
}

export type FrescoEffectLayer = EffectLayerOf<"fresco", FrescoParams>;
type FrescoOp = Extract<EffectRenderOp, { kind: "fresco" }>;

export const FrescoEffect: IPipelineEffect<FrescoEffectLayer, FrescoOp> = {
  id: "fresco",
  label: "Fresco…",
  menu: { root: "filters", submenu: "artistic" },
  defaultParams: { brushSize: 2, brushDetail: 8, texture: 1 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "fresco",
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
    f[0] = p.brushSize;
    f[1] = p.brushDetail;
    f[2] = p.texture;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair(
        "filter-fresco",
        "fs_fresco",
        STD_BINDINGS,
      ),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: FrescoPanel,
};
