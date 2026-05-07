import type { PinchAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { PinchOptions } from "@/ux/windows/effects/PinchOptions/PinchOptions";
import type { IPipelineEffect } from "./IPipelineEffect";

type PinchOp = Extract<AdjustmentRenderOp, { kind: "pinch" }>;

const EDGE_MAP = { transparent: 0, clamp: 1, mirror: 2 } as const;

export const PinchEffect: IPipelineEffect<PinchAdjustmentLayer, PinchOp> = {
  id: "pinch",
  label: "Pinch…",
  menu: { root: "effects", submenu: "fx-distortion" },
  defaultParams: {
    amount: 50,
    radius: 0.5,
    centerX: 0.5,
    centerY: 0.5,
    edgeMode: "clamp",
  },

  buildPlanEntry(layer, { mask }) {
    const p = layer.params;
    return {
      kind: "pinch",
      layerId: layer.id,
      amount: p.amount / 100,
      radius: p.radius,
      centerX: p.centerX,
      centerY: p.centerY,
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
    f[1] = entry.radius;
    f[2] = entry.centerX;
    f[3] = entry.centerY;
    u[4] = entry.edgeMode;
    engine.encodeStdAdjRenderPass(
      encoder,
      engine.pinchPipeline,
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: PinchOptions,
};
