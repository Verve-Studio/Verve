import type { RemoveMotionBlurEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { RemoveMotionBlurPanel } from "./RemoveMotionBlurPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type RemoveMotionBlurOp = Extract<
  EffectRenderOp,
  { kind: "remove-motion-blur" }
>;

export const RemoveMotionBlurEffect: IPipelineEffect<
  RemoveMotionBlurEffectLayer,
  RemoveMotionBlurOp
> = {
  id: "remove-motion-blur",
  label: "Remove Motion Blur…",
  menu: { root: "filters", submenu: "blur" },
  defaultParams: { angle: 0, distance: 10, noiseReduction: 10 },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "remove-motion-blur",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ encoder, srcTex, dstTex, engine }, entry) {
    const rt = engine.runtime;
    const { angle, distance, noiseReduction } = entry.params;
    const w = dstTex.width;
    const h = dstTex.height;
    const psfPipeline = rt.getRenderPipelineSingle(
      "filter-rmb-psf",
      "fs_rmb_psf",
      "rgba16float",
    );
    const ratioPipeline = rt.getRenderPipelineSingle(
      "filter-rmb-ratio",
      "fs_rmb_ratio",
      "rgba16float",
    );
    const updatePipeline = rt.getRenderPipelineSingle(
      "filter-rmb-update",
      "fs_rmb_update",
      "rgba16float",
    );
    const finalPair = rt.getRenderPipelinePair("filter-rmb-final", "fs_rmb_final");

    const iterations = 8 + Math.round((100 - noiseReduction) / 14);
    const blendBack = (noiseReduction / 100) * 0.35;

    const buf = new ArrayBuffer(16);
    const dv = new DataView(buf);
    dv.setFloat32(0, angle, true);
    dv.setUint32(4, distance, true);
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
        temp,
        [
          { binding: 0, resource: curEst.createView() },
          { binding: 1, resource: { buffer: psfParamsBuf } },
        ],
      );

      rt.encodeRenderPass(
        encoder,
        ratioPipeline,
        ratio,
        [
          { binding: 0, resource: srcTex.createView() },
          { binding: 1, resource: temp.createView() },
        ],
      );

      rt.encodeRenderPass(
        encoder,
        psfPipeline,
        temp,
        [
          { binding: 0, resource: ratio.createView() },
          { binding: 1, resource: { buffer: psfParamsBuf } },
        ],
      );

      rt.encodeRenderPass(
        encoder,
        updatePipeline,
        nextEst,
        [
          { binding: 0, resource: curEst.createView() },
          { binding: 1, resource: temp.createView() },
        ],
      );

      curEst = nextEst;
    }

    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(finalPair, dstTex),
      dstTex,
      [
        { binding: 0, resource: curEst.createView() },
        { binding: 1, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: finalParamsBuf } },
      ],
    );
  },

  Panel: RemoveMotionBlurPanel,
};
