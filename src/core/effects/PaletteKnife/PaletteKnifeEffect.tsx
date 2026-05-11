import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { PaletteKnifePanel } from "./PaletteKnifePanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

export interface PaletteKnifeParams {
  strokeSize: number; // 1-50
  strokeDetail: number; // 1-3
  softness: number; // 0-10
}

export type PaletteKnifeEffectLayer = EffectLayerOf<
  "palette-knife",
  PaletteKnifeParams
>;
type PaletteKnifeOp = Extract<EffectRenderOp, { kind: "palette-knife" }>;

export const PaletteKnifeEffect: IPipelineEffect<
  PaletteKnifeEffectLayer,
  PaletteKnifeOp
> = {
  id: "palette-knife",
  label: "Palette Knife…",
  menu: { root: "filters", submenu: "artistic" },
  defaultParams: { strokeSize: 25, strokeDetail: 3, softness: 0 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "palette-knife",
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
    f[0] = p.strokeSize;
    f[1] = p.strokeDetail;
    f[2] = p.softness;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair(
        "filter-palette-knife",
        "fs_palette_knife",
        STD_BINDINGS,
      ),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: PaletteKnifePanel,
};
