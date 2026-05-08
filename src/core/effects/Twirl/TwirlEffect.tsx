import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { TwirlOptions } from "./TwirlOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";
import { DistortionIcon } from "../_shared/icons";


  /** Twirl — angular rotation that decays from a centre point. */
export interface TwirlParams {
    /** Twirl angle in degrees (−1080..1080, multi-rev allowed). */
    angle: number;
    centerX: number;
    centerY: number;
    /** Effective twirl radius as fraction of the image half-diagonal (0..1). */
    radius: number;
    edgeMode: "transparent" | "clamp" | "mirror";
}

export type TwirlEffectLayer = EffectLayerOf<"twirl", TwirlParams>;

type TwirlOp = Extract<EffectRenderOp, { kind: "twirl" }>;

const EDGE_MAP = { transparent: 0, clamp: 1, mirror: 2 } as const;

export const TwirlEffect: IPipelineEffect<TwirlEffectLayer, TwirlOp> = {
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
    return {
      kind: "twirl",
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
    f[0] = (p.angle * Math.PI) / 180;
    f[1] = p.centerX;
    f[2] = p.centerY;
    f[3] = p.radius;
    u[4] = EDGE_MAP[p.edgeMode];
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("twirl", "fs_twirl", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: TwirlOptions,
  icon: DistortionIcon,
};
