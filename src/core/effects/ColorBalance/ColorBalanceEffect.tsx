import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { ColorBalancePanel } from "./ColorBalancePanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

const ColorBalanceIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.1"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <line x1="6" y1="1.5" x2="6" y2="10.5" />
    <line x1="2" y1="4" x2="10" y2="4" />
    <polygon points="2,4 1.1,6.2 2.9,6.2" fill="currentColor" stroke="none" />
    <polygon points="10,4 9.1,6.2 10.9,6.2" fill="currentColor" stroke="none" />
    <line x1="4.5" y1="10.5" x2="7.5" y2="10.5" />
  </svg>
);


export interface ColorBalanceParams {
    shadows: { cr: number; mg: number; yb: number };
    midtones: { cr: number; mg: number; yb: number };
    highlights: { cr: number; mg: number; yb: number };
    preserveLuminosity: boolean;
}

export type ColorBalanceEffectLayer = EffectLayerOf<"color-balance", ColorBalanceParams>;

type ColorBalanceOp = Extract<EffectRenderOp, { kind: "color-balance" }>;

export const ColorBalanceEffect: IPipelineEffect<
  ColorBalanceEffectLayer,
  ColorBalanceOp
> = {
  id: "color-balance",
  label: "Color Balance…",
  menu: { root: "adjustments", submenu: "adj-color" },
  defaultParams: {
    shadows: { cr: 0, mg: 0, yb: 0 },
    midtones: { cr: 0, mg: 0, yb: 0 },
    highlights: { cr: 0, mg: 0, yb: 0 },
    preserveLuminosity: true,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "color-balance",
      layerId: layer.id,
      params: layer.params,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const p = entry.params;
    const buf = new ArrayBuffer(48);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f[0] = p.shadows.cr;
    f[1] = p.shadows.mg;
    f[2] = p.shadows.yb;
    f[3] = p.midtones.cr;
    f[4] = p.midtones.mg;
    f[5] = p.midtones.yb;
    f[6] = p.highlights.cr;
    f[7] = p.highlights.mg;
    f[8] = p.highlights.yb;
    u[9] = p.preserveLuminosity ? 1 : 0;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("cb", "fs_color_balance", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: ColorBalancePanel,
  icon: ColorBalanceIcon,
};
