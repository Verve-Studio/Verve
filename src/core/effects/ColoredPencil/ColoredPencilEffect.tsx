import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { ColoredPencilPanel } from "./ColoredPencilPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

export interface ColoredPencilParams {
  /** Stroke spacing in pixels (1-24). Lower = denser hatching. */
  pencilWidth: number;
  /** How dark the pencil strokes are (0-15). */
  strokePressure: number;
  /** Paper colour brightness, 0 = mid-gray, 50 = near-white. */
  paperBrightness: number;
  /** Overall filter strength (0-100%). 0 leaves the source untouched,
   *  100 applies the pencil result at full strength. */
  opacity: number;
}

export type ColoredPencilEffectLayer = EffectLayerOf<
  "colored-pencil",
  ColoredPencilParams
>;
type ColoredPencilOp = Extract<EffectRenderOp, { kind: "colored-pencil" }>;

export const ColoredPencilEffect: IPipelineEffect<
  ColoredPencilEffectLayer,
  ColoredPencilOp
> = {
  id: "colored-pencil",
  label: "Colored Pencil…",
  menu: { root: "filters", submenu: "artistic" },
  defaultParams: {
    pencilWidth: 4,
    strokePressure: 8,
    paperBrightness: 25,
    opacity: 100,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "colored-pencil",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const p = entry.params;
    // 32 bytes — matches the WGSL `ColoredPencilParams` struct.
    const buf = new ArrayBuffer(32);
    const f = new Float32Array(buf);
    f[0] = p.pencilWidth;
    f[1] = p.strokePressure;
    f[2] = p.paperBrightness;
    f[3] = p.opacity;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair(
        "filter-colored-pencil",
        "fs_colored_pencil",
        STD_BINDINGS,
      ),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: ColoredPencilPanel,
};
