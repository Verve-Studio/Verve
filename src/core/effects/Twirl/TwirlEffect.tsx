import type { TwirlAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { TwirlOptions } from "./TwirlOptions";
import type { IPipelineEffect } from "../IPipelineEffect";

type TwirlOp = Extract<AdjustmentRenderOp, { kind: "twirl" }>;

const EDGE_MAP = { transparent: 0, clamp: 1, mirror: 2 } as const;

export const TwirlEffect: IPipelineEffect<TwirlAdjustmentLayer, TwirlOp> = {
  id: "twirl",
  label: "Twirl…",
  menu: { root: "effects", submenu: "fx-distortion" },
  defaultParams: {
    angle: 90,
    centerX: 0.5,
    centerY: 0.5,
    radius: 0.7,
    edgeMode: "clamp",
  },

  buildPlanEntry(layer, { mask }) {
    const p = layer.params;
    return {
      kind: "twirl",
      layerId: layer.id,
      angleRad: (p.angle * Math.PI) / 180,
      centerX: p.centerX,
      centerY: p.centerY,
      radius: p.radius,
      edgeMode: EDGE_MAP[p.edgeMode],
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const buf = new ArrayBuffer(32);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f[0] = entry.angleRad;
    f[1] = entry.centerX;
    f[2] = entry.centerY;
    f[3] = entry.radius;
    u[4] = entry.edgeMode;
    engine.encodeStdAdjRenderPass(
      encoder,
      engine.twirlPipeline,
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: TwirlOptions,
};
