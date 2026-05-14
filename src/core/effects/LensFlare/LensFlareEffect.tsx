import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { LensFlarePanel } from "./LensFlarePanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";


  /** Photographic lens flare overlay, additively composited over the layer. */
export interface LensFlareParams {
    /** Flare center X in canvas-pixel coordinates. */
    centerX: number;
    /** Flare center Y in canvas-pixel coordinates. */
    centerY: number;
    /** Overall brightness multiplier, 10–300%. */
    brightness: number;
    /** Lens type preset: 0 = zoom, 1 = 35mm, 2 = 105mm, 3 = movie, 4 = anamorphic. */
    lensType: number;
    /** Iris-ring opacity, 0–100%. */
    ringOpacity: number;
    /** Streak intensity, 0–100%. */
    streakStrength: number;
    /** Streak width, 1–500%. */
    streakWidth: number;
    /** Streak rotation, 0–359°. */
    streakRotation: number;
}

export type LensFlareEffectLayer = EffectLayerOf<"lens-flare", LensFlareParams>;

type LensFlareOp = Extract<EffectRenderOp, { kind: "lens-flare" }>;

export const LensFlareEffect: IPipelineEffect<
  LensFlareEffectLayer,
  LensFlareOp
> = {
  id: "lens-flare",
  label: "Lens Flare…",
  menu: { root: "effects", submenu: "fx-lenseffects" },
  defaultParams: {
    centerX: 256,
    centerY: 256,
    brightness: 100,
    lensType: 0,
    ringOpacity: 20,
    streakStrength: 50,
    streakWidth: 50,
    streakRotation: 0,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "lens-flare",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const p = entry.params;
    // LensFlareParams: 12 × u32 = 48 bytes (matches the WGSL struct, including
    // the trailing `imgWidth`, `imgHeight`, and two padding slots required by
    // WGSL's 16-byte uniform-buffer alignment rules).
    const buf = new Uint32Array(12);
    buf[0] = Math.round(p.centerX);
    buf[1] = Math.round(p.centerY);
    buf[2] = p.brightness;
    buf[3] = p.lensType;
    buf[4] = p.ringOpacity;
    buf[5] = p.streakStrength;
    buf[6] = p.streakWidth;
    buf[7] = p.streakRotation;
    buf[8] = dstTex.width;
    buf[9] = dstTex.height;
    // `inputIsLinear`: tell the shader whether the composite ping-pong it's
    // sampling holds scene-linear floats (rgba32f docs) or sRGB-encoded
    // bytes (rgba8 docs). The flare overlay colours were authored against
    // perceptual sRGB; the shader encodes/decodes around the additive
    // composite when this flag is set so the on-screen brightness matches
    // in either pixel format.
    const isLinear = format === "rgba16float" || format === "rgba32float";
    buf[10] = isLinear ? 1 : 0;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("filter-lens-flare", "fs_lens_flare", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      buf.buffer as ArrayBuffer,
      entry.selMaskLayer,
    );
  },

  Panel: LensFlarePanel,
};
