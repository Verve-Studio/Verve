import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { RepeatPanel } from "./RepeatPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

const RepeatIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    <rect x="1" y="1" width="4" height="4" />
    <rect x="7" y="1" width="4" height="4" />
    <rect x="1" y="7" width="4" height="4" />
    <rect x="7" y="7" width="4" height="4" />
  </svg>
);

export type RepeatAxisMode = "none" | "negative" | "positive" | "both";
export type RepeatBackground = "passthrough" | "transparent";

export interface RepeatParams {
  /** Repeat direction on the X axis. "negative" = leftward, "positive" =
   *  rightward, "both" = both sides, "none" = no horizontal repeats. */
  xMode: RepeatAxisMode;
  /** Repeat direction on the Y axis. "negative" = upward, "positive" =
   *  downward, "both" = both sides, "none" = no vertical repeats. */
  yMode: RepeatAxisMode;
  /** Source rect — the region of pixels to tile, in canvas coordinates. */
  rectX: number;
  rectY: number;
  rectW: number;
  rectH: number;
  /** Gap in pixels between adjacent tiles. */
  spacing: number;
  /** What to draw outside the tile interiors. `passthrough` = original
   *  pixels from the layer stack below; `transparent` = punch through. */
  background: RepeatBackground;
}

export type RepeatEffectLayer = EffectLayerOf<"repeat", RepeatParams>;

type RepeatOp = Extract<EffectRenderOp, { kind: "repeat" }>;

const AXIS_MODE_ID: Record<RepeatAxisMode, number> = {
  none: 0,
  negative: 1,
  positive: 2,
  both: 3,
};

const BACKGROUND_ID: Record<RepeatBackground, number> = {
  passthrough: 0,
  transparent: 1,
};

export const RepeatEffect: IPipelineEffect<RepeatEffectLayer, RepeatOp> = {
  id: "repeat",
  label: "Repeat…",
  menu: { root: "filters", submenu: "texture" },
  defaultParams: {
    xMode: "positive",
    yMode: "none",
    rectX: 0,
    rectY: 0,
    rectW: 0,
    rectH: 0,
    spacing: 0,
    background: "passthrough",
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "repeat",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const p = entry.params;
    // 32 bytes — matches the WGSL `RepeatParams` struct exactly.
    const buf = new ArrayBuffer(32);
    const i = new Int32Array(buf);
    const u = new Uint32Array(buf);
    i[0] = Math.round(p.rectX) | 0;
    i[1] = Math.round(p.rectY) | 0;
    i[2] = Math.max(0, Math.round(p.rectW)) | 0;
    i[3] = Math.max(0, Math.round(p.rectH)) | 0;
    i[4] = Math.max(0, Math.round(p.spacing)) | 0;
    u[5] = AXIS_MODE_ID[p.xMode];
    u[6] = AXIS_MODE_ID[p.yMode];
    u[7] = BACKGROUND_ID[p.background];

    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair(
        "filter-repeat",
        "fs_repeat",
        STD_BINDINGS,
      ),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: RepeatPanel,
  icon: RepeatIcon,
};
