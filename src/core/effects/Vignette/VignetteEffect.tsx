import type { VignetteAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { VignetteOptions } from "./VignetteOptions";
import type { IPipelineEffect } from "../IPipelineEffect";

type VignetteOp = Extract<AdjustmentRenderOp, { kind: "vignette" }>;

export const VignetteEffect: IPipelineEffect<
  VignetteAdjustmentLayer,
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
    const { r, g, b } = layer.params.color;
    return {
      kind: "vignette",
      layerId: layer.id,
      shape: layer.params.shape,
      spread: layer.params.spread,
      softness: layer.params.softness,
      opacity: layer.params.opacity,
      colorR: r / 255,
      colorG: g / 255,
      colorB: b / 255,
      roundness: layer.params.roundness,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    // VignetteParams layout (32 bytes):
    //   0  shape u32; 4 spread f32; 8 softness f32; 12 opacity f32;
    //  16  color vec3f; 28 roundness f32
    const buf = new ArrayBuffer(32);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    u[0] = entry.shape === "ellipse" ? 0 : 1;
    f[1] = entry.spread;
    f[2] = entry.softness;
    f[3] = entry.opacity;
    f[4] = entry.colorR;
    f[5] = entry.colorG;
    f[6] = entry.colorB;
    f[7] = entry.roundness;
    engine.encodeStdAdjRenderPass(
      encoder,
      engine.vignettePipeline,
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: VignetteOptions,
};
