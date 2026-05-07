import type { SeamlessTextureAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { SeamlessTexturePanel } from "./SeamlessTexturePanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type SeamlessTextureOp = Extract<
  AdjustmentRenderOp,
  { kind: "seamless-texture" }
>;

export const SeamlessTextureEffect: IPipelineEffect<
  SeamlessTextureAdjustmentLayer,
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
    const {
      breakRepetition,
      cellSize,
      blendRadius,
      seamlessBorders,
      borderRadius,
      seed,
    } = layer.params;
    return {
      kind: "seamless-texture",
      layerId: layer.id,
      breakRepetition,
      cellSize,
      blendRadius,
      seamlessBorders,
      borderRadius,
      seed,
      visible: layer.visible,
      selMaskLayer: mask,
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
    } = entry;
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
