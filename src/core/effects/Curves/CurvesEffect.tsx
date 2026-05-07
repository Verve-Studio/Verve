import type { CurvesAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import {
  buildCurvesLuts,
  createDefaultCurvesParams,
  type CurvesLuts,
} from "@/core/operations/adjustments/curves";
import { CurvesPanel } from "./CurvesPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import type { AdjBinding } from "@/graphicspipeline/webgpu/EffectRuntime";
import {
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";
import { uploadR8TextureData } from "@/graphicspipeline/webgpu/utils";

type CurvesOp = Extract<AdjustmentRenderOp, { kind: "curves" }>;

const CURVES_BINDINGS: AdjBinding[] = [
  "tex",
  "sampler",
  "tex",
  "uniform",
  "sampler-f",
  "tex-f",
  "tex-f",
  "tex-f",
  "tex-f",
];

type CurvesLutTextures = {
  rgb: GPUTexture;
  red: GPUTexture;
  green: GPUTexture;
  blue: GPUTexture;
};

// Module-level state — per-layer-id LUT cache. Mirrors the previous
// AdjustmentEncoder fields. Keyed by layerId so multiple curves layers
// coexist without trampling each other.
const lutTextures = new Map<string, CurvesLutTextures>();
const lutSignatures = new Map<string, string>();
const usedThisFrame = new Set<string>();

function ensureLutTextures(
  device: GPUDevice,
  layerId: string,
  luts: CurvesLuts,
): CurvesLutTextures {
  usedThisFrame.add(layerId);
  const signature = `${Array.from(luts.rgb).join(".")}-${Array.from(luts.red).join(".")}-${Array.from(luts.green).join(".")}-${Array.from(luts.blue).join(".")}`;
  const existing = lutTextures.get(layerId);
  const prevSig = lutSignatures.get(layerId);
  if (existing && prevSig === signature) return existing;

  const writeLut = (data: Uint8Array): GPUTexture => {
    const tex = createTrackedTexture(device, {
      size: { width: 256, height: 1 },
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    uploadR8TextureData(device, tex, 256, 1, data);
    return tex;
  };

  if (existing) {
    destroyTrackedTexture(existing.rgb);
    destroyTrackedTexture(existing.red);
    destroyTrackedTexture(existing.green);
    destroyTrackedTexture(existing.blue);
  }

  const next: CurvesLutTextures = {
    rgb: writeLut(luts.rgb),
    red: writeLut(luts.red),
    green: writeLut(luts.green),
    blue: writeLut(luts.blue),
  };
  lutTextures.set(layerId, next);
  lutSignatures.set(layerId, signature);
  return next;
}

export const CurvesEffect: IPipelineEffect<CurvesAdjustmentLayer, CurvesOp> = {
  id: "curves",
  label: "Curves…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: createDefaultCurvesParams(),

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "curves",
      layerId: layer.id,
      params: layer.params,
      luts: buildCurvesLuts(layer.params),
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const { runtime } = engine;
    const pair = runtime.getRenderPipelinePair(
      "curves",
      "fs_curves",
      CURVES_BINDINGS,
    );
    const pipeline = runtime.selectPipeline(pair, format);
    const textures = ensureLutTextures(runtime.device, entry.layerId, entry.luts);

    const maskFlagsBuf = runtime.makeMaskFlagsBuf(!!entry.selMaskLayer);
    const dummyMask = entry.selMaskLayer?.texture ?? srcTex;

    runtime.encodeRenderPass(encoder, pipeline, dstTex, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: runtime.adjSampler },
      { binding: 2, resource: dummyMask.createView() },
      { binding: 3, resource: { buffer: maskFlagsBuf } },
      { binding: 4, resource: runtime.lutSampler },
      { binding: 5, resource: textures.rgb.createView() },
      { binding: 6, resource: textures.red.createView() },
      { binding: 7, resource: textures.green.createView() },
      { binding: 8, resource: textures.blue.createView() },
    ], pair.bgl);
  },

  onFrameEnd() {
    for (const [layerId, luts] of lutTextures) {
      if (usedThisFrame.has(layerId)) continue;
      destroyTrackedTexture(luts.rgb);
      destroyTrackedTexture(luts.red);
      destroyTrackedTexture(luts.green);
      destroyTrackedTexture(luts.blue);
      lutTextures.delete(layerId);
      lutSignatures.delete(layerId);
    }
    usedThisFrame.clear();
  },

  onDestroy() {
    for (const luts of lutTextures.values()) {
      destroyTrackedTexture(luts.rgb);
      destroyTrackedTexture(luts.red);
      destroyTrackedTexture(luts.green);
      destroyTrackedTexture(luts.blue);
    }
    lutTextures.clear();
    lutSignatures.clear();
    usedThisFrame.clear();
  },

  Panel: CurvesPanel,
};
