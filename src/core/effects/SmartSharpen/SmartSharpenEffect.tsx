import type { SmartSharpenEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { SmartSharpenPanel } from "./SmartSharpenPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type SmartSharpenOp = Extract<EffectRenderOp, { kind: "smart-sharpen" }>;

export const SmartSharpenEffect: IPipelineEffect<
  SmartSharpenEffectLayer,
  SmartSharpenOp
> = {
  id: "smart-sharpen",
  label: "Smart Sharpen…",
  menu: { root: "filters", submenu: "sharpen" },
  defaultParams: {
    amount: 100,
    radius: 3,
    reduceNoise: 0,
    remove: "gaussian",
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "smart-sharpen",
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
    const { amount, radius, reduceNoise } = entry.params;
    const remove = entry.params.remove === "gaussian" ? 0 : 1;

    const gaussH = rt.getRenderPipelinePair("filter-gaussian-h", "fs_gaussian_h");
    const gaussV = rt.getRenderPipelinePair("filter-gaussian-v", "fs_gaussian_v");
    const boxH = rt.getRenderPipelinePair("filter-box-h", "fs_box_h");
    const boxV = rt.getRenderPipelinePair("filter-box-v", "fs_box_v");
    const gaussCombine = rt.getRenderPipelinePair(
      "filter-smart-sharpen-gauss-combine",
      "fs_smart_sharpen_gauss",
    );
    const lensPipe = rt.getRenderPipelinePair(
      "filter-smart-sharpen-lens",
      "fs_smart_sharpen_lens",
    );
    const blendPipe = rt.getRenderPipelinePair(
      "filter-smart-sharpen-blend",
      "fs_smart_sharpen_blend",
    );

    if (remove === 0) {
      const gaussParamsBuf = rt.makeParamsBuf(
        new Uint32Array([radius, 0, 0, 0]),
      );
      const blurredTex = rt.makeRgba8Tex(w, h);
      rt.encodeRenderPass(
        encoder,
        rt.selectPipeline(gaussH, rt.intermediate),
        rt.intermediate,
        [
          { binding: 0, resource: srcTex.createView() },
          { binding: 2, resource: { buffer: gaussParamsBuf } },
        ],
      );
      rt.encodeRenderPass(
        encoder,
        gaussV.s8,
        blurredTex,
        [
          { binding: 0, resource: rt.intermediate.createView() },
          { binding: 2, resource: { buffer: gaussParamsBuf } },
        ],
      );
      if (reduceNoise > 0) {
        const sharpenedTex = rt.makeRgba8Tex(w, h);
        const combineParamsBuf = rt.makeParamsBuf(
          new Uint32Array([amount, 0, 0, 0]),
        );
        rt.encodeRenderPass(
          encoder,
          gaussCombine.s8,
          sharpenedTex,
          [
            { binding: 0, resource: srcTex.createView() },
            { binding: 2, resource: blurredTex.createView() },
            { binding: 3, resource: { buffer: combineParamsBuf } },
          ],
        );
        const boxParamsBuf = rt.makeParamsBuf(new Uint32Array([1, 0, 0, 0]));
        const smoothedTex = rt.makeRgba8Tex(w, h);
        rt.encodeRenderPass(
          encoder,
          rt.selectPipeline(boxH, rt.intermediate),
          rt.intermediate,
          [
            { binding: 0, resource: sharpenedTex.createView() },
            { binding: 2, resource: { buffer: boxParamsBuf } },
          ],
        );
        rt.encodeRenderPass(
          encoder,
          boxV.s8,
          smoothedTex,
          [
            { binding: 0, resource: rt.intermediate.createView() },
            { binding: 2, resource: { buffer: boxParamsBuf } },
          ],
        );
        const blendParamsBuf = rt.makeParamsBuf(
          new Uint32Array([reduceNoise, 0, 0, 0]),
        );
        rt.encodeRenderPass(
          encoder,
          rt.selectPipeline(blendPipe, dstTex),
          dstTex,
          [
            { binding: 0, resource: sharpenedTex.createView() },
            { binding: 2, resource: smoothedTex.createView() },
            { binding: 3, resource: { buffer: blendParamsBuf } },
          ],
        );
      } else {
        const combineParamsBuf = rt.makeParamsBuf(
          new Uint32Array([amount, 0, 0, 0]),
        );
        rt.encodeRenderPass(
          encoder,
          rt.selectPipeline(gaussCombine, dstTex),
          dstTex,
          [
            { binding: 0, resource: srcTex.createView() },
            { binding: 2, resource: blurredTex.createView() },
            { binding: 3, resource: { buffer: combineParamsBuf } },
          ],
        );
      }
    } else {
      if (reduceNoise > 0) {
        const sharpenedTex = rt.makeRgba8Tex(w, h);
        const lensParamsBuf = rt.makeParamsBuf(
          new Uint32Array([amount, 0, 0, 0]),
        );
        rt.encodeRenderPass(
          encoder,
          lensPipe.s8,
          sharpenedTex,
          [
            { binding: 0, resource: srcTex.createView() },
            { binding: 2, resource: { buffer: lensParamsBuf } },
          ],
        );
        const boxParamsBuf = rt.makeParamsBuf(new Uint32Array([1, 0, 0, 0]));
        const smoothedTex = rt.makeRgba8Tex(w, h);
        rt.encodeRenderPass(
          encoder,
          rt.selectPipeline(boxH, rt.intermediate),
          rt.intermediate,
          [
            { binding: 0, resource: sharpenedTex.createView() },
            { binding: 2, resource: { buffer: boxParamsBuf } },
          ],
        );
        rt.encodeRenderPass(
          encoder,
          boxV.s8,
          smoothedTex,
          [
            { binding: 0, resource: rt.intermediate.createView() },
            { binding: 2, resource: { buffer: boxParamsBuf } },
          ],
        );
        const blendParamsBuf = rt.makeParamsBuf(
          new Uint32Array([reduceNoise, 0, 0, 0]),
        );
        rt.encodeRenderPass(
          encoder,
          rt.selectPipeline(blendPipe, dstTex),
          dstTex,
          [
            { binding: 0, resource: sharpenedTex.createView() },
            { binding: 2, resource: smoothedTex.createView() },
            { binding: 3, resource: { buffer: blendParamsBuf } },
          ],
        );
      } else {
        const lensParamsBuf = rt.makeParamsBuf(
          new Uint32Array([amount, 0, 0, 0]),
        );
        rt.encodeRenderPass(
          encoder,
          rt.selectPipeline(lensPipe, dstTex),
          dstTex,
          [
            { binding: 0, resource: srcTex.createView() },
            { binding: 2, resource: { buffer: lensParamsBuf } },
          ],
        );
      }
    }
  },

  Panel: SmartSharpenPanel,
};
