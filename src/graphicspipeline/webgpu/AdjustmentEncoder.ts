import {
  createUniformBuffer,
  writeUniformBuffer,
  createStorageBuffer,
  uploadR8TextureData,
} from "./utils";
import {
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";
import {
  BC_COMPUTE,
  HS_COMPUTE,
  VIB_COMPUTE,
  CB_COMPUTE,
  BW_COMPUTE,
  TEMP_COMPUTE,
  INVERT_COMPUTE,
  SEL_COLOR_COMPUTE,
  CHANNEL_MIXER_COMPUTE,
  AUTO_MATCH_COMPUTE,
  CURVES_COMPUTE,
  CG_COMPUTE,
  RC_COMPUTE,
  DITHER_COMPUTE,
  BLOOM_EXTRACT_COMPUTE,
  BLOOM_DOWNSAMPLE_COMPUTE,
  BLOOM_BLUR_H_COMPUTE,
  BLOOM_BLUR_V_COMPUTE,
  BLOOM_COMPOSITE_COMPUTE,
  CHROMATIC_ABERRATION_COMPUTE,
  VIGNETTE_COMPUTE,
  HALATION_EXTRACT_COMPUTE,
  CK_COMPUTE,
  DROP_SHADOW_DILATE_H_COMPUTE,
  DROP_SHADOW_DILATE_V_COMPUTE,
  DROP_SHADOW_BLUR_H_COMPUTE,
  DROP_SHADOW_BLUR_V_COMPUTE,
  DROP_SHADOW_COMPOSITE_COMPUTE,
  OUTLINE_DILATE_H_COMPUTE,
  OUTLINE_DILATE_V_COMPUTE,
  OUTLINE_ERODE_H_COMPUTE,
  OUTLINE_ERODE_V_COMPUTE,
  OUTLINE_MASK_COMPUTE,
  OUTLINE_BLUR_H_COMPUTE,
  OUTLINE_BLUR_V_COMPUTE,
  OUTLINE_COMPOSITE_COMPUTE,
  HALFTONE_COMPUTE,
  BEVEL_COMPOSITE_COMPUTE,
  INNER_SHADOW_COMPOSITE_COMPUTE,
} from "./shaders/shaders";
import type {
  GpuLayer,
  AdjustmentRenderOp,
  SelectiveColorPassParams,
  ColorGradingPassParams,
  ChannelMixerPassParams,
} from "./types";
import type { CurvesLuts } from "@/core/operations/adjustments/curves";
import {
  encodeGaussianBlur,
  encodeBoxBlur,
  encodeRadialBlur,
  encodeMotionBlur,
  encodeRemoveMotionBlur,
  encodeLensBlur,
  encodeSharpen,
  encodeSharpenMore,
  encodeUnsharpMask,
  encodeSmartSharpen,
  encodeAddNoise,
  encodeFilmGrain,
  encodeMedian,
  encodeBilateral,
  encodeReduceNoise,
  encodeClouds,
  encodePixelate,
  encodeSeamlessTexture,
  flushFilterComputeDestroys,
} from "./compute/filterCompute";

// ─── Pipeline pair type ──────────────────────────────────────────────────────

type AdjPipelinePair = {
  s8: GPURenderPipeline;
  f32: GPURenderPipeline;
  bgl: GPUBindGroupLayout;
};

// ─── Pipeline factory helpers ────────────────────────────────────────────────

// Binding kinds for explicit BGL construction. Texture bindings default to
// 'unfilterable-float' so they accept rgba32float source layer textures
// (which only support 'unfilterable-float' sampling).
type AdjBinding =
  | "tex"
  | "tex-f"
  | "sampler"
  | "sampler-f"
  | "uniform"
  | "storage";

function createAdjBGL(
  device: GPUDevice,
  bindings: AdjBinding[],
): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    entries: bindings.map((b, i): GPUBindGroupLayoutEntry => {
      if (b === "tex") {
        return {
          binding: i,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: "unfilterable-float",
            viewDimension: "2d",
            multisampled: false,
          },
        };
      }
      if (b === "tex-f") {
        return {
          binding: i,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: "float",
            viewDimension: "2d",
            multisampled: false,
          },
        };
      }
      if (b === "sampler") {
        return {
          binding: i,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "non-filtering" },
        };
      }
      if (b === "sampler-f") {
        return {
          binding: i,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        };
      }
      if (b === "storage") {
        return {
          binding: i,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        };
      }
      return {
        binding: i,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      };
    }),
  });
}

function createAdjRenderPipeline(
  device: GPUDevice,
  wgsl: string,
  fsEntry: string,
  format: GPUTextureFormat,
  bgl: GPUBindGroupLayout,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: wgsl });
  return device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: { module, entryPoint: "vs_adj" },
    fragment: { module, entryPoint: fsEntry, targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
}

function createAdjRenderPipelinePair(
  device: GPUDevice,
  wgsl: string,
  fsEntry: string,
  bindings: AdjBinding[],
): AdjPipelinePair {
  const bgl = createAdjBGL(device, bindings);
  return {
    s8: createAdjRenderPipeline(device, wgsl, fsEntry, "rgba8unorm", bgl),
    f32: createAdjRenderPipeline(device, wgsl, fsEntry, "rgba32float", bgl),
    bgl,
  };
}

// Single-format render pipeline with explicit BGL (used by intermediate passes
// that sample the layer source texture which may be rgba32float).
function createAdjRenderPipelineWithBGL(
  device: GPUDevice,
  wgsl: string,
  fsEntry: string,
  format: GPUTextureFormat,
  bindings: AdjBinding[],
): { pipeline: GPURenderPipeline; bgl: GPUBindGroupLayout } {
  const bgl = createAdjBGL(device, bindings);
  return {
    pipeline: createAdjRenderPipeline(device, wgsl, fsEntry, format, bgl),
    bgl,
  };
}

// Plain auto-layout single-format render pipeline. Retained for intermediate
// pipelines that only sample rgba8unorm scratch textures.
function createAdjRenderPipelineAuto(
  device: GPUDevice,
  wgsl: string,
  fsEntry: string,
  format: GPUTextureFormat,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: wgsl });
  return device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs_adj" },
    fragment: { module, entryPoint: fsEntry, targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
}

function createComputePipeline(
  device: GPUDevice,
  wgsl: string,
  entryPoint: string,
): GPUComputePipeline {
  const module = device.createShaderModule({ code: wgsl });
  return device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint },
  });
}

// ─── AdjustmentEncoder ────────────────────────────────────────────────────────

/**
 * Owns all adjustment render/compute pipelines and pass encoders.
 * WebGPURenderer delegates `encodeAdjustmentOp` calls here.
 * Not part of the public API — internal to the renderer module.
 */
export class AdjustmentEncoder {
  private readonly device: GPUDevice;
  readonly pixelWidth: number;
  readonly pixelHeight: number;

  // Dual-format render pipeline pairs — write directly to dstTex (format-selectable)
  private readonly bcPipeline: AdjPipelinePair;
  private readonly hsPipeline: AdjPipelinePair;
  private readonly vibPipeline: AdjPipelinePair;
  private readonly cbPipeline: AdjPipelinePair;
  private readonly bwPipeline: AdjPipelinePair;
  private readonly tempPipeline: AdjPipelinePair;
  private readonly invertPipeline: AdjPipelinePair;
  private readonly selColorPipeline: AdjPipelinePair;
  private readonly channelMixerPipeline: AdjPipelinePair;
  private readonly autoMatchPipeline: AdjPipelinePair;
  private readonly curvesPipeline: AdjPipelinePair;
  private readonly cgPipeline: AdjPipelinePair;
  private readonly rcPipeline: AdjPipelinePair;
  private readonly ditherPipeline: AdjPipelinePair;
  private readonly ckPipeline: AdjPipelinePair;

  // Bloom render pipelines — intermediate passes always target rgba8unorm scratch textures
  private readonly bloomExtractPipeline: GPURenderPipeline;
  private readonly bloomExtractBGL: GPUBindGroupLayout;
  private readonly bloomDownsamplePipeline: GPURenderPipeline;
  private readonly bloomCompositePipeline: AdjPipelinePair; // final pass: writes to dstTex
  private readonly boxBlurHPipeline: GPURenderPipeline;
  private readonly boxBlurVPipeline: GPURenderPipeline;

  // Halation render pipeline — intermediate extract targets rgba8unorm scratch texture
  private readonly halationExtractPipeline: GPURenderPipeline;
  private readonly halationExtractBGL: GPUBindGroupLayout;

  // Render pipeline pair for chromatic aberration (converted from compute)
  private readonly caPipeline: AdjPipelinePair;

  // Render pipeline pair for vignette
  private readonly vignettePipeline: AdjPipelinePair;

  // Compute pipelines — shaders still use cs_* entry + texture_storage_2d write
  private readonly shadowDilateHPipeline: GPUComputePipeline;
  private readonly shadowDilateVPipeline: GPUComputePipeline;
  private readonly shadowBlurHPipeline: GPUComputePipeline;
  private readonly shadowBlurVPipeline: GPUComputePipeline;
  private readonly shadowCompositePipeline: GPUComputePipeline;
  private readonly outlineDilateHPipeline: GPUComputePipeline;
  private readonly outlineDilateVPipeline: GPUComputePipeline;
  private readonly outlineErodeHPipeline: GPUComputePipeline;
  private readonly outlineErodeVPipeline: GPUComputePipeline;
  private readonly outlineMaskPipeline: GPUComputePipeline;
  private readonly outlineBlurHPipeline: GPUComputePipeline;
  private readonly outlineBlurVPipeline: GPUComputePipeline;
  private readonly outlineCompositePipeline: GPUComputePipeline;

  // Compute pipelines for bevel effect
  private readonly bevelCompositePipeline: GPUComputePipeline;

  // Compute pipelines for inner shadow effect
  private readonly innerShadowCompositePipeline: GPUComputePipeline;

  // Render pipeline pair for halftone (converted from compute)
  private readonly halftonePipeline: AdjPipelinePair;

  // Bloom intermediate texture cache — invalidated when quality changes
  private bloomTexCache: {
    quality: "full" | "half" | "quarter";
    extractTex: GPUTexture;
    blurATex: GPUTexture;
    blurBTex: GPUTexture;
  } | null = null;

  // Halation texture cache
  private halationTexCache: {
    glowATex: GPUTexture;
    glowBTex: GPUTexture;
  } | null = null;

  // Drop shadow texture cache
  private shadowTexCache: { tempA: GPUTexture; tempB: GPUTexture } | null =
    null;

  // Outline texture cache
  private outlineTexCache: {
    tempA: GPUTexture;
    tempB: GPUTexture;
    tempC: GPUTexture;
  } | null = null;

  // Nearest-neighbor sampler for texture reads in adjustment fragment shaders
  private readonly adjSampler: GPUSampler;

  // Linear sampler for LUT texture lookups
  private readonly lutSampler: GPUSampler;

