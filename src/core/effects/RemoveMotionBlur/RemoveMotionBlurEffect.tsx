import type { RemoveMotionBlurAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { getFilterRuntime } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { RemoveMotionBlurPanel } from "./RemoveMotionBlurPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type RemoveMotionBlurOp = Extract<
  AdjustmentRenderOp,
  { kind: "remove-motion-blur" }
>;

export const RemoveMotionBlurEffect: IPipelineEffect<
  RemoveMotionBlurAdjustmentLayer,
  RemoveMotionBlurOp
> = {
  id: "remove-motion-blur",
  label: "Remove Motion Blur…",
  menu: { root: "filters", submenu: "blur" },
  defaultParams: { angle: 0, distance: 10, noiseReduction: 10 },

  buildPlanEntry(layer, { mask }) {
    const { angle, distance, noiseReduction } = layer.params;
    return {
      kind: "remove-motion-blur",
      layerId: layer.id,
      angle,
      distance,
      noiseReduction,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex }, entry) {
    const rt = getFilterRuntime();
    const w = dstTex.width;
    const h = dstTex.height;
    const psfPipeline = rt.getPipelineSingle(
      "filter-rmb-psf",
      "fs_rmb_psf",
      "rgba16float",
    );
    const ratioPipeline = rt.getPipelineSingle(
      "filter-rmb-ratio",
      "fs_rmb_ratio",
      "rgba16float",
    );
    const updatePipeline = rt.getPipelineSingle(
      "filter-rmb-update",
      "fs_rmb_update",
      "rgba16float",
    );
    const finalPair = rt.getPipelinePair("filter-rmb-final", "fs_rmb_final");

    const iterations = 8 + Math.round((100 - entry.noiseReduction) / 14);
    const blendBack = (entry.noiseReduction / 100) * 0.35;

    const buf = new ArrayBuffer(16);
    const dv = new DataView(buf);
    dv.setFloat32(0, entry.angle, true);
    dv.setUint32(4, entry.distance, true);
    dv.setUint32(8, 0, true);
    dv.setUint32(12, 0, true);
    const psfParamsBuf = rt.makeParamsBuf(buf);

    const finalBuf = new ArrayBuffer(16);
    const fdv = new DataView(finalBuf);
    fdv.setFloat32(0, blendBack, true);
    const finalParamsBuf = rt.makeParamsBuf(finalBuf);

    const estA = rt.makeRgba16FloatTex(w, h);
    const estB = rt.makeRgba16FloatTex(w, h);
    const temp = rt.makeRgba16FloatTex(w, h);
    const ratio = rt.makeRgba16FloatTex(w, h);

    let curEst: GPUTexture = srcTex;

    for (let i = 0; i < iterations; i++) {
      const nextEst = i % 2 === 0 ? estA : estB;

      rt.encodeRenderPass(
        encoder,
        psfPipeline,
        [
          { binding: 0, resource: curEst.createView() },
          { binding: 1, resource: { buffer: psfParamsBuf } },
        ],
        temp,
      );

      rt.encodeRenderPass(
        encoder,
        ratioPipeline,
        [
          { binding: 0, resource: srcTex.createView() },
          { binding: 1, resource: temp.createView() },
        ],
        ratio,
      );

      rt.encodeRenderPass(
        encoder,
        psfPipeline,
        [
          { binding: 0, resource: ratio.createView() },
          { binding: 1, resource: { buffer: psfParamsBuf } },
        ],
        temp,
      );

      rt.encodeRenderPass(
        encoder,
        updatePipeline,
        [
          { binding: 0, resource: curEst.createView() },
          { binding: 1, resource: temp.createView() },
        ],
        nextEst,
      );

      curEst = nextEst;
    }

    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(finalPair, dstTex),
      [
        { binding: 0, resource: curEst.createView() },
        { binding: 1, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: finalParamsBuf } },
      ],
      dstTex,
    );
  },

  Panel: RemoveMotionBlurPanel,
};
