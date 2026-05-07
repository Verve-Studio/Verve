import type { LensDistortionAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { LensDistortionOptions } from "@/ux/windows/effects/LensDistortionOptions/LensDistortionOptions";
import type { IPipelineEffect } from "./IPipelineEffect";

type LensDistortionOp = Extract<
  AdjustmentRenderOp,
  { kind: "lens-distortion" }
>;

const TYPE_MAP = { radial: 0, fisheye: 1, mustache: 2, perspective: 3 } as const;
const EDGE_MAP = { transparent: 0, clamp: 1, mirror: 2 } as const;

export const LensDistortionEffect: IPipelineEffect<
  LensDistortionAdjustmentLayer,
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
    const p = layer.params;
    return {
      kind: "lens-distortion",
      layerId: layer.id,
      distType: TYPE_MAP[p.type],
      edgeMode: EDGE_MAP[p.edgeMode],
      strength: p.strength / 100,
      secondary: p.secondary / 100,
      centerX: p.centerX,
      centerY: p.centerY,
      zoom: p.zoom / 100,
      tiltX: p.tiltX / 100,
      tiltY: p.tiltY / 100,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    // LensDistParams: 48 bytes (12 × 4-byte slots). WGSL rounds the struct
    // size up to a multiple of 16 for uniform-buffer storage.
    const buf = new ArrayBuffer(48);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    u[0] = entry.distType;
    u[1] = entry.edgeMode;
    f[4] = entry.strength;
    f[5] = entry.secondary;
    f[6] = entry.centerX;
    f[7] = entry.centerY;
    f[8] = entry.zoom;
    f[9] = entry.tiltX;
    f[10] = entry.tiltY;
    engine.encodeStdAdjRenderPass(
      encoder,
      engine.lensDistortionPipeline,
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: LensDistortionOptions,
};
