import type { RippleEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { RippleOptions } from "./RippleOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

type RippleOp = Extract<EffectRenderOp, { kind: "ripple" }>;

const DIR_MAP = { horizontal: 0, vertical: 1, both: 2 } as const;
const EDGE_MAP = { transparent: 0, clamp: 1, mirror: 2 } as const;

export const RippleEffect: IPipelineEffect<RippleEffectLayer, RippleOp> = {
  id: "ripple",
  label: "Ripple…",
  menu: { root: "effects", submenu: "fx-distortion" },
  defaultParams: {
    amount: 100,
    size: 25,
    direction: "both",
    edgeMode: "mirror",
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "ripple",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const p = entry.params;
    // Map the abstract `size` slider (1..100) into a wavelength in pixels.
    const wavelengthPx = Math.max(2, p.size * 4);
    const buf = new ArrayBuffer(32);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f[0] = p.amount;
    f[1] = wavelengthPx;
    u[2] = DIR_MAP[p.direction];
    u[3] = EDGE_MAP[p.edgeMode];
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("ripple", "fs_ripple", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: RippleOptions,
};
