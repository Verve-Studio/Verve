import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { PaintDaubsPanel } from "./PaintDaubsPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

export type PaintDaubsBrushType =
  | "simple"
  | "light-rough"
  | "dark-rough"
  | "wide-sharp"
  | "wide-blurry"
  | "sparkle";

export interface PaintDaubsParams {
  brushSize: number; // 1-50
  sharpness: number; // 0-40
  brushType: PaintDaubsBrushType;
}

export type PaintDaubsEffectLayer = EffectLayerOf<
  "paint-daubs",
  PaintDaubsParams
>;
type PaintDaubsOp = Extract<EffectRenderOp, { kind: "paint-daubs" }>;

const BRUSH_TYPE_ID: Record<PaintDaubsBrushType, number> = {
  simple: 0,
  "light-rough": 1,
  "dark-rough": 2,
  "wide-sharp": 3,
  "wide-blurry": 4,
  sparkle: 5,
};

export const PaintDaubsEffect: IPipelineEffect<
  PaintDaubsEffectLayer,
  PaintDaubsOp
> = {
  id: "paint-daubs",
  label: "Paint Daubs…",
  menu: { root: "filters", submenu: "artistic" },
  defaultParams: { brushSize: 8, sharpness: 20, brushType: "simple" },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "paint-daubs",
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
    const u = new Uint32Array(buf);
    f[0] = p.brushSize;
    f[1] = p.sharpness;
    u[2] = BRUSH_TYPE_ID[p.brushType];
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair(
        "filter-paint-daubs",
        "fs_paint_daubs",
        STD_BINDINGS,
      ),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: PaintDaubsPanel,
};
