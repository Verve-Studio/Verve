import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { SeamlessTexturePanel } from "./SeamlessTexturePanel";
import type { IPipelineEffect } from "../IPipelineEffect";


export interface SeamlessTextureParams {
    /** Enable the Voronoi island break-repetition pass. Default: true */
    breakRepetition: boolean;
    /** Cell/island size in pixels (1–512). Default: 128 */
    cellSize: number;
    /** Blend/feather radius in pixels at island borders (0–128). Default: 16 */
    blendRadius: number;
    /** Enable the seamless border blending pass. Default: true */
    seamlessBorders: boolean;
    /** Horizontal border blend radius in pixels (0–256). Default: 32.
     *  0 disables the X-axis blend (the texture won't tile horizontally). */
    borderRadiusX: number;
    /** Vertical border blend radius in pixels (0–256). Default: 32.
     *  0 disables the Y-axis blend (the texture won't tile vertically). */
    borderRadiusY: number;
    /** When true, X and Y radii move together in the panel. Default: true. */
    linkBorderRadius: boolean;
    /** Maximum mix amount at the very edge, 0..1. The original shader hard-
     *  coded this as 0.5 (half mirror, half original) which left visible
     *  seams on contrasty textures. Crank it higher when the seam is still
     *  noticeable; drop it lower for a subtler blend. Default: 0.5 to match
     *  legacy behaviour for documents saved before this knob existed. */
    borderStrength: number;
    /** Random seed. */
    seed: number;
    /** @deprecated Pre-axis-split single-radius value. Documents saved before
     *  the H/V split set only this; the panel and effect read it as the
     *  fallback for `borderRadiusX`/`borderRadiusY` when those are absent. */
    borderRadius?: number;
}

export type SeamlessTextureEffectLayer = EffectLayerOf<"seamless-texture", SeamlessTextureParams>;

type SeamlessTextureOp = Extract<
  EffectRenderOp,
  { kind: "seamless-texture" }
>;

export const SeamlessTextureEffect: IPipelineEffect<
  SeamlessTextureEffectLayer,
  SeamlessTextureOp
> = {
  id: "seamless-texture",
  label: "Seamless Texture…",
  menu: { root: "filters", submenu: "texture" },
  defaultParams: {
    breakRepetition: true,
    cellSize: 128,
    blendRadius: 16,
    seamlessBorders: true,
    borderRadiusX: 32,
    borderRadiusY: 32,
    linkBorderRadius: true,
    borderStrength: 0.5,
    seed: 0,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "seamless-texture",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const w = dstTex.width;
    const h = dstTex.height;
    const {
      breakRepetition,
      cellSize,
      blendRadius,
      seamlessBorders,
      seed,
    } = entry.params;
    // Resolve per-axis border radii with legacy fallback. Documents saved
    // before the H/V split only have `borderRadius`; treat that as the
    // value for both axes so old projects open identically.
    const legacyR = entry.params.borderRadius ?? 32;
    const borderRadiusX = entry.params.borderRadiusX ?? legacyR;
    const borderRadiusY = entry.params.borderRadiusY ?? legacyR;
    // Border-blend strength: documents pre-dating this param keep the
    // legacy hardcoded 0.5 mix.
    const borderStrength = Math.max(
      0,
      Math.min(1, entry.params.borderStrength ?? 0.5),
    );

    // Build the 32-byte border uniform: four u32 + one f32 + 12 bytes pad.
    // Mixing types in the same buffer needs ArrayBuffer + DataView.
    const makeBorderUniform = (
      width: number,
      height: number,
      rx: number,
      ry: number,
      strength: number,
    ): ArrayBuffer => {
      const buf = new ArrayBuffer(32);
      const u32 = new Uint32Array(buf);
      const f32 = new Float32Array(buf);
      u32[0] = width;
      u32[1] = height;
      u32[2] = rx;
      u32[3] = ry;
      f32[4] = strength;
      return buf;
    };
    const breakPair = rt.getRenderPipelinePair(
      "filter-seamless-break",
      "fs_seamless_break",
    );
    const borderPair = rt.getRenderPipelinePair(
      "filter-seamless-border",
      "fs_seamless_border",
    );

    if (!breakRepetition && !seamlessBorders) {
      // Both passes off → still emit the border pass as a pass-through (zero
      // radii on both axes ⇒ no blending). Uniform must match the shader's
      // 32-byte BorderParams layout, so use makeBorderUniform with zeros.
      rt.encodeRenderPass(
        encoder,
        rt.selectPipeline(borderPair, dstTex),
        dstTex,
        [
          { binding: 0, resource: srcTex.createView() },
          {
            binding: 2,
            resource: {
              buffer: rt.makeParamsBuf(makeBorderUniform(w, h, 0, 0, 0)),
            },
          },
        ],
      );
      return;
    }

    if (breakRepetition) {
      const p1 = rt.makeParamsBuf(
        new Uint32Array([
          w,
          h,
          Math.max(1, cellSize),
          Math.max(0, blendRadius),
          seed >>> 0,
          0,
          0,
          0,
        ]),
      );
      const pass1Dst = seamlessBorders ? rt.makeRgba8Tex(w, h) : dstTex;
      rt.encodeRenderPass(
        encoder,
        rt.selectPipeline(breakPair, pass1Dst),
        pass1Dst,
        [
          { binding: 0, resource: srcTex.createView() },
          { binding: 2, resource: { buffer: p1 } },
        ],
      );

      if (seamlessBorders) {
        const p2 = rt.makeParamsBuf(
          makeBorderUniform(
            w,
            h,
            Math.max(0, borderRadiusX),
            Math.max(0, borderRadiusY),
            borderStrength,
          ),
        );
        rt.encodeRenderPass(
          encoder,
          rt.selectPipeline(borderPair, dstTex),
          dstTex,
          [
            { binding: 0, resource: pass1Dst.createView() },
            { binding: 2, resource: { buffer: p2 } },
          ],
        );
      }
    } else {
      const p2 = rt.makeParamsBuf(
        makeBorderUniform(
          w,
          h,
          Math.max(0, borderRadiusX),
          Math.max(0, borderRadiusY),
          borderStrength,
        ),
      );
      rt.encodeRenderPass(
        encoder,
        rt.selectPipeline(borderPair, dstTex),
        dstTex,
        [
          { binding: 0, resource: srcTex.createView() },
          { binding: 2, resource: { buffer: p2 } },
        ],
      );
    }
  },

  Panel: SeamlessTexturePanel,
};
