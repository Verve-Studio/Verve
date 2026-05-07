import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { PolarCoordinatesOptions } from "./PolarCoordinatesOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";


  /** Photoshop's Polar Coordinates: rect↔polar coordinate conversion. */
export interface PolarCoordinatesParams {
    mode: "rect-to-polar" | "polar-to-rect";
    centerX: number;
    centerY: number;
    edgeMode: "transparent" | "clamp" | "mirror";
}

export type PolarCoordinatesEffectLayer = EffectLayerOf<"polar-coordinates", PolarCoordinatesParams>;

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
    return {
      kind: "polar-coordinates",
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
    u[0] = p.mode === "rect-to-polar" ? 0 : 1;
    f[1] = p.centerX;
    f[2] = p.centerY;
    u[3] = EDGE_MAP[p.edgeMode];
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
