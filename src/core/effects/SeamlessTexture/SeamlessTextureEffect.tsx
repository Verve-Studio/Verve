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
    /** Border blend radius in pixels (1–256). Default: 32 */
    borderRadius: number;
    /** Random seed. */
    seed: number;
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
    borderRadius: 32,
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
      borderRadius,
      seed,
    } = entry.params;
    const breakPair = rt.getRenderPipelinePair(
      "filter-seamless-break",
      "fs_seamless_break",
    );
    const borderPair = rt.getRenderPipelinePair(
      "filter-seamless-border",
      "fs_seamless_border",
    );

    if (!breakRepetition && !seamlessBorders) {
      rt.encodeRenderPass(
        encoder,
        rt.selectPipeline(borderPair, dstTex),
        dstTex,
        [
          { binding: 0, resource: srcTex.createView() },
          {
            binding: 2,
            resource: {
              buffer: rt.makeParamsBuf(new Uint32Array([w, h, 0, 0])),
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
          new Uint32Array([w, h, Math.max(1, borderRadius), 0]),
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
        new Uint32Array([w, h, Math.max(1, borderRadius), 0]),
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
