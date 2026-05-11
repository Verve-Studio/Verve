import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { CutoutPanel } from "./CutoutPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

export interface CutoutParams {
  /** Number of colour levels per channel (2-8). Fewer levels = more
   *  poster-like banding. */
  levels: number;
  /** Edge simplification radius (1-10). Higher values fuse adjacent
   *  detail into bigger flat regions. */
  edgeSimplicity: number;
  /** Edge fidelity (1-3). Higher values recover edge accuracy by
   *  reducing the effective simplification radius. */
  edgeFidelity: number;
}

export type CutoutEffectLayer = EffectLayerOf<"cutout", CutoutParams>;
type CutoutOp = Extract<EffectRenderOp, { kind: "cutout" }>;

export const CutoutEffect: IPipelineEffect<CutoutEffectLayer, CutoutOp> = {
  id: "cutout",
  label: "Cutout…",
  menu: { root: "filters", submenu: "artistic" },
  defaultParams: { levels: 4, edgeSimplicity: 4, edgeFidelity: 2 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "cutout",
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
    f[0] = p.levels;
    f[1] = p.edgeSimplicity;
    f[2] = p.edgeFidelity;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair(
        "filter-cutout",
        "fs_cutout",
        STD_BINDINGS,
      ),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: CutoutPanel,
};
