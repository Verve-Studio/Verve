import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { LutAdjustmentPanel } from "./LutAdjustmentPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import type { AdjBinding } from "@/graphics/webgpu/EffectRuntime";
import { ensureLutOnGpu, lutStore } from "@/core/lut";

const LutIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" />
    <path d="M1.5 4.5 L10.5 4.5" />
    <path d="M1.5 7.5 L10.5 7.5" />
    <path d="M4.5 1.5 L4.5 10.5" />
    <path d="M7.5 1.5 L7.5 10.5" />
  </svg>
);

export interface LutAdjustmentParams {
  /** id of the LUT in `lutStore`. Empty string → effect is a no-op. */
  lutId: string;
  /** Mix factor between source (0) and LUT-applied output (100). */
  intensity: number;
}

export type LutAdjustmentEffectLayer = EffectLayerOf<"lut", LutAdjustmentParams>;
type LutAdjustmentOp = Extract<EffectRenderOp, { kind: "lut" }>;

const LUT_BINDINGS: AdjBinding[] = [
  "tex", // 0 srcTex (unfilterable, accepts rgba32float)
  "sampler", // 1 srcSampler (non-filtering)
  "uniform", // 2 params
  "tex", // 3 selMask
  "uniform", // 4 maskFlags
  "tex-f", // 5 lutCube atlas (filterable rgba16float)
  "tex-f", // 6 lutShaper (filterable rgba16float)
  "sampler-f", // 7 lutSampler (filtering)
];

function spaceId(s: string): number {
  // 0 = sRGB-encoded, 1 = linear-light. Anything else falls into "linear-
  // light" — built-ins (Rec2020, log encodings) carry their internal
  // space-handling inside the cube itself, so the wrapper conversion only
  // ever needs to bridge layer-storage ↔ generic linear/sRGB.
  return s === "srgb" ? 0 : 1;
}

export const LutAdjustmentEffect: IPipelineEffect<
  LutAdjustmentEffectLayer,
  LutAdjustmentOp
> = {
  id: "lut",
  label: "LUT…",
  menu: { root: "adjustments", submenu: "adj-style" },
  defaultParams: {
    lutId: "",
    intensity: 100,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "lut",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const lut = entry.params.lutId
      ? lutStore.get(entry.params.lutId)
      : undefined;
    if (!lut) {
      // No LUT selected — pass through. The adjustment pipeline ping-pongs
      // src/dst between ops, so we must populate dstTex even when this op
      // is a no-op; otherwise the next op reads stale contents. A direct
      // texture copy is cheaper than a render pass and needs no shader.
      encoder.copyTextureToTexture(
        { texture: srcTex },
        { texture: dstTex },
        {
          width: srcTex.width,
          height: srcTex.height,
          depthOrArrayLayers: 1,
        },
      );
      return;
    }

    const { runtime } = engine;
    const pair = runtime.getRenderPipelinePair(
      "lut-adjustment",
      "fs_lut",
      LUT_BINDINGS,
    );
    const pipeline = runtime.selectPipeline(pair, format);

    const bundle = ensureLutOnGpu(runtime.device, lut);

    // Uniform layout (32 bytes):
    //   0   cubeSize    : f32
    //   4   intensity   : f32 (0..1)
    //   8   sourceSpace : u32  (0 sRGB, 1 linear)
    //  12   lutInSpace  : u32
    //  16   lutOutSpace : u32
    //  20   hasShaper   : u32
    //  24   pad         : 8 bytes
    const buf = new ArrayBuffer(32);
    const f32 = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    f32[0] = bundle.cubeSize;
    f32[1] = entry.params.intensity / 100;
    u32[2] = format === "rgba32float" ? 1 : 0;
    u32[3] = spaceId(lut.inputSpace);
    u32[4] = spaceId(lut.outputSpace);
    u32[5] = bundle.hasShaper ? 1 : 0;

    const paramsBuf = runtime.makeParamsBuf(buf);
    const maskFlagsBuf = runtime.makeMaskFlagsBuf(!!entry.selMaskLayer);
    const dummyMask = entry.selMaskLayer?.texture ?? srcTex;

    runtime.encodeRenderPass(
      encoder,
      pipeline,
      dstTex,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: runtime.adjSampler },
        { binding: 2, resource: { buffer: paramsBuf } },
        { binding: 3, resource: dummyMask.createView() },
        { binding: 4, resource: { buffer: maskFlagsBuf } },
        { binding: 5, resource: bundle.cubeView },
        { binding: 6, resource: bundle.shaperView },
        { binding: 7, resource: runtime.lutSampler },
      ],
      pair.bgl,
    );
  },

  Panel: LutAdjustmentPanel,
  icon: LutIcon,
};
