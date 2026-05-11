import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { ReplaceColorPanel } from "./ReplaceColorPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

const ReplaceColorIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    <circle cx="4.2" cy="6" r="2.5" />
    <circle cx="8.4" cy="6" r="2.5" strokeDasharray="2 1.2" />
    <path d="M6 3.6 L7 6 L6 8.4" strokeOpacity="0.6" />
  </svg>
);

/**
 * Replace Color — swap a picked source colour with a target colour while
 * preserving per-pixel shading.
 *
 * The shader does the actual chromaticity rotation in CIE LAB / LCH so the
 * lightness channel is preserved verbatim (a shadow stays a shadow) while
 * the hue and chroma shift to the target. See `replace-color.wgsl` for
 * the algorithm.
 */
export interface ReplaceColorParams {
  /** Colour being matched, sRGB bytes (0–255). Eyedropper-friendly. */
  originalColor: { r: number; g: number; b: number };
  /** Colour to swap matched pixels to, sRGB bytes (0–255). */
  targetColor: { r: number; g: number; b: number };
  /** Half-width of the LCH hue window, in degrees. 0 = exact-hue only,
   *  180 = every hue (entire image). */
  hueRange: number;
  /** Strength of the replacement, 0–100. Linearly interpolates between
   *  "no change" (0) and "full hue rotation + chroma scale" (100). */
  amount: number;
}

export type ReplaceColorEffectLayer = EffectLayerOf<"replace-color", ReplaceColorParams>;

type ReplaceColorOp = Extract<EffectRenderOp, { kind: "replace-color" }>;

export const ReplaceColorEffect: IPipelineEffect<
  ReplaceColorEffectLayer,
  ReplaceColorOp
> = {
  id: "replace-color",
  label: "Replace Color…",
  menu: { root: "adjustments", submenu: "adj-color" },
  defaultParams: {
    // Pre-fill with a recognisable but visually-muted swap so the swatch
    // isn't a glaring red on first add — the user immediately changes
    // both via the swatches anyway.
    originalColor: { r: 170, g: 80, b: 80 },
    targetColor: { r: 80, g: 110, b: 170 },
    hueRange: 30,
    amount: 100,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "replace-color",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const { originalColor, targetColor, hueRange, amount } = entry.params;
    // 48-byte uniform — matches `ReplaceColorParams` in replace-color.wgsl.
    // Layout (offset / bytes):
    //   0  vec3<f32>  origCol      (sRGB 0..1)
    //  12  f32        hueRange
    //  16  vec3<f32>  targetCol    (sRGB 0..1)
    //  28  f32        amount
    //  32  u32        inputLinear  (1 iff source layer is rgba32float)
    //  36                          (12 bytes trailing pad to 48)
    const buf = new ArrayBuffer(48);
    const f32 = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    f32[0] = originalColor.r / 255;
    f32[1] = originalColor.g / 255;
    f32[2] = originalColor.b / 255;
    f32[3] = hueRange;
    f32[4] = targetColor.r / 255;
    f32[5] = targetColor.g / 255;
    f32[6] = targetColor.b / 255;
    f32[7] = amount;
    u32[8] = format === "rgba32float" ? 1 : 0;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair(
        "replace-color",
        "fs_replace_color",
        STD_BINDINGS,
      ),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: ReplaceColorPanel,
  icon: ReplaceColorIcon,
};
