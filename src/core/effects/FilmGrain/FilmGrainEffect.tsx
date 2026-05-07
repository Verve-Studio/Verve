import type { FilmGrainAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { getFilterRuntime } from "@/graphicspipeline/webgpu/compute/filterCompute";
import { FilmGrainPanel } from "./FilmGrainPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type FilmGrainOp = Extract<AdjustmentRenderOp, { kind: "film-grain" }>;

export const FilmGrainEffect: IPipelineEffect<
  FilmGrainAdjustmentLayer,
  FilmGrainOp
> = {
  id: "film-grain",
  label: "Film Grain…",
  menu: { root: "filters", submenu: "noise" },
  defaultParams: { grainSize: 1, intensity: 25, roughness: 50, seed: 0 },

  buildPlanEntry(layer, { mask }) {
    const { grainSize, intensity, roughness, seed } = layer.params;
    return {
      kind: "film-grain",
      layerId: layer.id,
      grainSize,
      intensity,
      roughness,
      seed,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ encoder, srcTex, dstTex }, entry) {
    const rt = getFilterRuntime();
    const w = dstTex.width;
    const h = dstTex.height;
    const { grainSize, intensity, roughness, seed } = entry;
    const blurRadius =
      grainSize > 1 ? Math.min(5, Math.floor(grainSize / 10)) : 0;

    const noisePipeline = rt.getPipelineSingle(
      "filter-film-grain-noise",
      "fs_film_grain_noise",
      "rgba8unorm",
    );
    const boxH = rt.getPipelinePair("filter-box-h", "fs_box_h");
    const boxV = rt.getPipelinePair("filter-box-v", "fs_box_v");
    const combine = rt.getPipelinePair(
      "filter-film-grain-combine",
      "fs_film_grain_combine",
    );

    const noiseTexA = rt.makeRgba8Tex(w, h);
    const noiseParamsBuf = rt.makeParamsBuf(new Uint32Array([seed, w, 0, 0]));
    rt.encodeRenderPass(
      encoder,
      noisePipeline,
      [{ binding: 0, resource: { buffer: noiseParamsBuf } }],
      noiseTexA,
    );
    let finalNoiseTex = noiseTexA;
    if (blurRadius > 0) {
      const noiseTexB = rt.makeRgba8Tex(w, h);
      const blurParamsBuf = rt.makeParamsBuf(
        new Uint32Array([blurRadius, 0, 0, 0]),
      );
      rt.encodeRenderPass(
        encoder,
        rt.selectPipeline(boxH, rt.intermediate),
        [
          { binding: 0, resource: noiseTexA.createView() },
          { binding: 2, resource: { buffer: blurParamsBuf } },
        ],
        rt.intermediate,
      );
      rt.encodeRenderPass(
        encoder,
        boxV.s8,
        [
          { binding: 0, resource: rt.intermediate.createView() },
          { binding: 2, resource: { buffer: blurParamsBuf } },
        ],
        noiseTexB,
      );
      finalNoiseTex = noiseTexB;
    }
    const combineParamsBuf = rt.makeParamsBuf(
      new Uint32Array([intensity, roughness, 0, 0]),
    );
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(combine, dstTex),
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 2, resource: finalNoiseTex.createView() },
        { binding: 3, resource: { buffer: combineParamsBuf } },
      ],
      dstTex,
    );
  },

  Panel: FilmGrainPanel,
};
