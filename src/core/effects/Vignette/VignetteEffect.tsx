import type { VignetteEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { VignetteOptions } from "./VignetteOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

type VignetteOp = Extract<EffectRenderOp, { kind: "vignette" }>;

export const VignetteEffect: IPipelineEffect<
  VignetteEffectLayer,
  VignetteOp
> = {
  id: "vignette",
  label: "Vignette…",
  menu: { root: "effects", submenu: "fx-glow" },
  defaultParams: {
    shape: "ellipse",
    spread: 0.55,
    softness: 0.5,
    opacity: 0.75,
    color: { r: 0, g: 0, b: 0 },
    roundness: 0.6,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "vignette",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const p = entry.params;
    const { r, g, b } = p.color;
    // VignetteParams layout (32 bytes):
    //   0  shape u32; 4 spread f32; 8 softness f32; 12 opacity f32;
    //  16  color vec3f; 28 roundness f32
    const buf = new ArrayBuffer(32);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    u[0] = p.shape === "ellipse" ? 0 : 1;
    f[1] = p.spread;
    f[2] = p.softness;
    f[3] = p.opacity;
    f[4] = r / 255;
    f[5] = g / 255;
    f[6] = b / 255;
    f[7] = p.roundness;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("vignette", "fs_vignette", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: VignetteOptions,
};
