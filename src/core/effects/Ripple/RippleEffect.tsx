import type { RippleAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { RippleOptions } from "./RippleOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphicspipeline/webgpu/AdjustmentRuntime";

type RippleOp = Extract<AdjustmentRenderOp, { kind: "ripple" }>;

const DIR_MAP = { horizontal: 0, vertical: 1, both: 2 } as const;
const EDGE_MAP = { transparent: 0, clamp: 1, mirror: 2 } as const;

export const RippleEffect: IPipelineEffect<RippleAdjustmentLayer, RippleOp> = {
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
    const p = layer.params;
    // Map the abstract `size` slider (1..100) into a wavelength in pixels.
    const wavelengthPx = Math.max(2, p.size * 4);
    return {
      kind: "ripple",
      layerId: layer.id,
      amount: p.amount,
      wavelengthPx,
      direction: DIR_MAP[p.direction],
      edgeMode: EDGE_MAP[p.edgeMode],
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const buf = new ArrayBuffer(32);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f[0] = entry.amount;
    f[1] = entry.wavelengthPx;
    u[2] = entry.direction;
    u[3] = entry.edgeMode;
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
