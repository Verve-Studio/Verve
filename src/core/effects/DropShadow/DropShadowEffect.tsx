import type { EffectLayerOf, RGBAColor } from "@/types";
import { colorForTarget } from "@/core/effects/_shared/effectColor";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { DropShadowOptions } from "./DropShadowOptions";
import type { IPipelineEffect } from "../IPipelineEffect";
import { createTrackedTexture } from "@/core/store/memoryStore";
import type { EffectRuntime } from "@/graphics/webgpu/EffectRuntime";
import { TextureSetCache } from "../_shared/textureSetCache";

const DropShadowIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    <rect x="1.5" y="1.5" width="7" height="7" rx="0.5" />
    <rect
      x="3.5"
      y="3.5"
      width="7"
      height="7"
      rx="0.5"
      fill="currentColor"
      fillOpacity="0.25"
      strokeOpacity="0.4"
    />
  </svg>
);

export interface DropShadowParams {
  /** Shadow color including alpha channel. r/g/b/a are 0–255. Default: { r:0, g:0, b:0, a:255 } */
  color: RGBAColor;
  /** Overall shadow opacity, 0–100 (%). Applied on top of color.a. Default: 75 */
  opacity: number;
  /** Horizontal offset in canvas pixels, −200 to +200. Default: 5 */
  offsetX: number;
  /** Vertical offset in canvas pixels, −200 to +200. Default: 5 */
  offsetY: number;
  /** Morphological dilation radius in pixels, 0–100. Default: 0 */
  spread: number;
  /** Gaussian blur radius in pixels, 0–100. Default: 10 */
  softness: number;
  /** How the shadow composites with layers beneath it. Default: 'multiply' */
  blendMode: "normal" | "multiply" | "screen";
  /** When true, the shadow is masked by the inverse of the source alpha. Default: true */
  knockout: boolean;
}

export type DropShadowEffectLayer = EffectLayerOf<
  "drop-shadow",
  DropShadowParams
>;

type DropShadowOp = Extract<EffectRenderOp, { kind: "drop-shadow" }>;

const texCache = new TextureSetCache<{
  tempA: GPUTexture;
  tempB: GPUTexture;
}>();

/** Scratch textures for the dilate+blur ping-pong. Allocated in the same
 *  format as the doc-output texture so the entire pipeline runs at full
 *  precision on f32 documents — no 8-bit precision loss in shadow falloff
 *  on HDR content. Re-allocated when the doc switches color modes. */
function ensureTextures(
  runtime: EffectRuntime,
  width: number,
  height: number,
  format: GPUTextureFormat,
): { tempA: GPUTexture; tempB: GPUTexture } {
  const usage =
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.STORAGE_BINDING |
    GPUTextureUsage.COPY_DST |
    GPUTextureUsage.COPY_SRC;
  const make = (): GPUTexture =>
    createTrackedTexture(runtime.device, {
      size: { width, height },
      format,
      usage,
    });
  return texCache.get(runtime, `${width}x${height}:${format}`, () => ({
    tempA: make(),
    tempB: make(),
  }));
}

const BLEND_MODE_MAP: Record<"normal" | "multiply" | "screen", number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
};

/**
 * Shared drop-shadow encode logic. Used by both DropShadow and Glow effects
 * (Glow is drop-shadow with offsetX/offsetY = 0).
 */
