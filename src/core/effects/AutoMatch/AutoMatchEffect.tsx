import type { AutoMatchAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { AutoMatchPanel } from "./AutoMatchPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type AutoMatchOp = Extract<AdjustmentRenderOp, { kind: "auto-match" }>;

export const AutoMatchEffect: IPipelineEffect<
  AutoMatchAdjustmentLayer,
  AutoMatchOp
> = {
  id: "auto-match",
  label: "Auto Match…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: {
    samplingDistance: 100,
    strength: 100,
    brightness: 0,
    contrast: 100,
    gamma: 100,
    color: 100,
    saturation: 100,
    clampHighlights: true,
    clampShadows: true,
    cachedStats: null,
    statsVersion: 0,
  },

  buildPlanEntry(layer, { mask }) {
    const p = layer.params;
    const stats = p.cachedStats;
    const lz = stats?.layer;
    const cz = stats?.context;
    return {
      kind: "auto-match",
      layerId: layer.id,
      strength: p.strength / 100,
      brightness: p.brightness / 100,
      contrast: p.contrast / 100,
      gamma: p.gamma / 100,
      color: p.color / 100,
      saturation: p.saturation / 100,
      clampHighlights: p.clampHighlights,
      clampShadows: p.clampShadows,
      layerMeanL: lz?.meanL ?? 0,
      layerStdL: lz?.stdL ?? 0,
      layerMinL: lz?.minL ?? 0,
      layerMaxL: lz?.maxL ?? 1,
      layerMeanR: lz?.meanR ?? 0,
      layerMeanG: lz?.meanG ?? 0,
      layerMeanB: lz?.meanB ?? 0,
      layerChromaMag: lz?.chromaMag ?? 0,
      layerCount: lz?.count ?? 0,
      contextMeanL: cz?.meanL ?? 0,
      contextStdL: cz?.stdL ?? 0,
      contextMinL: cz?.minL ?? 0,
      contextMaxL: cz?.maxL ?? 1,
      contextMeanR: cz?.meanR ?? 0,
      contextMeanG: cz?.meanG ?? 0,
      contextMeanB: cz?.meanB ?? 0,
      contextChromaMag: cz?.chromaMag ?? 0,
      contextCount: cz?.count ?? 0,
      statsVersion: p.statsVersion,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    // AutoMatchParams: 8 × vec4 = 128 bytes
    const buf = new ArrayBuffer(128);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f[0] = entry.layerMeanL;
    f[1] = entry.layerStdL;
    f[2] = entry.layerMinL;
    f[3] = entry.layerMaxL;
    f[4] = entry.layerMeanR;
    f[5] = entry.layerMeanG;
    f[6] = entry.layerMeanB;
    f[7] = entry.layerCount > 0 ? 1 : 0;
    f[8] = entry.contextMeanL;
    f[9] = entry.contextStdL;
    f[10] = entry.contextMinL;
    f[11] = entry.contextMaxL;
    f[12] = entry.contextMeanR;
    f[13] = entry.contextMeanG;
    f[14] = entry.contextMeanB;
    f[15] = entry.contextCount > 0 ? 1 : 0;
    f[16] = entry.strength;
    f[17] = entry.brightness;
    f[18] = entry.contrast;
    f[19] = entry.gamma;
    f[20] = entry.color;
    f[21] = entry.saturation;
    u[24] = entry.clampHighlights ? 1 : 0;
    u[25] = entry.clampShadows ? 1 : 0;
    f[28] = entry.layerChromaMag;
    f[29] = entry.contextChromaMag;
    engine.encodeStdAdjRenderPass(
      encoder,
      engine.autoMatchPipeline,
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: AutoMatchPanel,
};
