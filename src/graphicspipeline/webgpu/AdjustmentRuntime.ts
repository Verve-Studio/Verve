import {
  createUniformBuffer,
  writeUniformBuffer,
} from "./utils";
import { getShader } from "@/core/effects/shaderLoader";
import type { GpuLayer } from "./types";

// ─── Pipeline pair type ──────────────────────────────────────────────────────

export type AdjPipelinePair = {
  s8: GPURenderPipeline;
  f32: GPURenderPipeline;
  bgl: GPUBindGroupLayout;
};

// ─── Binding kinds ───────────────────────────────────────────────────────────

/**
 * Binding kinds for explicit BGL construction. Texture bindings default to
 * 'unfilterable-float' so they accept rgba32float source layer textures
 * (which only support 'unfilterable-float' sampling).
 */
export type AdjBinding =
  | "tex"
  | "tex-f"
  | "sampler"
  | "sampler-f"
  | "uniform"
  | "storage";

/** Standard adjustment binding pattern: srcTex, sampler, params, selMask, maskFlags. */
export const STD_BINDINGS: AdjBinding[] = [
  "tex",
  "sampler",
  "uniform",
  "tex",
  "uniform",
];

function buildBGL(
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

// ─── AdjustmentRuntime ───────────────────────────────────────────────────────

/**
 * Generic per-frame service used by adjustment / effect Effects to encode
 * WebGPU work. Owns lazy pipeline caches, samplers, and the pending-destroy
 * list. Effects fetch pipelines by `(shaderName, fragmentEntry, [bindings | format])`
 * keys instead of storing them on per-effect fields.
 */
export class AdjustmentRuntime {
  readonly device: GPUDevice;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly adjSampler: GPUSampler;
  readonly lutSampler: GPUSampler;

  /** Buffers accumulated during command encoding; flushed after submit. */
  pendingDestroyBuffers: GPUBuffer[] = [];

  private readonly modules = new Map<string, GPUShaderModule>();
  private readonly pairs = new Map<string, AdjPipelinePair>();
  private readonly singlesWithBGL = new Map<
    string,
    { pipeline: GPURenderPipeline; bgl: GPUBindGroupLayout }
  >();
  private readonly singlesAuto = new Map<string, GPURenderPipeline>();
  private readonly computes = new Map<string, GPUComputePipeline>();

  constructor(device: GPUDevice, pixelWidth: number, pixelHeight: number) {
    this.device = device;
    this.pixelWidth = pixelWidth;
    this.pixelHeight = pixelHeight;
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

  destroy(): void {
    // Pipelines have no explicit destroy; GC handles them with the device.
    this.modules.clear();
    this.pairs.clear();
    this.singlesWithBGL.clear();
    this.singlesAuto.clear();
    this.computes.clear();
  }

  // ─── Module / pipeline cache ──────────────────────────────────────────────

  private getModule(shaderName: string): GPUShaderModule {
    let mod = this.modules.get(shaderName);
    if (!mod) {
      mod = this.device.createShaderModule({ code: getShader(shaderName) });
      this.modules.set(shaderName, mod);
    }
    return mod;
  }

  private buildRenderPipeline(
    module: GPUShaderModule,
    fsEntry: string,
    format: GPUTextureFormat,
    bgl: GPUBindGroupLayout,
  ): GPURenderPipeline {
    return this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: { module, entryPoint: "vs_adj" },
      fragment: { module, entryPoint: fsEntry, targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
  }

  private buildRenderPipelineAuto(
    module: GPUShaderModule,
    fsEntry: string,
    format: GPUTextureFormat,
  ): GPURenderPipeline {
    return this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs_adj" },
      fragment: { module, entryPoint: fsEntry, targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
  }

  /** Cached s8+f32 render pipeline pair with explicit BGL keyed by `${shaderName}|${fsEntry}|${bindings}`. */
  getRenderPipelinePair(
    shaderName: string,
    fsEntry: string,
    bindings: AdjBinding[],
  ): AdjPipelinePair {
    const key = `${shaderName}|${fsEntry}|${bindings.join(",")}`;
    let pair = this.pairs.get(key);
    if (!pair) {
      const module = this.getModule(shaderName);
      const bgl = buildBGL(this.device, bindings);
      pair = {
        s8: this.buildRenderPipeline(module, fsEntry, "rgba8unorm", bgl),
        f32: this.buildRenderPipeline(module, fsEntry, "rgba32float", bgl),
        bgl,
      };
      this.pairs.set(key, pair);
    }
    return pair;
  }

  /** Cached single-format render pipeline with explicit BGL. */
  getRenderPipelineWithBGL(
    shaderName: string,
    fsEntry: string,
    format: GPUTextureFormat,
    bindings: AdjBinding[],
  ): { pipeline: GPURenderPipeline; bgl: GPUBindGroupLayout } {
    const key = `${shaderName}|${fsEntry}|${format}|${bindings.join(",")}`;
    let entry = this.singlesWithBGL.get(key);
    if (!entry) {
      const module = this.getModule(shaderName);
      const bgl = buildBGL(this.device, bindings);
      entry = {
        pipeline: this.buildRenderPipeline(module, fsEntry, format, bgl),
        bgl,
      };
      this.singlesWithBGL.set(key, entry);
    }
    return entry;
  }

  /** Cached single-format render pipeline with auto layout. */
  getRenderPipelineAuto(
    shaderName: string,
    fsEntry: string,
    format: GPUTextureFormat,
  ): GPURenderPipeline {
    const key = `${shaderName}|${fsEntry}|${format}|auto`;
    let pipeline = this.singlesAuto.get(key);
    if (!pipeline) {
      const module = this.getModule(shaderName);
      pipeline = this.buildRenderPipelineAuto(module, fsEntry, format);
      this.singlesAuto.set(key, pipeline);
    }
    return pipeline;
  }

  /** Cached compute pipeline. */
  getComputePipeline(
    shaderName: string,
    entryPoint: string,
  ): GPUComputePipeline {
    const key = `${shaderName}|${entryPoint}`;
    let pipeline = this.computes.get(key);
    if (!pipeline) {
      const module = this.getModule(shaderName);
      pipeline = this.device.createComputePipeline({
        layout: "auto",
        compute: { module, entryPoint },
      });
      this.computes.set(key, pipeline);
    }
    return pipeline;
  }

  /** Pick s8 vs f32 pipeline based on destination format. */
  selectPipeline(
    pair: AdjPipelinePair,
    format: GPUTextureFormat,
  ): GPURenderPipeline {
    return format === "rgba32float" ? pair.f32 : pair.s8;
  }

  // ─── Buffer helpers ──────────────────────────────────────────────────────

  /** One-shot uniform buffer; auto-tracked for destroy at end-of-frame. */
  makeParamsBuf(data: Uint32Array | Float32Array | ArrayBuffer): GPUBuffer {
    const byteLen =
      data instanceof ArrayBuffer
        ? data.byteLength
        : (data as Uint32Array).byteLength;
    const aligned = Math.max(16, Math.ceil(byteLen / 16) * 16);
    const buf = createUniformBuffer(this.device, aligned);
    if (data instanceof ArrayBuffer) {
      this.device.queue.writeBuffer(buf, 0, data);
    } else {
      writeUniformBuffer(this.device, buf, data);
    }
    this.pendingDestroyBuffers.push(buf);
    return buf;
  }

  /** Build the standard 32-byte mask-flags uniform buffer. */
  makeMaskFlagsBuf(present: boolean): GPUBuffer {
    const data = new Uint32Array(8);
    data[0] = present ? 1 : 0;
    const buf = createUniformBuffer(this.device, 32);
    writeUniformBuffer(this.device, buf, data);
    this.pendingDestroyBuffers.push(buf);
    return buf;
  }

  // ─── Render pass helpers ────────────────────────────────────────────────

  /** Generic fullscreen render pass into dstTex. */
  encodeRenderPass(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    bgl: GPUBindGroupLayout,
    dstTex: GPUTexture,
    entries: GPUBindGroupEntry[],
  ): void {
    const bindGroup = this.device.createBindGroup({ layout: bgl, entries });
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

  /** Standard adj pass — uniforms + selMask + maskFlags + adjSampler. */
  encodeStdAdjRenderPass(
    encoder: GPUCommandEncoder,
    pair: AdjPipelinePair,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    format: GPUTextureFormat,
    paramsBuffer: ArrayBuffer,
    selMaskLayer?: GpuLayer,
  ): void {
    const pipeline = this.selectPipeline(pair, format);
    const paramsBuf = this.makeParamsBuf(paramsBuffer);
    const maskFlagsBuf = this.makeMaskFlagsBuf(!!selMaskLayer);
    const dummyMask = selMaskLayer?.texture ?? srcTex;

    this.encodeRenderPass(encoder, pipeline, pair.bgl, dstTex, [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: this.adjSampler },
      { binding: 2, resource: { buffer: paramsBuf } },
      { binding: 3, resource: dummyMask.createView() },
      { binding: 4, resource: { buffer: maskFlagsBuf } },
    ]);
  }

  flushPendingDestroys(): void {
    for (const buf of this.pendingDestroyBuffers) buf.destroy();
    this.pendingDestroyBuffers = [];
  }
}
