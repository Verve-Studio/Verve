import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { LensDistortionOptions } from "./LensDistortionOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";


export interface LensDistortionParams {
    /** Distortion model. `radial` covers barrel/pincushion via signed strength;
     *  `fisheye` is an equidistant fisheye projection; `mustache` adds a
     *  fourth-order term for the classic wave/moustache lens defect;
     *  `perspective` is a keystone-style projective transform. */
    type: "radial" | "fisheye" | "mustache" | "perspective";
    /** Primary distortion strength. −100 = max pincushion, +100 = max barrel.
     *  For fisheye, magnitude controls the field-of-view; sign is ignored. */
    strength: number;
    /** Secondary (4th-order) distortion term, used only by `mustache`. */
    secondary: number;
    /** Distortion centre in normalised image coords (0..1, default 0.5). */
    centerX: number;
    centerY: number;
    /** Post-distortion zoom (50..200%, 100 = no zoom). Used to crop barrel
     *  shrinkage or compensate for the empty corners pincushion produces. */
    zoom: number;
    /** Perspective tilt around the vertical axis (−100..100). */
    tiltX: number;
    /** Perspective tilt around the horizontal axis (−100..100). */
    tiltY: number;
    /** What to sample when the distorted UV falls outside the source image:
     *  `transparent` leaves it empty, `clamp` repeats the edge, `mirror`
     *  reflects. */
    edgeMode: "transparent" | "clamp" | "mirror";
}

export type LensDistortionEffectLayer = EffectLayerOf<"lens-distortion", LensDistortionParams>;

type LensDistortionOp = Extract<
  EffectRenderOp,
  { kind: "lens-distortion" }
>;

const TYPE_MAP = { radial: 0, fisheye: 1, mustache: 2, perspective: 3 } as const;
const EDGE_MAP = { transparent: 0, clamp: 1, mirror: 2 } as const;

export const LensDistortionEffect: IPipelineEffect<
  LensDistortionEffectLayer,
  LensDistortionOp
> = {
  id: "lens-distortion",
  label: "Lens Distortion…",
  menu: { root: "effects", submenu: "fx-distortion" },
  defaultParams: {
    type: "radial",
    strength: 25,
    secondary: 0,
    centerX: 0.5,
    centerY: 0.5,
    zoom: 100,
    tiltX: 0,
    tiltY: 0,
    edgeMode: "transparent",
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "lens-distortion",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const p = entry.params;
    // LensDistParams: 48 bytes (12 × 4-byte slots). WGSL rounds the struct
    // size up to a multiple of 16 for uniform-buffer storage.
    const buf = new ArrayBuffer(48);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    u[0] = TYPE_MAP[p.type];
    u[1] = EDGE_MAP[p.edgeMode];
    f[4] = p.strength / 100;
    f[5] = p.secondary / 100;
    f[6] = p.centerX;
    f[7] = p.centerY;
    f[8] = p.zoom / 100;
    f[9] = p.tiltX / 100;
    f[10] = p.tiltY / 100;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("lens-distortion", "fs_lens_distortion", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: LensDistortionOptions,
};