  // Curves LUT cache
  private readonly curvesLutTextures = new Map<
    string,
    { rgb: GPUTexture; red: GPUTexture; green: GPUTexture; blue: GPUTexture }
  >();
  private readonly curvesLutSignatures = new Map<string, string>();

  // Per-frame "this cache was touched" flags. `endFrame()` releases any
  // cache that wasn't touched, which is how we recover the GPU memory
  // held by an effect after its layer is deleted (the encoder itself
  // never sees the deletion — it just stops being asked to render that
  // op, so an unused cache stays resident forever otherwise).
  private bloomUsedThisFrame = false;
  private halationUsedThisFrame = false;
  private shadowUsedThisFrame = false;
  private outlineUsedThisFrame = false;
  private bevelUsedThisFrame = false;
  private innerShadowUsedThisFrame = false;
  private readonly curvesUsedThisFrame = new Set<string>();

  // Temporary GPU buffers accumulated during command encoding; flushed after submit.
  private pendingDestroyBuffers: GPUBuffer[] = [];

  constructor(device: GPUDevice, pixelWidth: number, pixelHeight: number) {
    this.device = device;
    this.pixelWidth = pixelWidth;
    this.pixelHeight = pixelHeight;

    // ── Dual-format render pipeline pairs ──────────────────────────────────────
    // Standard adjustment binding pattern: srcTex, sampler, params, selMask, maskFlags
    const STD: AdjBinding[] = ["tex", "sampler", "uniform", "tex", "uniform"];
    this.bcPipeline = createAdjRenderPipelinePair(
      device,
      BC_COMPUTE,
      "fs_brightness_contrast",
      STD,
    );
    this.hsPipeline = createAdjRenderPipelinePair(
      device,
      HS_COMPUTE,
      "fs_hue_saturation",
      STD,
    );
    this.vibPipeline = createAdjRenderPipelinePair(
      device,
      VIB_COMPUTE,
      "fs_color_vibrance",
      STD,
    );
    this.cbPipeline = createAdjRenderPipelinePair(
      device,
      CB_COMPUTE,
      "fs_color_balance",
      STD,
    );
    this.bwPipeline = createAdjRenderPipelinePair(
      device,
      BW_COMPUTE,
      "fs_black_and_white",
      STD,
    );
    this.tempPipeline = createAdjRenderPipelinePair(
      device,
      TEMP_COMPUTE,
      "fs_color_temperature",
      STD,
    );
    // Invert: srcTex, sampler, selMask, maskFlags (no params uniform)
    this.invertPipeline = createAdjRenderPipelinePair(
      device,
      INVERT_COMPUTE,
      "fs_color_invert",
      ["tex", "sampler", "tex", "uniform"],
    );
    this.selColorPipeline = createAdjRenderPipelinePair(
      device,
      SEL_COLOR_COMPUTE,
      "fs_selective_color",
      STD,
    );
    this.channelMixerPipeline = createAdjRenderPipelinePair(
      device,
      CHANNEL_MIXER_COMPUTE,
      "fs_channel_mixer",
      STD,
    );
    this.autoMatchPipeline = createAdjRenderPipelinePair(
      device,
      AUTO_MATCH_COMPUTE,
      "fs_auto_match",
      STD,
    );
    // Curves: srcTex, smp, selMask, maskFlags, lutSampler (filtering), rgbLut, redLut, greenLut, blueLut (filterable r8unorm)
    this.curvesPipeline = createAdjRenderPipelinePair(
      device,
      CURVES_COMPUTE,
      "fs_curves",
      [
        "tex",
        "sampler",
        "tex",
        "uniform",
        "sampler-f",
        "tex-f",
        "tex-f",
        "tex-f",
        "tex-f",
      ],
    );
    this.cgPipeline = createAdjRenderPipelinePair(
      device,
      CG_COMPUTE,
      "fs_color_grading",
      STD,
    );
    // Reduce-colors / dithering: standard 5 + storage palette buffer
    this.rcPipeline = createAdjRenderPipelinePair(
      device,
      RC_COMPUTE,
      "fs_reduce_colors",
      [...STD, "storage"],
    );
    this.ditherPipeline = createAdjRenderPipelinePair(
      device,
      DITHER_COMPUTE,
      "fs_color_dithering",
      [...STD, "storage"],
    );
    this.ckPipeline = createAdjRenderPipelinePair(
      device,
      CK_COMPUTE,
      "fs_color_key",
      STD,
    );

    // ── Bloom render pipelines ──────────────────────────────────────────────────
    // bloomExtract samples the layer source texture (rgba32float-capable) → explicit BGL
    {
      const ext = createAdjRenderPipelineWithBGL(
        device,
        BLOOM_EXTRACT_COMPUTE,
        "fs_bloom_extract",
        "rgba8unorm",
        STD,
      );
      this.bloomExtractPipeline = ext.pipeline;
      this.bloomExtractBGL = ext.bgl;
    }
    // Downsample/box-blur only sample rgba8unorm scratch textures → auto layout is fine
    this.bloomDownsamplePipeline = createAdjRenderPipelineAuto(
      device,
      BLOOM_DOWNSAMPLE_COMPUTE,
      "fs_bloom_downsample",
      "rgba8unorm",
    );
    // Composite: srcTex, smp, glowTex, params, selMask, maskFlags
    this.bloomCompositePipeline = createAdjRenderPipelinePair(
      device,
      BLOOM_COMPOSITE_COMPUTE,
      "fs_bloom_composite",
      ["tex", "sampler", "tex", "uniform", "tex", "uniform"],
    );

    // Shared box-blur render pipelines (used by both bloom and halation; always rgba8unorm intermediate)
    this.boxBlurHPipeline = createAdjRenderPipelineAuto(
      device,
      BLOOM_BLUR_H_COMPUTE,
      "fs_bloom_blur_h",
      "rgba8unorm",
    );
    this.boxBlurVPipeline = createAdjRenderPipelineAuto(
      device,
      BLOOM_BLUR_V_COMPUTE,
      "fs_bloom_blur_v",
      "rgba8unorm",
    );

    // Halation extract render pipeline (samples layer source texture → explicit BGL)
    {
      const ext = createAdjRenderPipelineWithBGL(
        device,
        HALATION_EXTRACT_COMPUTE,
        "fs_halation_extract",
        "rgba8unorm",
        STD,
      );
      this.halationExtractPipeline = ext.pipeline;
      this.halationExtractBGL = ext.bgl;
    }

    // ── Render pipelines for chromatic aberration and halftone ──────────────────
    this.caPipeline = createAdjRenderPipelinePair(
      device,
      CHROMATIC_ABERRATION_COMPUTE,
      "fs_chromatic_aberration",
      STD,
    );
    this.vignettePipeline = createAdjRenderPipelinePair(
      device,
      VIGNETTE_COMPUTE,
      "fs_vignette",
      STD,
    );

    // ── Compute pipelines ───────────────────────────────────────────────────────
    this.shadowDilateHPipeline = createComputePipeline(
      device,
      DROP_SHADOW_DILATE_H_COMPUTE,
      "cs_shadow_dilate_h",
    );
    this.shadowDilateVPipeline = createComputePipeline(
      device,
      DROP_SHADOW_DILATE_V_COMPUTE,
      "cs_shadow_dilate_v",
    );
    this.shadowBlurHPipeline = createComputePipeline(
      device,
      DROP_SHADOW_BLUR_H_COMPUTE,
      "cs_shadow_blur_h",
    );
    this.shadowBlurVPipeline = createComputePipeline(
      device,
      DROP_SHADOW_BLUR_V_COMPUTE,
      "cs_shadow_blur_v",
    );
    this.shadowCompositePipeline = createComputePipeline(
      device,
      DROP_SHADOW_COMPOSITE_COMPUTE,
      "cs_shadow_composite",
    );

    this.outlineDilateHPipeline = createComputePipeline(
      device,
      OUTLINE_DILATE_H_COMPUTE,
      "cs_outline_dilate_h",
    );
    this.outlineDilateVPipeline = createComputePipeline(
      device,
      OUTLINE_DILATE_V_COMPUTE,
      "cs_outline_dilate_v",
    );
    this.outlineErodeHPipeline = createComputePipeline(
      device,
      OUTLINE_ERODE_H_COMPUTE,
      "cs_outline_erode_h",
    );
    this.outlineErodeVPipeline = createComputePipeline(
      device,
      OUTLINE_ERODE_V_COMPUTE,
      "cs_outline_erode_v",
    );
    this.outlineMaskPipeline = createComputePipeline(
      device,
      OUTLINE_MASK_COMPUTE,
      "cs_outline_mask",
    );
    this.outlineBlurHPipeline = createComputePipeline(
      device,
      OUTLINE_BLUR_H_COMPUTE,
      "cs_outline_blur_h",
    );
    this.outlineBlurVPipeline = createComputePipeline(
      device,
      OUTLINE_BLUR_V_COMPUTE,
      "cs_outline_blur_v",
    );
    this.outlineCompositePipeline = createComputePipeline(
      device,
      OUTLINE_COMPOSITE_COMPUTE,
      "cs_outline_composite",
    );

    this.bevelCompositePipeline = createComputePipeline(
      device,
      BEVEL_COMPOSITE_COMPUTE,
      "cs_bevel_composite",
    );
    this.innerShadowCompositePipeline = createComputePipeline(
      device,
      INNER_SHADOW_COMPOSITE_COMPUTE,
      "cs_inner_shadow_composite",
    );

    this.halftonePipeline = createAdjRenderPipelinePair(
      device,
      HALFTONE_COMPUTE,
      "fs_halftone",
      STD,
    );

    // ── Samplers ────────────────────────────────────────────────────────────────
    this.adjSampler = device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.lutSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Encode a single adjustment op into the provided command encoder.
   * Replaces the former `WebGPURenderer.encodeAdjustmentOp`.
   * `format` must match the format of dstTex so the correct pipeline variant is selected.
   */
  encode(
    encoder: GPUCommandEncoder,
    entry: AdjustmentRenderOp,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    format: GPUTextureFormat,
  ): void {
    if (entry.kind === "brightness-contrast") {
      const params = new Float32Array([entry.brightness, entry.contrast, 0, 0]);
      this.encodeStdAdjRenderPass(
        encoder,
        this.bcPipeline,
        srcTex,
        dstTex,
        format,
        params.buffer as ArrayBuffer,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "hue-saturation") {
      const params = new Float32Array([
        entry.hue,
        entry.saturation,
        entry.lightness,
        0,
      ]);
      this.encodeStdAdjRenderPass(
        encoder,
        this.hsPipeline,
        srcTex,
        dstTex,
        format,
        params.buffer as ArrayBuffer,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "color-vibrance") {
      const params = new Float32Array([entry.vibrance, entry.saturation, 0, 0]);
      this.encodeStdAdjRenderPass(
        encoder,
        this.vibPipeline,
        srcTex,
        dstTex,
        format,
        params.buffer as ArrayBuffer,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "color-balance") {
      const p = entry.params;
      const buf = new ArrayBuffer(48);
      const f = new Float32Array(buf);
      const u = new Uint32Array(buf);
      f[0] = p.shadows.cr;
      f[1] = p.shadows.mg;
      f[2] = p.shadows.yb;
      f[3] = p.midtones.cr;
      f[4] = p.midtones.mg;
      f[5] = p.midtones.yb;
      f[6] = p.highlights.cr;
      f[7] = p.highlights.mg;
      f[8] = p.highlights.yb;
      u[9] = p.preserveLuminosity ? 1 : 0;
      this.encodeStdAdjRenderPass(
        encoder,
        this.cbPipeline,
        srcTex,
        dstTex,
        format,
        buf,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "black-and-white") {
      const p = entry.params;
      const params = new Float32Array([
        p.reds,
        p.yellows,
        p.greens,
        p.cyans,
        p.blues,
        p.magentas,
        0,
        0,
      ]);
      this.encodeStdAdjRenderPass(
        encoder,
        this.bwPipeline,
        srcTex,
        dstTex,
        format,
        params.buffer as ArrayBuffer,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "color-temperature") {
      const params = new Float32Array([entry.temperature, entry.tint, 0, 0]);
      this.encodeStdAdjRenderPass(
        encoder,
        this.tempPipeline,
        srcTex,
        dstTex,
        format,
        params.buffer as ArrayBuffer,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "color-invert") {
      this.encodeInvertRenderPass(
        encoder,
        srcTex,
        dstTex,
        format,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "selective-color") {
      this.encodeSelectiveColorRenderPass(
        encoder,
        srcTex,
        dstTex,
        format,
        entry.params,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "channel-mixer") {
      this.encodeChannelMixerRenderPass(
        encoder,
        srcTex,
        dstTex,
        format,
        entry.params,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "auto-match") {
      // AutoMatchParams: 8 × vec4 = 128 bytes
      const buf = new ArrayBuffer(128);
      const f = new Float32Array(buf);
      const u = new Uint32Array(buf);
      // layerStats
      f[0] = entry.layerMeanL;
      f[1] = entry.layerStdL;
      f[2] = entry.layerMinL;
      f[3] = entry.layerMaxL;
      // layerColor (.w = valid01)
      f[4] = entry.layerMeanR;
      f[5] = entry.layerMeanG;
      f[6] = entry.layerMeanB;
      f[7] = entry.layerCount > 0 ? 1 : 0;
      // contextStats
      f[8] = entry.contextMeanL;
      f[9] = entry.contextStdL;
      f[10] = entry.contextMinL;
      f[11] = entry.contextMaxL;
      // contextColor (.w = valid01)
      f[12] = entry.contextMeanR;
      f[13] = entry.contextMeanG;
      f[14] = entry.contextMeanB;
      f[15] = entry.contextCount > 0 ? 1 : 0;
      // factors (already pre-divided by 100 in canvasPlan)
      f[16] = entry.strength;
      f[17] = entry.brightness;
      f[18] = entry.contrast;
      f[19] = entry.gamma;
      // colorFactor: (color, saturation, _, _)
      f[20] = entry.color;
      f[21] = entry.saturation;
      f[22] = 0;
      f[23] = 0;
      // flags
      u[24] = entry.clampHighlights ? 1 : 0;
      u[25] = entry.clampShadows ? 1 : 0;
      u[26] = 0;
      u[27] = 0;
      // extraStats: (layerChromaMag, contextChromaMag, _, _)
      f[28] = entry.layerChromaMag;
      f[29] = entry.contextChromaMag;
      f[30] = 0;
      f[31] = 0;

      this.encodeStdAdjRenderPass(
        encoder,
        this.autoMatchPipeline,
        srcTex,
        dstTex,
        format,
        buf,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "curves") {
      this.encodeCurvesRenderPass(
        encoder,
        srcTex,
        dstTex,
        format,
        entry.layerId,
        entry.luts,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "color-grading") {
      this.encodeColorGradingRenderPass(
        encoder,
        srcTex,
        dstTex,
        format,
        entry.params,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "reduce-colors") {
      this.encodeReduceColorsRenderPass(
        encoder,
        srcTex,
        dstTex,
        format,
        entry.palette,
        entry.paletteCount,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "color-dithering") {
      this.encodeColorDitheringRenderPass(
        encoder,
        srcTex,
        dstTex,
        format,
        entry.palette,
        entry.paletteCount,
        entry.style,
        entry.opacity,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "bloom") {
      this.encodeBloomRenderPass(
        encoder,
        srcTex,
        dstTex,
        format,
        entry.threshold,
        entry.strength,
        entry.spread,
        entry.quality,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "chromatic-aberration") {
      const buf = new ArrayBuffer(16);
      const u = new Uint32Array(buf);
      const f = new Float32Array(buf);
      u[0] = entry.caType === "radial" ? 0 : 1;
      f[1] = entry.distance;
      f[2] = entry.angle;
      this.encodeStdAdjRenderPass(
        encoder,
        this.caPipeline,
        srcTex,
        dstTex,
        format,
        buf,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "vignette") {
      // VignetteParams layout (32 bytes):
      //   0  shape     u32
      //   4  spread    f32
      //   8  softness  f32
      //  12  opacity   f32
      //  16  color     vec3f
      //  28  roundness f32
      const buf = new ArrayBuffer(32);
      const u = new Uint32Array(buf);
      const f = new Float32Array(buf);
      u[0] = entry.shape === "ellipse" ? 0 : 1;
      f[1] = entry.spread;
      f[2] = entry.softness;
      f[3] = entry.opacity;
      f[4] = entry.colorR;
      f[5] = entry.colorG;
      f[6] = entry.colorB;
      f[7] = entry.roundness;
      this.encodeStdAdjRenderPass(
        encoder,
        this.vignettePipeline,
        srcTex,
        dstTex,
        format,
        buf,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "halation") {
      this.encodeHalationRenderPass(
        encoder,
        srcTex,
        dstTex,
        format,
        entry.threshold,
        entry.spread,
        entry.blur,
        entry.strength,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "color-key") {
      const params = new Float32Array([
        entry.keyR,
        entry.keyG,
        entry.keyB,
        entry.tolerance,
        entry.softness,
        entry.dilation,
        0,
        0,
      ]);
      this.encodeStdAdjRenderPass(
        encoder,
        this.ckPipeline,
        srcTex,
        dstTex,
        format,
        params.buffer as ArrayBuffer,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "drop-shadow") {
      this.encodeDropShadowPass(
        encoder,
        srcTex,
        dstTex,
        entry.colorR,
        entry.colorG,
        entry.colorB,
        entry.colorA,
        entry.opacity,
        entry.offsetX,
        entry.offsetY,
        entry.spread,
        entry.softness,
        entry.blendMode,
        entry.knockout,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "glow") {
      this.encodeDropShadowPass(
        encoder,
        srcTex,
        dstTex,
        entry.colorR,
        entry.colorG,
        entry.colorB,
        entry.colorA,
        entry.opacity,
        0,
        0,
        entry.spread,
        entry.softness,
        entry.blendMode,
        entry.knockout,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "outline") {
      this.encodeOutlinePass(
        encoder,
        srcTex,
        dstTex,
        entry.colorR,
        entry.colorG,
        entry.colorB,
        entry.colorA,
        entry.opacity,
        entry.thickness,
        entry.position,
        entry.softness,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "halftone") {
      const buf = new ArrayBuffer(32);
      const f = new Float32Array(buf);
      const u = new Uint32Array(buf);
      f[0] = entry.frequency;
      f[1] = entry.offsetC;
      f[2] = entry.offsetM;
      f[3] = entry.offsetY;
      f[4] = entry.offsetK;
      u[5] = entry.mode === "color" ? 0 : 1;
      this.encodeStdAdjRenderPass(
        encoder,
        this.halftonePipeline,
        srcTex,
        dstTex,
        format,
        buf,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "bevel") {
      this.encodeBevelPass(
        encoder,
        srcTex,
        dstTex,
        entry.width,
        entry.softness,
        entry.angle,
        entry.strength,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "inner-shadow") {
      this.encodeInnerShadowPass(
        encoder,
        srcTex,
        dstTex,
        entry.colorR,
        entry.colorG,
        entry.colorB,
        entry.colorA,
        entry.opacity,
        entry.offsetX,
        entry.offsetY,
        entry.spread,
        entry.softness,
        entry.selMaskLayer,
      );
      return;
    }
    if (entry.kind === "inner-glow") {
      this.encodeInnerShadowPass(
        encoder,
        srcTex,
        dstTex,
        entry.colorR,
        entry.colorG,
        entry.colorB,
        entry.colorA,
        entry.opacity,
        0,
        0,
        entry.spread,
        entry.softness,
        entry.selMaskLayer,
      );
      return;
    }
    const w = this.pixelWidth;
    const h = this.pixelHeight;
    if (entry.kind === "gaussian-blur") {
      encodeGaussianBlur(encoder, srcTex, dstTex, w, h, entry.radius);
      return;
    }
    if (entry.kind === "box-blur") {
      encodeBoxBlur(encoder, srcTex, dstTex, w, h, entry.radius);
      return;
    }
    if (entry.kind === "radial-blur") {
      encodeRadialBlur(
        encoder,
        srcTex,
        dstTex,
        w,
        h,
        entry.mode,
        entry.amount,
        entry.centerX,
        entry.centerY,
        entry.quality,
      );
      return;
    }
    if (entry.kind === "motion-blur") {
      encodeMotionBlur(
        encoder,
        srcTex,
        dstTex,
        w,
        h,
        entry.angle,
        entry.distance,
      );
      return;
    }
    if (entry.kind === "remove-motion-blur") {
      encodeRemoveMotionBlur(
        encoder,
        srcTex,
        dstTex,
        w,
        h,
        entry.angle,
        entry.distance,
        entry.noiseReduction,
      );
      return;
    }
    if (entry.kind === "lens-blur") {
      encodeLensBlur(
        encoder,
        srcTex,
        dstTex,
        w,
        h,
        entry.radius,
        entry.bladeCount,
        entry.bladeCurvature,
        entry.rotation,
      );
      return;
    }
    if (entry.kind === "sharpen") {
      encodeSharpen(encoder, srcTex, dstTex, w, h);
      return;
    }
    if (entry.kind === "sharpen-more") {
      encodeSharpenMore(encoder, srcTex, dstTex, w, h);
      return;
    }
    if (entry.kind === "unsharp-mask") {
      encodeUnsharpMask(
        encoder,
        srcTex,
        dstTex,
        w,
        h,
        entry.amount,
        entry.radius,
        entry.threshold,
      );
      return;
    }
    if (entry.kind === "smart-sharpen") {
      encodeSmartSharpen(
        encoder,
        srcTex,
        dstTex,
        w,
        h,
        entry.amount,
        entry.radius,
        entry.reduceNoise,
        entry.remove,
      );
      return;
    }
    if (entry.kind === "add-noise") {
      encodeAddNoise(
        encoder,
        srcTex,
        dstTex,
        w,
        h,
        entry.amount,
        entry.distribution,
        entry.monochromatic,
        entry.seed,
      );
      return;
    }
    if (entry.kind === "film-grain") {
      encodeFilmGrain(
        encoder,
        srcTex,
        dstTex,
        w,
        h,
        entry.grainSize,
        entry.intensity,
        entry.roughness,
        entry.seed,
      );
      return;
    }
    if (entry.kind === "median-filter") {
      encodeMedian(encoder, srcTex, dstTex, w, h, entry.radius);
      return;
    }
    if (entry.kind === "bilateral-filter") {
      encodeBilateral(
        encoder,
        srcTex,
        dstTex,
        w,
        h,
        entry.radius,
        entry.sigmaSpatial,
        entry.sigmaColor,
      );
      return;
    }
    if (entry.kind === "reduce-noise") {
      encodeReduceNoise(
        encoder,
        srcTex,
        dstTex,
        w,
        h,
        entry.strength,
        entry.preserveDetails,
        entry.reduceColorNoise,
        entry.sharpenDetails,
      );
      return;
    }
    if (entry.kind === "clouds") {
      encodeClouds(
        encoder,
        srcTex,
        dstTex,
        w,
        h,
        entry.scale,
        entry.opacity,
        entry.colorMode,
        entry.fgColor,
        entry.bgColor,
        entry.seed,
      );
      return;
    }
    if (entry.kind === "pixelate") {
      encodePixelate(encoder, srcTex, dstTex, w, h, entry.blockSize);
      return;
    }
    if (entry.kind === "seamless-texture") {
      encodeSeamlessTexture(
        encoder,
        srcTex,
        dstTex,
        w,
        h,
        entry.breakRepetition,
        entry.cellSize,
        entry.blendRadius,
        entry.seamlessBorders,
        entry.borderRadius,
        entry.seed,
      );
      return;
    }
    const _exhaustive: never = entry;
    return _exhaustive;
  }

  /** Destroy per-frame GPU buffers accumulated during encode calls. Call after queue.submit(). */
  flushPendingDestroys(): void {
    for (const buf of this.pendingDestroyBuffers) buf.destroy();
    this.pendingDestroyBuffers = [];
    flushFilterComputeDestroys();
  }

  /**
   * Release any per-effect texture caches that weren't touched during the
   * frame just submitted. This is how we recover GPU memory after the user
   * removes (or hides) the layer that was using a given effect — the
   * encoder doesn't observe layer deletions directly, it only sees which
   * ops the render plan dispatched, so any cache that goes a whole frame
   * un-touched is dead. Call once per frame, after `flushPendingDestroys`.
   */
  endFrame(): void {
    if (!this.bloomUsedThisFrame && this.bloomTexCache) {
      destroyTrackedTexture(this.bloomTexCache.extractTex);
      destroyTrackedTexture(this.bloomTexCache.blurATex);
      destroyTrackedTexture(this.bloomTexCache.blurBTex);
      this.bloomTexCache = null;
    }
    if (!this.halationUsedThisFrame && this.halationTexCache) {
      destroyTrackedTexture(this.halationTexCache.glowATex);
      destroyTrackedTexture(this.halationTexCache.glowBTex);
      this.halationTexCache = null;
    }
    if (!this.shadowUsedThisFrame && this.shadowTexCache) {
      destroyTrackedTexture(this.shadowTexCache.tempA);
      destroyTrackedTexture(this.shadowTexCache.tempB);
      this.shadowTexCache = null;
    }
    if (!this.outlineUsedThisFrame && this.outlineTexCache) {
      destroyTrackedTexture(this.outlineTexCache.tempA);
      destroyTrackedTexture(this.outlineTexCache.tempB);
      destroyTrackedTexture(this.outlineTexCache.tempC);
      this.outlineTexCache = null;
    }
    if (!this.bevelUsedThisFrame && this.bevelTexCache) {
      destroyTrackedTexture(this.bevelTexCache.tempA);
      destroyTrackedTexture(this.bevelTexCache.tempB);
      this.bevelTexCache = null;
    }
    if (!this.innerShadowUsedThisFrame && this.innerShadowTexCache) {
      destroyTrackedTexture(this.innerShadowTexCache.tempA);
      destroyTrackedTexture(this.innerShadowTexCache.tempB);
      this.innerShadowTexCache = null;
    }

    // Curves LUTs are keyed per layer-id — drop entries for any layers
    // whose curves op didn't run this frame (layer deleted, hidden, etc).
    for (const [layerId, luts] of this.curvesLutTextures) {
      if (this.curvesUsedThisFrame.has(layerId)) continue;
      destroyTrackedTexture(luts.rgb);
      destroyTrackedTexture(luts.red);
      destroyTrackedTexture(luts.green);
      destroyTrackedTexture(luts.blue);
      this.curvesLutTextures.delete(layerId);
      this.curvesLutSignatures.delete(layerId);
    }

    this.bloomUsedThisFrame = false;
    this.halationUsedThisFrame = false;
    this.shadowUsedThisFrame = false;
    this.outlineUsedThisFrame = false;
    this.bevelUsedThisFrame = false;
    this.innerShadowUsedThisFrame = false;
    this.curvesUsedThisFrame.clear();
  }

  /** Destroy all persistent GPU resources (pipelines, texture caches, LUT textures). */
  destroy(): void {
    for (const luts of this.curvesLutTextures.values()) {
      destroyTrackedTexture(luts.rgb);
      destroyTrackedTexture(luts.red);
      destroyTrackedTexture(luts.green);
      destroyTrackedTexture(luts.blue);
    }
    if (this.bloomTexCache) {
      destroyTrackedTexture(this.bloomTexCache.extractTex);
      destroyTrackedTexture(this.bloomTexCache.blurATex);
      destroyTrackedTexture(this.bloomTexCache.blurBTex);
    }
    this.bloomTexCache = null;
    if (this.halationTexCache) {
      destroyTrackedTexture(this.halationTexCache.glowATex);
      destroyTrackedTexture(this.halationTexCache.glowBTex);
    }
    this.halationTexCache = null;
    if (this.shadowTexCache) {
      destroyTrackedTexture(this.shadowTexCache.tempA);
      destroyTrackedTexture(this.shadowTexCache.tempB);
    }
    this.shadowTexCache = null;
    if (this.outlineTexCache) {
      destroyTrackedTexture(this.outlineTexCache.tempA);
      destroyTrackedTexture(this.outlineTexCache.tempB);
      destroyTrackedTexture(this.outlineTexCache.tempC);
    }
    this.outlineTexCache = null;
    if (this.bevelTexCache) {
      destroyTrackedTexture(this.bevelTexCache.tempA);
      destroyTrackedTexture(this.bevelTexCache.tempB);
    }
    this.bevelTexCache = null;
    if (this.innerShadowTexCache) {
      destroyTrackedTexture(this.innerShadowTexCache.tempA);
      destroyTrackedTexture(this.innerShadowTexCache.tempB);
    }
    this.innerShadowTexCache = null;
  }

  // ─── Generic render pass helpers ────────────────────────────────────────────

  private encodeRenderPass(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    bgl: GPUBindGroupLayout,
    dstTex: GPUTexture,
    entries: GPUBindGroupEntry[],
  ): void {
    const bindGroup = this.device.createBindGroup({
      layout: bgl,
      entries,
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: dstTex.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
  }

  // Standard adjustment render pass: binding 0=srcTex, 1=sampler, 2=params, 3=selMask, 4=maskFlags
  private encodeStdAdjRenderPass(
    encoder: GPUCommandEncoder,
    pair: AdjPipelinePair,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    format: GPUTextureFormat,
    paramsBuffer: ArrayBuffer,
    selMaskLayer?: GpuLayer,
  ): void {
    const { device } = this;
    const pipeline = format === "rgba32float" ? pair.f32 : pair.s8;

    const alignedSize = Math.max(
      16,
      Math.ceil(paramsBuffer.byteLength / 16) * 16,
    );
    const paramsBuf = createUniformBuffer(device, alignedSize);
    device.queue.writeBuffer(paramsBuf, 0, paramsBuffer);

    const maskFlagsData = new Uint32Array(8);
    maskFlagsData[0] = selMaskLayer ? 1 : 0;
    const maskFlagsBuf = createUniformBuffer(device, 32);
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsData);

    const dummyMask = selMaskLayer?.texture ?? srcTex;

    this.encodeRenderPass(encoder, pipeline, pair.bgl, dstTex, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.adjSampler },
      { binding: 2, resource: { buffer: paramsBuf } },
      { binding: 3, resource: dummyMask.createView() },
      { binding: 4, resource: { buffer: maskFlagsBuf } },
    ]);

    this.pendingDestroyBuffers.push(paramsBuf, maskFlagsBuf);
  }

  // ─── Specialised render pass encoders ────────────────────────────────────────

  private encodeInvertRenderPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    format: GPUTextureFormat,
    selMaskLayer?: GpuLayer,
  ): void {
    const { device } = this;
    const pipeline =
      format === "rgba32float"
        ? this.invertPipeline.f32
        : this.invertPipeline.s8;

    const maskFlagsData = new Uint32Array(8);
    maskFlagsData[0] = selMaskLayer ? 1 : 0;
    const maskFlagsBuf = createUniformBuffer(device, 32);
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsData);

    const dummyMask = selMaskLayer?.texture ?? srcTex;

    this.encodeRenderPass(encoder, pipeline, this.invertPipeline.bgl, dstTex, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.adjSampler },
      { binding: 2, resource: dummyMask.createView() },
      { binding: 3, resource: { buffer: maskFlagsBuf } },
    ]);

    this.pendingDestroyBuffers.push(maskFlagsBuf);
  }

  private encodeSelectiveColorRenderPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    format: GPUTextureFormat,
    params: SelectiveColorPassParams,
    selMaskLayer?: GpuLayer,
  ): void {
    const { device } = this;
    const pipeline =
      format === "rgba32float"
        ? this.selColorPipeline.f32
        : this.selColorPipeline.s8;

    const RANGE_ORDER = [
      params.reds,
      params.yellows,
      params.greens,
      params.cyans,
      params.blues,
      params.magentas,
      params.whites,
      params.neutrals,
      params.blacks,
    ] as const;

    // SelectiveColorParams struct:  4 × array<vec4f,3> + u32 + vec3u = 4×48 + 16 = 208 bytes
    const buf = new ArrayBuffer(208);
    const f = new Float32Array(buf);
    const packArray9 = (offset: number, values: readonly number[]) => {
      for (let i = 0; i < 9; i++) {
        f[offset + i] = values[i];
      }
    };
    packArray9(
      0,
      RANGE_ORDER.map((r) => r.cyan),
    );
    packArray9(
      12,
      RANGE_ORDER.map((r) => r.magenta),
    );
    packArray9(
      24,
      RANGE_ORDER.map((r) => r.yellow),
    );
    packArray9(
      36,
      RANGE_ORDER.map((r) => r.black),
    );
    const u32View = new Uint32Array(buf);
    u32View[48] = params.mode === "relative" ? 1 : 0;

    const paramsBuf = createUniformBuffer(device, 208);
    device.queue.writeBuffer(paramsBuf, 0, buf);

    const maskFlagsData = new Uint32Array(8);
    maskFlagsData[0] = selMaskLayer ? 1 : 0;
    const maskFlagsBuf = createUniformBuffer(device, 32);
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsData);

    const dummyMask = selMaskLayer?.texture ?? srcTex;

    this.encodeRenderPass(
      encoder,
      pipeline,
      this.selColorPipeline.bgl,
      dstTex,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: this.adjSampler },
        { binding: 2, resource: { buffer: paramsBuf } },
        { binding: 3, resource: dummyMask.createView() },
        { binding: 4, resource: { buffer: maskFlagsBuf } },
      ],
    );

    this.pendingDestroyBuffers.push(paramsBuf, maskFlagsBuf);
  }

  private encodeChannelMixerRenderPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    format: GPUTextureFormat,
    params: ChannelMixerPassParams,
    selMaskLayer?: GpuLayer,
  ): void {
    // Layout: red, green, blue, gray (4 × vec4f) + flags (vec4u) = 80 bytes
    const buf = new ArrayBuffer(80);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    const writeRow = (
      offset: number,
      c: { red: number; green: number; blue: number; constant: number },
    ): void => {
      f[offset + 0] = c.red;
      f[offset + 1] = c.green;
      f[offset + 2] = c.blue;
      f[offset + 3] = c.constant;
    };
    writeRow(0, params.red);
    writeRow(4, params.green);
    writeRow(8, params.blue);
    writeRow(12, params.gray);
    u[16] = params.monochrome ? 1 : 0;

    this.encodeStdAdjRenderPass(
      encoder,
      this.channelMixerPipeline,
      srcTex,
      dstTex,
      format,
      buf,
      selMaskLayer,
    );
  }

  private ensureCurvesLutTextures(
    layerId: string,
    luts: CurvesLuts,
  ): { rgb: GPUTexture; red: GPUTexture; green: GPUTexture; blue: GPUTexture } {
    this.curvesUsedThisFrame.add(layerId);
    const signature = `${Array.from(luts.rgb).join(".")}-${Array.from(luts.red).join(".")}-${Array.from(luts.green).join(".")}-${Array.from(luts.blue).join(".")}`;
    const existing = this.curvesLutTextures.get(layerId);
    const prevSig = this.curvesLutSignatures.get(layerId);
    if (existing && prevSig === signature) return existing;

    const writeLut = (data: Uint8Array): GPUTexture => {
      const tex = createTrackedTexture(this.device, {
        size: { width: 256, height: 1 },
        format: "r8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      uploadR8TextureData(this.device, tex, 256, 1, data);
      return tex;
    };

    if (existing) {
      destroyTrackedTexture(existing.rgb);
      destroyTrackedTexture(existing.red);
      destroyTrackedTexture(existing.green);
      destroyTrackedTexture(existing.blue);
    }

    const next = {
      rgb: writeLut(luts.rgb),
      red: writeLut(luts.red),
      green: writeLut(luts.green),
      blue: writeLut(luts.blue),
    };
    this.curvesLutTextures.set(layerId, next);
    this.curvesLutSignatures.set(layerId, signature);
    return next;
  }

  private encodeCurvesRenderPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    format: GPUTextureFormat,
    layerId: string,
    luts: CurvesLuts,
    selMaskLayer?: GpuLayer,
  ): void {
    const { device } = this;
    const pipeline =
      format === "rgba32float"
        ? this.curvesPipeline.f32
        : this.curvesPipeline.s8;
    const textures = this.ensureCurvesLutTextures(layerId, luts);

    const maskFlagsData = new Uint32Array(8);
    maskFlagsData[0] = selMaskLayer ? 1 : 0;
    const maskFlagsBuf = createUniformBuffer(device, 32);
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsData);

    const dummyMask = selMaskLayer?.texture ?? srcTex;

    this.encodeRenderPass(encoder, pipeline, this.curvesPipeline.bgl, dstTex, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.adjSampler },
      { binding: 2, resource: dummyMask.createView() },
      { binding: 3, resource: { buffer: maskFlagsBuf } },
      { binding: 4, resource: this.lutSampler },
      { binding: 5, resource: textures.rgb.createView() },
      { binding: 6, resource: textures.red.createView() },
      { binding: 7, resource: textures.green.createView() },
      { binding: 8, resource: textures.blue.createView() },
    ]);

    this.pendingDestroyBuffers.push(maskFlagsBuf);
  }

  private encodeColorGradingRenderPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    format: GPUTextureFormat,
    cgParams: ColorGradingPassParams,
    selMaskLayer?: GpuLayer,
  ): void {
    const { lift, gamma, gain, offset } = cgParams;
    const buf = new ArrayBuffer(128);
    const f = new Float32Array(buf);
    f[0] = lift.r;
    f[1] = lift.g;
    f[2] = lift.b;
    f[3] = lift.master;
    f[4] = gamma.r;
    f[5] = gamma.g;
    f[6] = gamma.b;
    f[7] = gamma.master;
    f[8] = gain.r;
    f[9] = gain.g;
    f[10] = gain.b;
    f[11] = gain.master;
    f[12] = offset.r;
    f[13] = offset.g;
    f[14] = offset.b;
    f[15] = offset.master;
    f[16] = cgParams.temp;
    f[17] = cgParams.tint;
    f[18] = cgParams.contrast;
    f[19] = cgParams.pivot;
    f[20] = cgParams.midDetail;
    f[21] = cgParams.colorBoost;
    f[22] = cgParams.shadows;
    f[23] = cgParams.highlights;
    f[24] = cgParams.saturation;
    f[25] = cgParams.hue;
    f[26] = cgParams.lumMix;
    f[27] = 0; // _pad

    this.encodeStdAdjRenderPass(
      encoder,
      this.cgPipeline,
      srcTex,
      dstTex,
      format,
      buf,
      selMaskLayer,
    );
  }

  private encodeReduceColorsRenderPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    format: GPUTextureFormat,
    palette: Float32Array,
    paletteCount: number,
    selMaskLayer?: GpuLayer,
  ): void {
    const { device } = this;
    const pipeline =
      format === "rgba32float" ? this.rcPipeline.f32 : this.rcPipeline.s8;

    const paramsData = new Uint32Array(8);
    paramsData[0] = paletteCount;
    const paramsBuf = createUniformBuffer(device, 32);
    device.queue.writeBuffer(paramsBuf, 0, paramsData);

    const palBuf = createStorageBuffer(device, 256 * 16);
    device.queue.writeBuffer(palBuf, 0, palette as Float32Array<ArrayBuffer>);

    const maskFlagsData = new Uint32Array(8);
    maskFlagsData[0] = selMaskLayer ? 1 : 0;
    const maskFlagsBuf = createUniformBuffer(device, 32);
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsData);

    const dummyMask = selMaskLayer?.texture ?? srcTex;

    this.encodeRenderPass(encoder, pipeline, this.rcPipeline.bgl, dstTex, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.adjSampler },
      { binding: 2, resource: { buffer: paramsBuf } },
      { binding: 3, resource: dummyMask.createView() },
      { binding: 4, resource: { buffer: maskFlagsBuf } },
      { binding: 5, resource: { buffer: palBuf } },
    ]);

    this.pendingDestroyBuffers.push(paramsBuf, palBuf, maskFlagsBuf);
  }

  private encodeColorDitheringRenderPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    format: GPUTextureFormat,
    palette: Float32Array,
    paletteCount: number,
    style: number,
    opacity: number,
    selMaskLayer?: GpuLayer,
  ): void {
    const { device } = this;
    const pipeline =
      format === "rgba32float"
        ? this.ditherPipeline.f32
        : this.ditherPipeline.s8;

    const paramsData = new Uint32Array(8);
    paramsData[0] = paletteCount;
    paramsData[1] = style;
    paramsData[2] = Math.round(opacity);
    const paramsBuf = createUniformBuffer(device, 32);
    device.queue.writeBuffer(paramsBuf, 0, paramsData);

    const palBuf = createStorageBuffer(device, 256 * 16);
    device.queue.writeBuffer(palBuf, 0, palette as Float32Array<ArrayBuffer>);

    const maskFlagsData = new Uint32Array(8);
    maskFlagsData[0] = selMaskLayer ? 1 : 0;
    const maskFlagsBuf = createUniformBuffer(device, 32);
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsData);

    const dummyMask = selMaskLayer?.texture ?? srcTex;

    this.encodeRenderPass(encoder, pipeline, this.ditherPipeline.bgl, dstTex, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.adjSampler },
      { binding: 2, resource: { buffer: paramsBuf } },
      { binding: 3, resource: dummyMask.createView() },
      { binding: 4, resource: { buffer: maskFlagsBuf } },
      { binding: 5, resource: { buffer: palBuf } },
    ]);

    this.pendingDestroyBuffers.push(paramsBuf, palBuf, maskFlagsBuf);
  }

  private ensureBloomTextures(quality: "full" | "half" | "quarter"): {
    extractTex: GPUTexture;
    blurATex: GPUTexture;
    blurBTex: GPUTexture;
  } {
    this.bloomUsedThisFrame = true;
    if (this.bloomTexCache && this.bloomTexCache.quality === quality) {
      return this.bloomTexCache;
    }
    if (this.bloomTexCache) {
      destroyTrackedTexture(this.bloomTexCache.extractTex);
      destroyTrackedTexture(this.bloomTexCache.blurATex);
      destroyTrackedTexture(this.bloomTexCache.blurBTex);
    }

    const { device, pixelWidth: w, pixelHeight: h } = this;
    const scaleFactor = quality === "full" ? 1 : quality === "half" ? 2 : 4;
    const bw = Math.ceil(w / scaleFactor);
    const bh = Math.ceil(h / scaleFactor);

    const usage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC;

    const make = (tw: number, th: number): GPUTexture =>
      createTrackedTexture(device, {
        size: { width: tw, height: th },
        format: "rgba8unorm",
        usage,
      });

    this.bloomTexCache = {
      quality,
      extractTex: make(w, h),
      blurATex: make(bw, bh),
      blurBTex: make(bw, bh),
    };
    return this.bloomTexCache;
  }

  private encodeBloomRenderPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    format: GPUTextureFormat,
    threshold: number,
    strength: number,
    spread: number,
    quality: "full" | "half" | "quarter",
    selMaskLayer: GpuLayer | undefined,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this;
    const { extractTex, blurATex, blurBTex } =
      this.ensureBloomTextures(quality);

    const scaleFactor = quality === "full" ? 1 : quality === "half" ? 2 : 4;
    const blurRadius = Math.max(1, Math.round(spread / scaleFactor));

    const dummyMask = selMaskLayer?.texture ?? srcTex;
    const maskFlagsArr = new Uint32Array(8);
    maskFlagsArr[0] = selMaskLayer ? 1 : 0;
    const maskFlagsBuf = createUniformBuffer(device, 32);
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsArr);

    // ── Pass 1: Extract ──────────────────────────────────────────────────────
    const extractParamsBuf = createUniformBuffer(device, 16);
    writeUniformBuffer(
      device,
      extractParamsBuf,
      new Float32Array([threshold, 0, 0, 0]),
    );
    this.encodeRenderPass(
      encoder,
      this.bloomExtractPipeline,
      this.bloomExtractBGL,
      extractTex,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: this.adjSampler },
        { binding: 2, resource: { buffer: extractParamsBuf } },
        { binding: 3, resource: dummyMask.createView() },
        { binding: 4, resource: { buffer: maskFlagsBuf } },
      ],
    );

    // ── Pass 2: Downsample (skipped at Full quality) ─────────────────────────
    let workingSrc = blurATex;
    let workingDst = blurBTex;

    if (quality !== "full") {
      const dsParamsBuf = createUniformBuffer(device, 16);
      writeUniformBuffer(
        device,
        dsParamsBuf,
        new Uint32Array([scaleFactor, 0, 0, 0]),
      );
      this.encodeRenderPass(
        encoder,
        this.bloomDownsamplePipeline,
        this.bloomDownsamplePipeline.getBindGroupLayout(0),
        blurATex,
        [
          { binding: 0, resource: extractTex.createView() },
          { binding: 2, resource: { buffer: dsParamsBuf } },
        ],
      );
      this.pendingDestroyBuffers.push(dsParamsBuf);
    } else {
      encoder.copyTextureToTexture(
        { texture: extractTex },
        { texture: blurATex },
        { width: w, height: h },
      );
    }

    // ── Passes 3–8: 3 × H+V box blur ────────────────────────────────────────
    const blurParamsBuf = createUniformBuffer(device, 16);
    writeUniformBuffer(
      device,
      blurParamsBuf,
      new Uint32Array([blurRadius, 0, 0, 0]),
    );
    const boxHBGL = this.boxBlurHPipeline.getBindGroupLayout(0);
    const boxVBGL = this.boxBlurVPipeline.getBindGroupLayout(0);

    for (let i = 0; i < 3; i++) {
      this.encodeRenderPass(
        encoder,
        this.boxBlurHPipeline,
        boxHBGL,
        workingDst,
        [
          { binding: 0, resource: workingSrc.createView() },
          { binding: 2, resource: { buffer: blurParamsBuf } },
        ],
      );
      [workingSrc, workingDst] = [workingDst, workingSrc];

      this.encodeRenderPass(
        encoder,
        this.boxBlurVPipeline,
        boxVBGL,
        workingDst,
        [
          { binding: 0, resource: workingSrc.createView() },
          { binding: 2, resource: { buffer: blurParamsBuf } },
        ],
      );
      [workingSrc, workingDst] = [workingDst, workingSrc];
    }

    // ── Pass 9: Composite ────────────────────────────────────────────────────
    const compPipeline =
      format === "rgba32float"
        ? this.bloomCompositePipeline.f32
        : this.bloomCompositePipeline.s8;
    const compParamsBuf = createUniformBuffer(device, 16);
    writeUniformBuffer(
      device,
      compParamsBuf,
      new Float32Array([strength, 0, 0, 0]),
    );
    this.encodeRenderPass(
      encoder,
      compPipeline,
      this.bloomCompositePipeline.bgl,
      dstTex,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: this.adjSampler },
        { binding: 2, resource: workingSrc.createView() },
        { binding: 3, resource: { buffer: compParamsBuf } },
        { binding: 4, resource: dummyMask.createView() },
        { binding: 5, resource: { buffer: maskFlagsBuf } },
      ],
    );

    this.pendingDestroyBuffers.push(
      extractParamsBuf,
      blurParamsBuf,
      compParamsBuf,
      maskFlagsBuf,
    );
  }

  private ensureHalationTextures(): {
    glowATex: GPUTexture;
    glowBTex: GPUTexture;
  } {
    this.halationUsedThisFrame = true;
    if (this.halationTexCache) return this.halationTexCache;
    const { device, pixelWidth: w, pixelHeight: h } = this;
    const usage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_DST;
    const make = (): GPUTexture =>
      createTrackedTexture(device, {
        size: { width: w, height: h },
        format: "rgba8unorm",
        usage,
      });
    this.halationTexCache = { glowATex: make(), glowBTex: make() };
    return this.halationTexCache;
  }

  private encodeHalationRenderPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    format: GPUTextureFormat,
    threshold: number,
    spread: number,
    blur: number,
    strength: number,
    selMaskLayer: GpuLayer | undefined,
  ): void {
    const { device } = this;
    const { glowATex, glowBTex } = this.ensureHalationTextures();

    const dummyMask = selMaskLayer?.texture ?? srcTex;
    const maskFlagsArr = new Uint32Array(8);
    maskFlagsArr[0] = selMaskLayer ? 1 : 0;
    const maskFlagsBuf = createUniformBuffer(device, 32);
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsArr);

    // ── Pass 1: Extract highlights with warm halation tint ───────────────────
    const extractParamsBuf = createUniformBuffer(device, 16);
    writeUniformBuffer(
      device,
      extractParamsBuf,
      new Float32Array([threshold, 0, 0, 0]),
    );
    this.encodeRenderPass(
      encoder,
      this.halationExtractPipeline,
      this.halationExtractBGL,
      glowATex,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: this.adjSampler },
        { binding: 2, resource: { buffer: extractParamsBuf } },
        { binding: 3, resource: dummyMask.createView() },
        { binding: 4, resource: { buffer: maskFlagsBuf } },
      ],
    );

    // ── Passes 2–N: blur × H+V iterations (shared box-blur pipelines) ────────
    const blurRadius = Math.max(1, Math.round(spread));
    const iterations = Math.max(1, Math.min(5, Math.round(blur)));
    const blurParamsBuf = createUniformBuffer(device, 16);
    writeUniformBuffer(
      device,
      blurParamsBuf,
      new Uint32Array([blurRadius, 0, 0, 0]),
    );
    const boxHBGL = this.boxBlurHPipeline.getBindGroupLayout(0);
    const boxVBGL = this.boxBlurVPipeline.getBindGroupLayout(0);

    let workingSrc = glowATex;
    let workingDst = glowBTex;

    for (let i = 0; i < iterations; i++) {
      this.encodeRenderPass(
        encoder,
        this.boxBlurHPipeline,
        boxHBGL,
        workingDst,
        [
          { binding: 0, resource: workingSrc.createView() },
          { binding: 2, resource: { buffer: blurParamsBuf } },
        ],
      );
      [workingSrc, workingDst] = [workingDst, workingSrc];

      this.encodeRenderPass(
        encoder,
        this.boxBlurVPipeline,
        boxVBGL,
        workingDst,
        [
          { binding: 0, resource: workingSrc.createView() },
          { binding: 2, resource: { buffer: blurParamsBuf } },
        ],
      );
      [workingSrc, workingDst] = [workingDst, workingSrc];
    }

    // ── Final pass: composite warm glow onto source (screen blend) ────────────
    const compPipeline =
      format === "rgba32float"
        ? this.bloomCompositePipeline.f32
        : this.bloomCompositePipeline.s8;
    const compParamsBuf = createUniformBuffer(device, 16);
    writeUniformBuffer(
      device,
      compParamsBuf,
      new Float32Array([strength, 0, 0, 0]),
    );
    this.encodeRenderPass(
      encoder,
      compPipeline,
      this.bloomCompositePipeline.bgl,
      dstTex,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: this.adjSampler },
        { binding: 2, resource: workingSrc.createView() },
        { binding: 3, resource: { buffer: compParamsBuf } },
        { binding: 4, resource: dummyMask.createView() },
        { binding: 5, resource: { buffer: maskFlagsBuf } },
      ],
    );

    this.pendingDestroyBuffers.push(
      extractParamsBuf,
      blurParamsBuf,
      compParamsBuf,
      maskFlagsBuf,
    );
  }

  private ensureShadowTextures(): { tempA: GPUTexture; tempB: GPUTexture } {
    this.shadowUsedThisFrame = true;
    if (this.shadowTexCache) return this.shadowTexCache;
    const { device, pixelWidth: w, pixelHeight: h } = this;
    const usage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC;
    const make = (): GPUTexture =>
      createTrackedTexture(device, {
        size: { width: w, height: h },
        format: "rgba8unorm",
        usage,
      });
    this.shadowTexCache = { tempA: make(), tempB: make() };
    return this.shadowTexCache;
  }

  private encodeDropShadowPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    colorR: number,
    colorG: number,
    colorB: number,
    colorA: number,
    opacity: number,
    offsetX: number,
    offsetY: number,
    spread: number,
    softness: number,
    blendMode: "normal" | "multiply" | "screen",
    knockout: boolean,
    selMaskLayer: GpuLayer | undefined,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this;
    const { tempA, tempB } = this.ensureShadowTextures();

    const spreadR = Math.round(spread);
    const blurR = softness > 0 ? Math.max(1, Math.round(softness * 0.577)) : 0;

    const dilateParamsBuf = createUniformBuffer(device, 16);
    writeUniformBuffer(
      device,
      dilateParamsBuf,
      new Uint32Array([spreadR, 0, 0, 0]),
    );

    // ── Pass 1: DilateH (srcTex.a → tempA.r) ────────────────────────────────
    const dilateHBG = device.createBindGroup({
      layout: this.shadowDilateHPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: tempA.createView() },
        { binding: 2, resource: { buffer: dilateParamsBuf } },
      ],
    });
    const dilateHPass = encoder.beginComputePass();
    dilateHPass.setPipeline(this.shadowDilateHPipeline);
    dilateHPass.setBindGroup(0, dilateHBG);
    dilateHPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    dilateHPass.end();

    // ── Pass 2: DilateV (tempA.r → tempB.r) ─────────────────────────────────
    const dilateVBG = device.createBindGroup({
      layout: this.shadowDilateVPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tempA.createView() },
        { binding: 1, resource: tempB.createView() },
        { binding: 2, resource: { buffer: dilateParamsBuf } },
      ],
    });
    const dilateVPass = encoder.beginComputePass();
    dilateVPass.setPipeline(this.shadowDilateVPipeline);
    dilateVPass.setBindGroup(0, dilateVBG);
    dilateVPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    dilateVPass.end();

    // After dilate passes, mask is in tempB.r
    // ── Passes 3–8: 3× H+V box blur (ping-pong tempB ↔ tempA) ───────────────
    let maskTex: GPUTexture = tempB;
    if (softness > 0) {
      const blurParamsBuf = createUniformBuffer(device, 16);
      writeUniformBuffer(
        device,
        blurParamsBuf,
        new Uint32Array([blurR, 0, 0, 0]),
      );

      let workingSrc = tempB;
      let workingDst = tempA;

      for (let i = 0; i < 3; i++) {
        const hBG = device.createBindGroup({
          layout: this.shadowBlurHPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: workingSrc.createView() },
            { binding: 1, resource: workingDst.createView() },
            { binding: 2, resource: { buffer: blurParamsBuf } },
          ],
        });
        const hPass = encoder.beginComputePass();
        hPass.setPipeline(this.shadowBlurHPipeline);
        hPass.setBindGroup(0, hBG);
        hPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
        hPass.end();
        [workingSrc, workingDst] = [workingDst, workingSrc];

        const vBG = device.createBindGroup({
          layout: this.shadowBlurVPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: workingSrc.createView() },
            { binding: 1, resource: workingDst.createView() },
            { binding: 2, resource: { buffer: blurParamsBuf } },
          ],
        });
        const vPass = encoder.beginComputePass();
        vPass.setPipeline(this.shadowBlurVPipeline);
        vPass.setBindGroup(0, vBG);
        vPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
        vPass.end();
        [workingSrc, workingDst] = [workingDst, workingSrc];
      }

      // After 3 complete H+V iterations (start: src=tempB, dst=tempA),
      // workingSrc ends up back at tempB.
      maskTex = workingSrc;
      this.pendingDestroyBuffers.push(blurParamsBuf);
    }

    // ── Pass 9: Composite (srcTex + maskTex → dstTex) ────────────────────────
    const BLEND_MODE_MAP: Record<"normal" | "multiply" | "screen", number> = {
      normal: 0,
      multiply: 1,
      screen: 2,
    };

    const compBuf = new ArrayBuffer(48);
    const cf = new Float32Array(compBuf);
    const ci = new Int32Array(compBuf);
    const cu = new Uint32Array(compBuf);
    cf[0] = colorR;
    cf[1] = colorG;
    cf[2] = colorB;
    cf[3] = colorA;
    cf[4] = opacity;
    ci[5] = offsetX;
    ci[6] = offsetY;
    cu[7] = BLEND_MODE_MAP[blendMode];
    cu[8] = knockout ? 1 : 0;
    // cu[9..11] = 0 (padding, already zeroed)

    const compParamsBuf = createUniformBuffer(device, 48);
    device.queue.writeBuffer(compParamsBuf, 0, compBuf);

    const maskFlagsArr = new Uint32Array(8);
    maskFlagsArr[0] = selMaskLayer ? 1 : 0;
    const maskFlagsBuf = createUniformBuffer(device, 32);
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsArr);

    const dummyMask = selMaskLayer?.texture ?? srcTex;

    const compBG = device.createBindGroup({
      layout: this.shadowCompositePipeline.getBindGroupLayout(0),
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
    compPass.setPipeline(this.shadowCompositePipeline);
    compPass.setBindGroup(0, compBG);
    compPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    compPass.end();

    this.pendingDestroyBuffers.push(
      dilateParamsBuf,
      compParamsBuf,
      maskFlagsBuf,
    );
  }

  private ensureOutlineTextures(): {
    tempA: GPUTexture;
    tempB: GPUTexture;
    tempC: GPUTexture;
  } {
    this.outlineUsedThisFrame = true;
    if (this.outlineTexCache) return this.outlineTexCache;
    const { device, pixelWidth: w, pixelHeight: h } = this;
    const usage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC;
    const make = (): GPUTexture =>
      createTrackedTexture(device, {
        size: { width: w, height: h },
        format: "rgba8unorm",
        usage,
      });
    this.outlineTexCache = { tempA: make(), tempB: make(), tempC: make() };
    return this.outlineTexCache;
  }

  private encodeOutlinePass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    colorR: number,
    colorG: number,
    colorB: number,
    colorA: number,
    opacity: number,
    thickness: number,
    position: "outside" | "inside" | "center",
    softness: number,
    selMaskLayer: GpuLayer | undefined,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this;
    const { tempA, tempB, tempC } = this.ensureOutlineTextures();

    const T = Math.max(1, Math.round(thickness));
    const dilateR = position === "center" ? Math.ceil(T / 2) : T;
    const erodeR = position === "center" ? Math.floor(T / 2) : T;
    const blurR = softness > 0 ? Math.max(1, Math.round(softness * 0.577)) : 0;

    const encodeSimpleMorphPass = (
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
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      pass.end();
    };

    const dilateParamsBuf = createUniformBuffer(device, 16);
    writeUniformBuffer(
      device,
      dilateParamsBuf,
      new Uint32Array([dilateR, 0, 0, 0]),
    );

    if (position === "outside") {
      encodeSimpleMorphPass(
        this.outlineDilateHPipeline,
        srcTex,
        tempA,
        dilateParamsBuf,
      );
      encodeSimpleMorphPass(
        this.outlineDilateVPipeline,
        tempA,
        tempB,
        dilateParamsBuf,
      );
    } else if (position === "inside") {
      encodeSimpleMorphPass(
        this.outlineErodeHPipeline,
        srcTex,
        tempA,
        dilateParamsBuf,
      );
      encodeSimpleMorphPass(
        this.outlineErodeVPipeline,
        tempA,
        tempB,
        dilateParamsBuf,
      );
    } else {
      const erodeParamsBuf = createUniformBuffer(device, 16);
      writeUniformBuffer(
        device,
        erodeParamsBuf,
        new Uint32Array([erodeR, 0, 0, 0]),
      );
      encodeSimpleMorphPass(
        this.outlineDilateHPipeline,
        srcTex,
        tempA,
        dilateParamsBuf,
      );
      encodeSimpleMorphPass(
        this.outlineDilateVPipeline,
        tempA,
        tempC,
        dilateParamsBuf,
      );
      encodeSimpleMorphPass(
        this.outlineErodeHPipeline,
        srcTex,
        tempA,
        erodeParamsBuf,
      );
      encodeSimpleMorphPass(
        this.outlineErodeVPipeline,
        tempA,
        tempB,
        erodeParamsBuf,
      );
      this.pendingDestroyBuffers.push(erodeParamsBuf);
    }

    // Mask derivation pass — output goes into tempA
    const MODE_MAP = { outside: 0, inside: 1, center: 2 } as const;
    const maskParamsBuf = createUniformBuffer(device, 16);
    writeUniformBuffer(
      device,
      maskParamsBuf,
      new Uint32Array([MODE_MAP[position], 0, 0, 0]),
    );

    const morphATex =
      position === "center" ? tempC : position === "outside" ? tempB : srcTex;
    const morphBTex =
      position === "center" ? tempB : position === "inside" ? tempB : srcTex;

    const maskBG = device.createBindGroup({
      layout: this.outlineMaskPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: morphATex.createView() },
        { binding: 2, resource: morphBTex.createView() },
        { binding: 3, resource: tempA.createView() },
        { binding: 4, resource: { buffer: maskParamsBuf } },
      ],
    });
    const maskPass = encoder.beginComputePass();
    maskPass.setPipeline(this.outlineMaskPipeline);
    maskPass.setBindGroup(0, maskBG);
    maskPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    maskPass.end();

    // Softness blur: 3× H+V box blur (ping-pong tempA ↔ tempB)
    let strokeMaskTex: GPUTexture = tempA;
    if (softness > 0) {
      const blurParamsBuf = createUniformBuffer(device, 16);
      writeUniformBuffer(
        device,
        blurParamsBuf,
        new Uint32Array([blurR, 0, 0, 0]),
      );

      let workingSrc = tempA;
      let workingDst = tempB;

      for (let i = 0; i < 3; i++) {
        encodeSimpleMorphPass(
          this.outlineBlurHPipeline,
          workingSrc,
          workingDst,
          blurParamsBuf,
        );
        [workingSrc, workingDst] = [workingDst, workingSrc];
        encodeSimpleMorphPass(
          this.outlineBlurVPipeline,
          workingSrc,
          workingDst,
          blurParamsBuf,
        );
        [workingSrc, workingDst] = [workingDst, workingSrc];
      }

      strokeMaskTex = workingSrc;
      this.pendingDestroyBuffers.push(blurParamsBuf);
    }

    // Composite pass
    const compBuf = new ArrayBuffer(32);
    const cf = new Float32Array(compBuf);
    cf[0] = colorR;
    cf[1] = colorG;
    cf[2] = colorB;
    cf[3] = colorA;
    cf[4] = opacity;
    // cf[5..7] = 0 (padding, already zeroed)
    const compParamsBuf = createUniformBuffer(device, 32);
    device.queue.writeBuffer(compParamsBuf, 0, compBuf);

    const maskFlagsArr = new Uint32Array(8);
    maskFlagsArr[0] = selMaskLayer ? 1 : 0;
    const maskFlagsBuf = createUniformBuffer(device, 32);
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsArr);

    const dummyMask = selMaskLayer?.texture ?? srcTex;

    const compBG = device.createBindGroup({
      layout: this.outlineCompositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: strokeMaskTex.createView() },
        { binding: 2, resource: dstTex.createView() },
        { binding: 3, resource: { buffer: compParamsBuf } },
        { binding: 4, resource: dummyMask.createView() },
        { binding: 5, resource: { buffer: maskFlagsBuf } },
      ],
    });
    const compPass = encoder.beginComputePass();
    compPass.setPipeline(this.outlineCompositePipeline);
    compPass.setBindGroup(0, compBG);
    compPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    compPass.end();

    this.pendingDestroyBuffers.push(
      dilateParamsBuf,
      maskParamsBuf,
      compParamsBuf,
      maskFlagsBuf,
    );
  }

  // ─── Bevel ───────────────────────────────────────────────────────────────────

  private bevelTexCache: { tempA: GPUTexture; tempB: GPUTexture } | null = null;

  private ensureBevelTextures(): { tempA: GPUTexture; tempB: GPUTexture } {
    this.bevelUsedThisFrame = true;
    if (this.bevelTexCache) return this.bevelTexCache;
    const { device, pixelWidth: w, pixelHeight: h } = this;
    const usage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC;
    const make = (): GPUTexture =>
      createTrackedTexture(device, {
        size: { width: w, height: h },
        format: "rgba8unorm",
        usage,
      });
    this.bevelTexCache = { tempA: make(), tempB: make() };
    return this.bevelTexCache;
  }

  private encodeBevelPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    width: number,
    softness: number,
    angle: number,
    strength: number,
    selMaskLayer: GpuLayer | undefined,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this;
    const { tempA, tempB } = this.ensureBevelTextures();

    // Build height field by:
    //  1. Erode radius=1 to transfer src.a into the .r channel (the blur pipeline
    //     reads .r, not .a, so this is required as a channel-copy step).
    //  2. Box blur with radius = width/2. A box blur of radius R applied to a binary
    //     edge produces a linear ramp spanning exactly 2R pixels, so radius = width/2
    //     yields a gradient that spans `width` pixels — giving the correct bevel width.
    //  3. Optional extra blur for softness.

    const copyParamsBuf = createUniformBuffer(device, 16);
    writeUniformBuffer(device, copyParamsBuf, new Uint32Array([1, 0, 0, 0]));

    // Pass 1: ErodeH radius=1 (srcTex.a → tempA.r)
    const copyHBG = device.createBindGroup({
      layout: this.outlineErodeHPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: tempA.createView() },
        { binding: 2, resource: { buffer: copyParamsBuf } },
      ],
    });
    const copyHPass = encoder.beginComputePass();
    copyHPass.setPipeline(this.outlineErodeHPipeline);
    copyHPass.setBindGroup(0, copyHBG);
    copyHPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    copyHPass.end();

    // Pass 2: ErodeV radius=1 (tempA.r → tempB.r)
    const copyVBG = device.createBindGroup({
      layout: this.outlineErodeVPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tempA.createView() },
        { binding: 1, resource: tempB.createView() },
        { binding: 2, resource: { buffer: copyParamsBuf } },
      ],
    });
    const copyVPass = encoder.beginComputePass();
    copyVPass.setPipeline(this.outlineErodeVPipeline);
    copyVPass.setBindGroup(0, copyVBG);
    copyVPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    copyVPass.end();

    // Passes 3–4: Box blur radius = width. A box blur of radius R on a binary edge
    // produces a 2R-wide ramp centred on the original edge. Only the inner half
    // (R pixels deep into the shape) is visible after the alpha mask, so radius=width
    // gives a `width`-pixel-wide visible bevel.
    const heightR = Math.max(1, Math.round(width));
    const heightParamsBuf = createUniformBuffer(device, 16);
    writeUniformBuffer(
      device,
      heightParamsBuf,
      new Uint32Array([heightR, 0, 0, 0]),
    );

    const htHBG = device.createBindGroup({
      layout: this.shadowBlurHPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tempB.createView() },
        { binding: 1, resource: tempA.createView() },
        { binding: 2, resource: { buffer: heightParamsBuf } },
      ],
    });
    const htHPass = encoder.beginComputePass();
    htHPass.setPipeline(this.shadowBlurHPipeline);
    htHPass.setBindGroup(0, htHBG);
    htHPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    htHPass.end();

    const htVBG = device.createBindGroup({
      layout: this.shadowBlurVPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tempA.createView() },
        { binding: 1, resource: tempB.createView() },
        { binding: 2, resource: { buffer: heightParamsBuf } },
      ],
    });
    const htVPass = encoder.beginComputePass();
    htVPass.setPipeline(this.shadowBlurVPipeline);
    htVPass.setBindGroup(0, htVBG);
    htVPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    htVPass.end();

    // Passes 5–6: Optional extra blur for softness
    let heightTex: GPUTexture = tempB;
    if (softness > 0) {
      const softR = Math.max(1, Math.round(softness / 2));
      const softParamsBuf = createUniformBuffer(device, 16);
      writeUniformBuffer(
        device,
        softParamsBuf,
        new Uint32Array([softR, 0, 0, 0]),
      );

      const sHBG = device.createBindGroup({
        layout: this.shadowBlurHPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: tempB.createView() },
          { binding: 1, resource: tempA.createView() },
          { binding: 2, resource: { buffer: softParamsBuf } },
        ],
      });
      const sHPass = encoder.beginComputePass();
      sHPass.setPipeline(this.shadowBlurHPipeline);
      sHPass.setBindGroup(0, sHBG);
      sHPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      sHPass.end();

      const sVBG = device.createBindGroup({
        layout: this.shadowBlurVPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: tempA.createView() },
          { binding: 1, resource: tempB.createView() },
          { binding: 2, resource: { buffer: softParamsBuf } },
        ],
      });
      const sVPass = encoder.beginComputePass();
      sVPass.setPipeline(this.shadowBlurVPipeline);
      sVPass.setBindGroup(0, sVBG);
      sVPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      sVPass.end();

      heightTex = tempB;
      this.pendingDestroyBuffers.push(softParamsBuf);
    }

    // Composite pass: use height field gradient to compute bevel highlight/shadow
    const compBuf = new ArrayBuffer(16);
    const cf = new Float32Array(compBuf);
    cf[0] = strength / 100;
    cf[1] = angle;
    // The height ramp rises by ~1.0 over `2*heightR` pixels, so per-pixel slope is
    // ~1/(2*heightR). Scaling the gradient by 2*heightR gives a normalised slope of
    // ~1.0 (≈45° normal tilt) at the steepest part of the ramp regardless of width.
    cf[2] = 2 * heightR;

    const compParamsBuf = createUniformBuffer(device, 16);
    device.queue.writeBuffer(compParamsBuf, 0, compBuf);

    const maskFlagsArr = new Uint32Array(8);
    maskFlagsArr[0] = selMaskLayer ? 1 : 0;
    const maskFlagsBuf = createUniformBuffer(device, 32);
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsArr);

    const dummyMask = selMaskLayer?.texture ?? srcTex;

    const compBG = device.createBindGroup({
      layout: this.bevelCompositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: heightTex.createView() },
        { binding: 2, resource: dstTex.createView() },
        { binding: 3, resource: { buffer: compParamsBuf } },
        { binding: 4, resource: dummyMask.createView() },
        { binding: 5, resource: { buffer: maskFlagsBuf } },
      ],
    });
    const compPass = encoder.beginComputePass();
    compPass.setPipeline(this.bevelCompositePipeline);
    compPass.setBindGroup(0, compBG);
    compPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    compPass.end();

    this.pendingDestroyBuffers.push(
      copyParamsBuf,
      heightParamsBuf,
      compParamsBuf,
      maskFlagsBuf,
    );
  }

  // ─── Inner Shadow ─────────────────────────────────────────────────────────────

  private innerShadowTexCache: { tempA: GPUTexture; tempB: GPUTexture } | null =
    null;

  private ensureInnerShadowTextures(): {
    tempA: GPUTexture;
    tempB: GPUTexture;
  } {
    this.innerShadowUsedThisFrame = true;
    if (this.innerShadowTexCache) return this.innerShadowTexCache;
    const { device, pixelWidth: w, pixelHeight: h } = this;
    const usage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC;
    const make = (): GPUTexture =>
      createTrackedTexture(device, {
        size: { width: w, height: h },
        format: "rgba8unorm",
        usage,
      });
    this.innerShadowTexCache = { tempA: make(), tempB: make() };
    return this.innerShadowTexCache;
  }

  private encodeInnerShadowPass(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    colorR: number,
    colorG: number,
    colorB: number,
    colorA: number,
    opacity: number,
    offsetX: number,
    offsetY: number,
    spread: number,
    softness: number,
    selMaskLayer: GpuLayer | undefined,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this;
    const { tempA, tempB } = this.ensureInnerShadowTextures();

    // Erode source alpha inward to get the interior region
    const erodeR = Math.round(spread);
    const blurR = softness > 0 ? Math.max(1, Math.round(softness * 0.577)) : 0;

    const erodeParamsBuf = createUniformBuffer(device, 16);
    writeUniformBuffer(
      device,
      erodeParamsBuf,
      new Uint32Array([erodeR, 0, 0, 0]),
    );

    // Pass 1: ErodeH (srcTex.a → tempA.r)
    const erodeHBG = device.createBindGroup({
      layout: this.outlineErodeHPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: tempA.createView() },
        { binding: 2, resource: { buffer: erodeParamsBuf } },
      ],
    });
    const erodeHPass = encoder.beginComputePass();
    erodeHPass.setPipeline(this.outlineErodeHPipeline);
    erodeHPass.setBindGroup(0, erodeHBG);
    erodeHPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    erodeHPass.end();

    // Pass 2: ErodeV (tempA.r → tempB.r)
    const erodeVBG = device.createBindGroup({
      layout: this.outlineErodeVPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tempA.createView() },
        { binding: 1, resource: tempB.createView() },
        { binding: 2, resource: { buffer: erodeParamsBuf } },
      ],
    });
    const erodeVPass = encoder.beginComputePass();
    erodeVPass.setPipeline(this.outlineErodeVPipeline);
    erodeVPass.setBindGroup(0, erodeVBG);
    erodeVPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    erodeVPass.end();

    // Passes 3–8: 3× H+V box blur
    let maskTex: GPUTexture = tempB;
    if (softness > 0) {
      const blurParamsBuf = createUniformBuffer(device, 16);
      writeUniformBuffer(
        device,
        blurParamsBuf,
        new Uint32Array([blurR, 0, 0, 0]),
      );

      let src = tempB;
      let dst = tempA;
      for (let i = 0; i < 3; i++) {
        const hBG = device.createBindGroup({
          layout: this.shadowBlurHPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: src.createView() },
            { binding: 1, resource: dst.createView() },
            { binding: 2, resource: { buffer: blurParamsBuf } },
          ],
        });
        const hPass = encoder.beginComputePass();
        hPass.setPipeline(this.shadowBlurHPipeline);
        hPass.setBindGroup(0, hBG);
        hPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
        hPass.end();
        [src, dst] = [dst, src];

        const vBG = device.createBindGroup({
          layout: this.shadowBlurVPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: src.createView() },
            { binding: 1, resource: dst.createView() },
            { binding: 2, resource: { buffer: blurParamsBuf } },
          ],
        });
        const vPass = encoder.beginComputePass();
        vPass.setPipeline(this.shadowBlurVPipeline);
        vPass.setBindGroup(0, vBG);
        vPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
        vPass.end();
        [src, dst] = [dst, src];
      }
      maskTex = src;
      this.pendingDestroyBuffers.push(blurParamsBuf);
    }

    // Composite pass
    const compBuf = new ArrayBuffer(32);
    const cf = new Float32Array(compBuf);
    const ci = new Int32Array(compBuf);
    cf[0] = colorR;
    cf[1] = colorG;
    cf[2] = colorB;
    cf[3] = colorA;
    cf[4] = opacity;
    ci[5] = offsetX;
    ci[6] = offsetY;

    const compParamsBuf = createUniformBuffer(device, 32);
    device.queue.writeBuffer(compParamsBuf, 0, compBuf);

    const maskFlagsArr = new Uint32Array(8);
    maskFlagsArr[0] = selMaskLayer ? 1 : 0;
    const maskFlagsBuf = createUniformBuffer(device, 32);
    writeUniformBuffer(device, maskFlagsBuf, maskFlagsArr);

    const dummyMask = selMaskLayer?.texture ?? srcTex;

    const compBG = device.createBindGroup({
      layout: this.innerShadowCompositePipeline.getBindGroupLayout(0),
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
    compPass.setPipeline(this.innerShadowCompositePipeline);
    compPass.setBindGroup(0, compBG);
    compPass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    compPass.end();

    this.pendingDestroyBuffers.push(
      erodeParamsBuf,
      compParamsBuf,
      maskFlagsBuf,
    );
  }
}
