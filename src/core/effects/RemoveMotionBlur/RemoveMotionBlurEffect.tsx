import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { RemoveMotionBlurPanel } from "./RemoveMotionBlurPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { TextureSetCache } from "../_shared/textureSetCache";
import { createTrackedTexture } from "@/core/store/memoryStore";

/** Max PSF samples per pass; longer PSFs are sampled with a stride. */
const MAX_PSF_TAPS = 32;

/** Four full-resolution rgba16float intermediates, reused across frames
 *  instead of allocated (~512 MB at 16 MP) on every encode. */
const texCache = new TextureSetCache<{
  estA: GPUTexture;
  estB: GPUTexture;
  temp: GPUTexture;
  ratio: GPUTexture;
}>();


export interface RemoveMotionBlurParams {
    angle: number;
    distance: number;
    noiseReduction: number;
}

export type RemoveMotionBlurEffectLayer = EffectLayerOf<"remove-motion-blur", RemoveMotionBlurParams>;

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
    dv.setUint32(8, Math.max(1, Math.min(distance, MAX_PSF_TAPS)), true);
    dv.setUint32(12, 0, true);
    const psfParamsBuf = rt.makeParamsBuf(buf);

    const finalBuf = new ArrayBuffer(16);
    const fdv = new DataView(finalBuf);
    fdv.setFloat32(0, blendBack, true);
    const finalParamsBuf = rt.makeParamsBuf(finalBuf);

    const { estA, estB, temp, ratio } = texCache.get(rt, `${w}x${h}`, () => {
      const make = (): GPUTexture =>
        createTrackedTexture(rt.device, {
          size: { width: w, height: h },
          format: "rgba16float",
          usage:
            GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
      return { estA: make(), estB: make(), temp: make(), ratio: make() };
    });

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

  onFrameEnd() {
    texCache.onFrameEnd();
  },

  onDestroy() {
    texCache.destroyAll();
  },

  Panel: RemoveMotionBlurPanel,
};
