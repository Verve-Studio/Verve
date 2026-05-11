import type { EffectLayerOf, RGBAColor } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { NeonGlowPanel } from "./NeonGlowPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

export interface NeonGlowParams {
  /** Glow size in pixels (-24 to 24). Negative pulls toward sharp neon,
   *  positive blooms outward into a soft halo. */
  glowSize: number;
  /** Overall glow brightness (0-50). */
  glowBrightness: number;
  /** RGB midtone glow colour. r/g/b are 0-255. */
  glowColor: RGBAColor;
}

export type NeonGlowEffectLayer = EffectLayerOf<"neon-glow", NeonGlowParams>;
type NeonGlowOp = Extract<EffectRenderOp, { kind: "neon-glow" }>;

export const NeonGlowEffect: IPipelineEffect<
  NeonGlowEffectLayer,
  NeonGlowOp
> = {
  id: "neon-glow",
  label: "Neon Glow…",
  menu: { root: "filters", submenu: "artistic" },
  defaultParams: {
    glowSize: 5,
    glowBrightness: 15,
    glowColor: { r: 76, g: 220, b: 230, a: 255 },
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "neon-glow",
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
    f[0] = p.glowSize;
    f[1] = p.glowBrightness;
    f[2] = p.glowColor.r / 255;
    f[3] = p.glowColor.g / 255;
    f[4] = p.glowColor.b / 255;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair(
        "filter-neon-glow",
        "fs_neon_glow",
        STD_BINDINGS,
      ),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: NeonGlowPanel,
};
