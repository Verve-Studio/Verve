import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { DryBrushPanel } from "./DryBrushPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

export interface DryBrushParams {
  /** Brush size 0-10. Drives the blur radius that fuses small detail. */
  brushSize: number;
  /** Brush detail 0-10. More detail = more preserved colour levels. */
  brushDetail: number;
  /** Texture 1-3. Grain strength applied on top of the brushwork. */
  texture: number;
}

export type DryBrushEffectLayer = EffectLayerOf<"dry-brush", DryBrushParams>;
type DryBrushOp = Extract<EffectRenderOp, { kind: "dry-brush" }>;

export const DryBrushEffect: IPipelineEffect<
  DryBrushEffectLayer,
  DryBrushOp
> = {
  id: "dry-brush",
  label: "Dry Brush…",
  menu: { root: "filters", submenu: "artistic" },
  defaultParams: { brushSize: 2, brushDetail: 8, texture: 1 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "dry-brush",
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
        "filter-dry-brush",
        "fs_dry_brush",
        STD_BINDINGS,
      ),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: DryBrushPanel,
};
