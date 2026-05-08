import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { ChromaticAberrationOptions } from "./ChromaticAberrationOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

const ChromaticAberrationIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    <circle
      cx="4.5"
      cy="6"
      r="2.5"
      stroke="#ff5555"
      strokeWidth="1"
      opacity="0.85"
    />
    <circle
      cx="7.5"
      cy="6"
      r="2.5"
      stroke="#55aaff"
      strokeWidth="1"
      opacity="0.85"
    />
  </svg>
);


export interface ChromaticAberrationParams {
    type: "radial" | "directional";
    distance: number; // 0–50 px
    angle: number; // 0–360 degrees (used only when type === 'directional')
}

export type ChromaticAberrationEffectLayer = EffectLayerOf<"chromatic-aberration", ChromaticAberrationParams>;

type ChromaticAberrationOp = Extract<
  EffectRenderOp,
  { kind: "chromatic-aberration" }
>;

export const ChromaticAberrationEffect: IPipelineEffect<
  ChromaticAberrationEffectLayer,
  ChromaticAberrationOp
> = {
  id: "chromatic-aberration",
  label: "Chromatic Aberration…",
  menu: { root: "effects", submenu: "fx-lenseffects" },
  defaultParams: { type: "radial", distance: 5, angle: 0 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "chromatic-aberration",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const buf = new ArrayBuffer(16);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    u[0] = entry.params.type === "radial" ? 0 : 1;
    f[1] = entry.params.distance;
    f[2] = entry.params.angle;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("chromatic-aberration", "fs_chromatic_aberration", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: ChromaticAberrationOptions,
  icon: ChromaticAberrationIcon,
};