export function encodeDropShadowPass(
  runtime: EffectRuntime,
  encoder: GPUCommandEncoder,
  srcTex: GPUTexture,
  dstTex: GPUTexture,
  args: {
    colorR: number;
    colorG: number;
    colorB: number;
    colorA: number;
    opacity: number;
    offsetX: number;
    offsetY: number;
    spread: number;
    softness: number;
    blendMode: "normal" | "multiply" | "screen";
    knockout: boolean;
    selMaskLayer: { texture: GPUTexture } | undefined;
  },
): void {
  const { device, pixelWidth: w, pixelHeight: h } = runtime;
  // Scratch + every compute pipeline runs in the doc format. The shaders'
  // `texture_storage_2d<rgba8unorm, …>` declarations get rewritten to the
  // doc format on first compile (see `getComputePipelineForStorageFormat`).
  const { tempA, tempB } = ensureTextures(runtime, w, h, dstTex.format);
  const dilateH = runtime.getComputePipelineForStorageFormat(
    "drop-shadow-dilate-h",
    "cs_shadow_dilate_h",
    dstTex,
  );
  const dilateV = runtime.getComputePipelineForStorageFormat(
    "drop-shadow-dilate-v",
    "cs_shadow_dilate_v",
    dstTex,
  );
  const blurH = runtime.getComputePipelineForStorageFormat(
    "drop-shadow-blur-h",
    "cs_shadow_blur_h",
    dstTex,
  );
  const blurV = runtime.getComputePipelineForStorageFormat(
    "drop-shadow-blur-v",
    "cs_shadow_blur_v",
    dstTex,
  );
  const composite = runtime.getComputePipelineForStorageFormat(
    "drop-shadow-composite",
    "cs_shadow_composite",
    dstTex,
  );

  const spreadR = Math.round(args.spread);
  const blurR =
    args.softness > 0 ? Math.max(1, Math.round(args.softness * 0.577)) : 0;

  const groups = [Math.ceil(w / 8), Math.ceil(h / 8)] as const;
  const pass = (
    pipeline: GPUComputePipeline,
    src: GPUTexture,
    dst: GPUTexture,
    paramsBuf: GPUBuffer,
  ): void => {
    const bg = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: dst.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
      ],
    });
    const p = encoder.beginComputePass();
    p.setPipeline(pipeline);
    p.setBindGroup(0, bg);
    p.dispatchWorkgroups(groups[0], groups[1]);
    p.end();
  };

  // Mask (in .r): the layer alpha, dilated by `spread`, then blurred.
  let maskTex: GPUTexture;
  // The first blur pass reads the layer alpha directly when there is no
  // spread, so the two dilate passes are skipped.
  let blurFromAlpha = false;
  if (spreadR > 0) {
    const dilateParamsBuf = runtime.makeParamsBuf(
      new Uint32Array([spreadR, 0, 0, 0]),
    );
    pass(dilateH, srcTex, tempA, dilateParamsBuf);
    pass(dilateV, tempA, tempB, dilateParamsBuf);
    maskTex = tempB;
  } else if (args.softness > 0) {
    maskTex = srcTex;
    blurFromAlpha = true;
  } else {
    // No spread, no blur: a radius-0 dilate just copies alpha into .r.
    pass(
      dilateH,
      srcTex,
      tempA,
      runtime.makeParamsBuf(new Uint32Array([0, 0, 0, 0])),
    );
    maskTex = tempA;
  }

  // Optional blur passes (3 × box H+V ≈ gaussian), ping-ponging between
  // the two scratch textures.
  if (args.softness > 0) {
    const blurParamsBuf = runtime.makeParamsBuf(
      new Uint32Array([blurR, 0, 0, 0]),
    );
    const firstHParamsBuf = blurFromAlpha
      ? runtime.makeParamsBuf(new Uint32Array([blurR, 1, 0, 0]))
      : blurParamsBuf;
    let workingSrc = maskTex;
    for (let i = 0; i < 3; i++) {
      const hDst = workingSrc === tempA ? tempB : tempA;
      pass(blurH, workingSrc, hDst, i === 0 ? firstHParamsBuf : blurParamsBuf);
      const vDst = hDst === tempA ? tempB : tempA;
      pass(blurV, hDst, vDst, blurParamsBuf);
      workingSrc = vDst;
    }
    maskTex = workingSrc;
  }

  // Composite pass
  const compBuf = new ArrayBuffer(48);
  const cf = new Float32Array(compBuf);
  const ci = new Int32Array(compBuf);
  const cu = new Uint32Array(compBuf);
  cf[0] = args.colorR;
  cf[1] = args.colorG;
  cf[2] = args.colorB;
  cf[3] = args.colorA;
  cf[4] = args.opacity;
  ci[5] = args.offsetX;
  ci[6] = args.offsetY;
  cu[7] = BLEND_MODE_MAP[args.blendMode];
  cu[8] = args.knockout ? 1 : 0;

  const compParamsBuf = runtime.makeParamsBuf(compBuf);
  const maskFlagsBuf = runtime.makeMaskFlagsBuf(
    !!args.selMaskLayer,
    dstTex.format === "rgba16float" || dstTex.format === "rgba32float",
  );
  const dummyMask = args.selMaskLayer?.texture ?? srcTex;

  const compBG = device.createBindGroup({
    layout: composite.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: maskTex.createView() },
      { binding: 2, resource: dstTex.createView() },
      { binding: 3, resource: { buffer: compParamsBuf } },
      { binding: 4, resource: dummyMask.createView() },
      { binding: 5, resource: { buffer: maskFlagsBuf } },
    ],
  });
  const compPass = encoder.beginComputePass();
  compPass.setPipeline(composite);
  compPass.setBindGroup(0, compBG);
  compPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
  compPass.end();
}

/** Hooks for sharing the texture cache lifetime across DropShadow + Glow. */
export const dropShadowCache = {
  onFrameEnd(): void {
    texCache.onFrameEnd();
  },
  onDestroy(): void {
    texCache.destroyAll();
  },
};

export const DropShadowEffect: IPipelineEffect<
  DropShadowEffectLayer,
  DropShadowOp
> = {
  id: "drop-shadow",
  label: "Drop Shadow…",
  menu: { root: "effects", submenu: "fx-shadow" },
  defaultParams: {
    color: { r: 0, g: 0, b: 0, a: 255 },
    opacity: 75,
    offsetX: 5,
    offsetY: 5,
    spread: 0,
    softness: 10,
    blendMode: "multiply",
    knockout: true,
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "drop-shadow",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
    };
  },

  encode({ engine, encoder, srcTex, dstTex }, entry) {
    const {
      color,
      opacity,
      offsetX,
      offsetY,
      spread,
      softness,
      blendMode,
      knockout,
    } = entry.params;
    const col = colorForTarget(color, dstTex.format);
    encodeDropShadowPass(engine.runtime, encoder, srcTex, dstTex, {
      colorR: col.r,
      colorG: col.g,
      colorB: col.b,
      colorA: col.a,
      opacity: opacity / 100,
      offsetX,
      offsetY,
      spread,
      softness,
      blendMode,
      knockout,
      selMaskLayer: entry.selMaskLayer,
    });
  },

  onFrameEnd: dropShadowCache.onFrameEnd,
  onDestroy: dropShadowCache.onDestroy,

  Panel: DropShadowOptions,
  icon: DropShadowIcon,
};
