import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { PosterEdgesPanel } from "./PosterEdgesPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

export interface PosterEdgesParams {
  edgeThickness: number; // 0-10
  edgeIntensity: number; // 0-10
  posterization: number; // 0-6
}

export type PosterEdgesEffectLayer = EffectLayerOf<
  "poster-edges",
  PosterEdgesParams
>;
type PosterEdgesOp = Extract<EffectRenderOp, { kind: "poster-edges" }>;

export const PosterEdgesEffect: IPipelineEffect<
  PosterEdgesEffectLayer,
  PosterEdgesOp
> = {
  id: "poster-edges",
  label: "Poster Edges…",
  menu: { root: "filters", submenu: "artistic" },
  defaultParams: { edgeThickness: 2, edgeIntensity: 4, posterization: 2 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "poster-edges",
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
    f[0] = p.edgeThickness;
    f[1] = p.edgeIntensity;
    f[2] = p.posterization;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair(
        "filter-poster-edges",
        "fs_poster_edges",
        STD_BINDINGS,
      ),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: PosterEdgesPanel,
};
