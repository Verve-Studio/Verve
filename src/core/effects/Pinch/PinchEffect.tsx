import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { PinchOptions } from "./PinchOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";


  /** Photoshop-style Pinch — pulls pixels toward (positive amount) or pushes
   *  them away from (negative) a centre point with a smooth radial falloff. */
export interface PinchParams {
    /** −100..100. Positive pinches inward, negative spherises outward. */
    amount: number;
    /** Falloff radius as a fraction of the image's half-diagonal (0..1). */
    radius: number;
    centerX: number;
    centerY: number;
    edgeMode: "transparent" | "clamp" | "mirror";
}

export type PinchEffectLayer = EffectLayerOf<"pinch", PinchParams>;

type PinchOp = Extract<EffectRenderOp, { kind: "pinch" }>;

const EDGE_MAP = { transparent: 0, clamp: 1, mirror: 2 } as const;

export const PinchEffect: IPipelineEffect<PinchEffectLayer, PinchOp> = {
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
    return {
      kind: "pinch",
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
    const u = new Uint32Array(buf);
    f[0] = p.amount / 100;
    f[1] = p.radius;
    f[2] = p.centerX;
    f[3] = p.centerY;
    u[4] = EDGE_MAP[p.edgeMode];
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("pinch", "fs_pinch", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: PinchOptions,
};
