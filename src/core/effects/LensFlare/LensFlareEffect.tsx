import type { LensFlareEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { LensFlarePanel } from "./LensFlarePanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

type LensFlareOp = Extract<EffectRenderOp, { kind: "lens-flare" }>;

export const LensFlareEffect: IPipelineEffect<
  LensFlareEffectLayer,
  LensFlareOp
> = {
  id: "lens-flare",
  label: "Lens Flare…",
  menu: { root: "filters", submenu: "render" },
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
    const p = layer.params;
    return {
      kind: "lens-flare",
      layerId: layer.id,
      centerX: p.centerX,
      centerY: p.centerY,
      brightness: p.brightness,
      lensType: p.lensType,
      ringOpacity: p.ringOpacity,
      streakStrength: p.streakStrength,
      streakWidth: p.streakWidth,
      streakRotation: p.streakRotation,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    // LensFlareParams: 12 × u32 = 48 bytes (matches the WGSL struct, including
    // the trailing `imgWidth`, `imgHeight`, and two padding slots required by
    // WGSL's 16-byte uniform-buffer alignment rules).
    const buf = new Uint32Array(12);
    buf[0] = Math.round(entry.centerX);
    buf[1] = Math.round(entry.centerY);
    buf[2] = entry.brightness;
    buf[3] = entry.lensType;
    buf[4] = entry.ringOpacity;
    buf[5] = entry.streakStrength;
    buf[6] = entry.streakWidth;
    buf[7] = entry.streakRotation;
    buf[8] = dstTex.width;
    buf[9] = dstTex.height;
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
