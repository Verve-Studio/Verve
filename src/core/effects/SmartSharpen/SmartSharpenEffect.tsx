import type { SmartSharpenAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { getFilterRuntime } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { SmartSharpenPanel } from "./SmartSharpenPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type SmartSharpenOp = Extract<AdjustmentRenderOp, { kind: "smart-sharpen" }>;

export const SmartSharpenEffect: IPipelineEffect<
  SmartSharpenAdjustmentLayer,
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
    const { amount, radius, reduceNoise, remove } = layer.params;
    return {
      kind: "smart-sharpen",
      layerId: layer.id,
      amount,
      radius,
      reduceNoise,
      remove: remove === "gaussian" ? 0 : 1,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex }, entry) {
    const rt = getFilterRuntime();
    const w = dstTex.width;
    const h = dstTex.height;
    const { amount, radius, reduceNoise, remove } = entry;

    const gaussH = rt.getPipelinePair("filter-gaussian-h", "fs_gaussian_h");
    const gaussV = rt.getPipelinePair("filter-gaussian-v", "fs_gaussian_v");
    const boxH = rt.getPipelinePair("filter-box-h", "fs_box_h");
    const boxV = rt.getPipelinePair("filter-box-v", "fs_box_v");
    const gaussCombine = rt.getPipelinePair(
      "filter-smart-sharpen-gauss-combine",
      "fs_smart_sharpen_gauss",
    );
    const lensPipe = rt.getPipelinePair(
      "filter-smart-sharpen-lens",
      "fs_smart_sharpen_lens",
    );
    const blendPipe = rt.getPipelinePair(
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
        [
          { binding: 0, resource: srcTex.createView() },
          { binding: 2, resource: { buffer: gaussParamsBuf } },
        ],
        rt.intermediate,
      );
      rt.encodeRenderPass(
        encoder,
        gaussV.s8,
        [
          { binding: 0, resource: rt.intermediate.createView() },
          { binding: 2, resource: { buffer: gaussParamsBuf } },
        ],
        blurredTex,
      );
      if (reduceNoise > 0) {
        const sharpenedTex = rt.makeRgba8Tex(w, h);
        const combineParamsBuf = rt.makeParamsBuf(
          new Uint32Array([amount, 0, 0, 0]),
        );
        rt.encodeRenderPass(
          encoder,
          gaussCombine.s8,
          [
            { binding: 0, resource: srcTex.createView() },
            { binding: 2, resource: blurredTex.createView() },
            { binding: 3, resource: { buffer: combineParamsBuf } },
          ],
          sharpenedTex,
        );
        const boxParamsBuf = rt.makeParamsBuf(new Uint32Array([1, 0, 0, 0]));
        const smoothedTex = rt.makeRgba8Tex(w, h);
        rt.encodeRenderPass(
          encoder,
          rt.selectPipeline(boxH, rt.intermediate),
          [
            { binding: 0, resource: sharpenedTex.createView() },
            { binding: 2, resource: { buffer: boxParamsBuf } },
          ],
          rt.intermediate,
        );
        rt.encodeRenderPass(
          encoder,
          boxV.s8,
          [
            { binding: 0, resource: rt.intermediate.createView() },
            { binding: 2, resource: { buffer: boxParamsBuf } },
          ],
          smoothedTex,
        );
        const blendParamsBuf = rt.makeParamsBuf(
          new Uint32Array([reduceNoise, 0, 0, 0]),
        );
        rt.encodeRenderPass(
          encoder,
          rt.selectPipeline(blendPipe, dstTex),
          [
            { binding: 0, resource: sharpenedTex.createView() },
            { binding: 2, resource: smoothedTex.createView() },
            { binding: 3, resource: { buffer: blendParamsBuf } },
          ],
          dstTex,
        );
      } else {
        const combineParamsBuf = rt.makeParamsBuf(
          new Uint32Array([amount, 0, 0, 0]),
        );
        rt.encodeRenderPass(
          encoder,
          rt.selectPipeline(gaussCombine, dstTex),
          [
            { binding: 0, resource: srcTex.createView() },
            { binding: 2, resource: blurredTex.createView() },
            { binding: 3, resource: { buffer: combineParamsBuf } },
          ],
          dstTex,
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
          [
            { binding: 0, resource: srcTex.createView() },
            { binding: 2, resource: { buffer: lensParamsBuf } },
          ],
          sharpenedTex,
        );
        const boxParamsBuf = rt.makeParamsBuf(new Uint32Array([1, 0, 0, 0]));
        const smoothedTex = rt.makeRgba8Tex(w, h);
        rt.encodeRenderPass(
          encoder,
          rt.selectPipeline(boxH, rt.intermediate),
          [
            { binding: 0, resource: sharpenedTex.createView() },
            { binding: 2, resource: { buffer: boxParamsBuf } },
          ],
          rt.intermediate,
        );
        rt.encodeRenderPass(
          encoder,
          boxV.s8,
          [
            { binding: 0, resource: rt.intermediate.createView() },
            { binding: 2, resource: { buffer: boxParamsBuf } },
          ],
          smoothedTex,
        );
        const blendParamsBuf = rt.makeParamsBuf(
          new Uint32Array([reduceNoise, 0, 0, 0]),
        );
        rt.encodeRenderPass(
          encoder,
          rt.selectPipeline(blendPipe, dstTex),
          [
            { binding: 0, resource: sharpenedTex.createView() },
            { binding: 2, resource: smoothedTex.createView() },
            { binding: 3, resource: { buffer: blendParamsBuf } },
          ],
          dstTex,
        );
      } else {
        const lensParamsBuf = rt.makeParamsBuf(
          new Uint32Array([amount, 0, 0, 0]),
        );
        rt.encodeRenderPass(
          encoder,
          rt.selectPipeline(lensPipe, dstTex),
          [
            { binding: 0, resource: srcTex.createView() },
            { binding: 2, resource: { buffer: lensParamsBuf } },
          ],
          dstTex,
        );
      }
    }
  },

  Panel: SmartSharpenPanel,
};
