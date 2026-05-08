import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { ShearOptions } from "./ShearOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";
import { DistortionIcon } from "../_shared/icons";


  /** Shear — sinusoidal or linear horizontal/vertical pixel shifting. */
export interface ShearParams {
    /** Total pixel shift across the axis (−500..500). */
    amplitude: number;
    /** Axis the shift acts on. `horizontal` shifts pixels along X by an
     *  amount that varies with Y; `vertical` is the opposite. */
    direction: "horizontal" | "vertical";
    /** 0 = pure linear shear, >0 introduces sine-wave shape (Photoshop's
     *  free-form curve approximated via a frequency control). 0..10. */
    waveFrequency: number;
    edgeMode: "transparent" | "clamp" | "mirror";
}

export type ShearEffectLayer = EffectLayerOf<"shear", ShearParams>;

type ShearOp = Extract<EffectRenderOp, { kind: "shear" }>;

const DIR_MAP = { horizontal: 0, vertical: 1 } as const;
const EDGE_MAP = { transparent: 0, clamp: 1, mirror: 2 } as const;

export const ShearEffect: IPipelineEffect<ShearEffectLayer, ShearOp> = {
  id: "shear",
  label: "Shear…",
  menu: { root: "effects", submenu: "fx-distortion" },
  defaultParams: {
    amplitude: 50,
    direction: "horizontal",
    waveFrequency: 1,
    edgeMode: "mirror",
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "shear",
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
    f[0] = p.amplitude;
    u[1] = DIR_MAP[p.direction];
    f[2] = p.waveFrequency;
    u[3] = EDGE_MAP[p.edgeMode];
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("shear", "fs_shear", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: ShearOptions,
  icon: DistortionIcon,
};
