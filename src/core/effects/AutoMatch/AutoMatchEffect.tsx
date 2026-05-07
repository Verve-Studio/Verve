import type { AutoMatchEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { AutoMatchPanel } from "./AutoMatchPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

type AutoMatchOp = Extract<EffectRenderOp, { kind: "auto-match" }>;

export const AutoMatchEffect: IPipelineEffect<
  AutoMatchEffectLayer,
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
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
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
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const p = entry.params;
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
    f[16] = p.strength / 100;
    f[17] = p.brightness / 100;
    f[18] = p.contrast / 100;
    f[19] = p.gamma / 100;
    f[20] = p.color / 100;
    f[21] = p.saturation / 100;
    u[24] = p.clampHighlights ? 1 : 0;
    u[25] = p.clampShadows ? 1 : 0;
    f[28] = entry.layerChromaMag;
    f[29] = entry.contextChromaMag;
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair("auto-match", "fs_auto_match", STD_BINDINGS),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: AutoMatchPanel,
};
