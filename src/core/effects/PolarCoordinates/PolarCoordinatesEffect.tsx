import type { PolarCoordinatesEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { PolarCoordinatesOptions } from "./PolarCoordinatesOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

type PolarCoordinatesOp = Extract<
  EffectRenderOp,
  { kind: "polar-coordinates" }
>;

const EDGE_MAP = { transparent: 0, clamp: 1, mirror: 2 } as const;

export const PolarCoordinatesEffect: IPipelineEffect<
  PolarCoordinatesEffectLayer,
  PolarCoordinatesOp
> = {
  id: "polar-coordinates",
  label: "Polar Coordinates…",
  menu: { root: "effects", submenu: "fx-distortion" },
  defaultParams: {
    mode: "rect-to-polar",
    centerX: 0.5,
    centerY: 0.5,
    edgeMode: "transparent",
  },

  buildPlanEntry(layer, { mask }) {
    const p = layer.params;
    return {
      kind: "polar-coordinates",
      layerId: layer.id,
      mode: p.mode === "rect-to-polar" ? 0 : 1,
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
    u[0] = entry.mode;
    f[1] = entry.centerX;
    f[2] = entry.centerY;
    u[3] = entry.edgeMode;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("polar-coordinates", "fs_polar", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: PolarCoordinatesOptions,
};
