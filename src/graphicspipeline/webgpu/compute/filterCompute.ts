import { getShader } from "@/core/effects/shaderLoader";
import { createUniformBuffer, writeUniformBuffer } from "../utils";
import {
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";

// ─── Pipeline pair type ───────────────────────────────────────────────────────

export type FilterPipelinePair = {
  s8: GPURenderPipeline;
  f32: GPURenderPipeline;
};

// ─── FilterRuntime ────────────────────────────────────────────────────────────

/**
 * Generic per-frame service used by filter Effects to encode WebGPU work.
 * Owns a shared rgba8 scratch texture, lazy pipeline cache, and pending-destroy
 * lists. Effects fetch pipelines by `(shaderName, fragmentEntry)` rather than
 * storing them on per-effect fields.
 */
export class FilterRuntime {
  readonly device: GPUDevice;
  readonly intermediate: GPUTexture;
  pendingDestroyBuffers: GPUBuffer[] = [];
  pendingDestroyTextures: GPUTexture[] = [];

  private readonly modules = new Map<string, GPUShaderModule>();
  private readonly pairs = new Map<string, FilterPipelinePair>();
  private readonly singles = new Map<string, GPURenderPipeline>();

  constructor(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat = "rgba8unorm",
  ) {
    this.device = device;
    this.intermediate = createTrackedTexture(device, {
      size: { width, height },
      format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  destroy(): void {
    destroyTrackedTexture(this.intermediate);
  }

  private getModule(shaderName: string): GPUShaderModule {
    let mod = this.modules.get(shaderName);
    if (!mod) {
      mod = this.device.createShaderModule({ code: getShader(shaderName) });
      this.modules.set(shaderName, mod);
    }
    return mod;
  }

  private buildPipeline(
    module: GPUShaderModule,
    fragmentEntry: string,
    format: GPUTextureFormat,
  ): GPURenderPipeline {
    return this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs_adj" },
      fragment: {
        module,
        entryPoint: fragmentEntry,
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  /** Cached s8+f32 pipeline pair keyed by `${shaderName}|${fragmentEntry}`. */
  getPipelinePair(
    shaderName: string,
    fragmentEntry: string,
  ): FilterPipelinePair {
    const key = `${shaderName}|${fragmentEntry}`;
    let pair = this.pairs.get(key);
    if (!pair) {
      const module = this.getModule(shaderName);
      pair = {
        s8: this.buildPipeline(module, fragmentEntry, "rgba8unorm"),
        f32: this.buildPipeline(module, fragmentEntry, "rgba32float"),
      };
      this.pairs.set(key, pair);
    }
    return pair;
  }

  /** Cached single-format pipeline keyed by `${shaderName}|${fragmentEntry}|${format}`. */
  getPipelineSingle(
    shaderName: string,
    fragmentEntry: string,
    format: GPUTextureFormat,
  ): GPURenderPipeline {
    const key = `${shaderName}|${fragmentEntry}|${format}`;
    let pipeline = this.singles.get(key);
    if (!pipeline) {
      const module = this.getModule(shaderName);
      pipeline = this.buildPipeline(module, fragmentEntry, format);
      this.singles.set(key, pipeline);
    }
    return pipeline;
  }

  /** Pick s8 vs f32 based on the destination texture format. */
  selectPipeline(
    pair: FilterPipelinePair,
    dstTex: GPUTexture,
  ): GPURenderPipeline {
    return dstTex.format === "rgba32float" ? pair.f32 : pair.s8;
  }

  /** One-shot uniform buffer; auto-tracked for destroy at end-of-frame. */
  makeParamsBuf(data: Uint32Array | Float32Array | ArrayBuffer): GPUBuffer {
    const byteLen =
      data instanceof ArrayBuffer
        ? data.byteLength
        : (data as Uint32Array).byteLength;
    const buf = createUniformBuffer(this.device, Math.max(byteLen, 16));
    writeUniformBuffer(
      this.device,
      buf,
      data instanceof ArrayBuffer ? data : (data as Uint32Array),
    );
    this.pendingDestroyBuffers.push(buf);
    return buf;
  }

  /** Auto-tracked transient rgba8unorm render target. */
  makeRgba8Tex(w: number, h: number): GPUTexture {
    const tex = createTrackedTexture(this.device, {
      size: { width: w, height: h },
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.pendingDestroyTextures.push(tex);
    return tex;
  }

  /** Auto-tracked transient rgba16float render target. */
  makeRgba16FloatTex(w: number, h: number): GPUTexture {
    const tex = createTrackedTexture(this.device, {
      size: { width: w, height: h },
      format: "rgba16float",
      usage:
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.pendingDestroyTextures.push(tex);
    return tex;
  }

  /** Encode a fullscreen render pass into dstTex. */
  encodeRenderPass(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    entries: GPUBindGroupEntry[],
    dstTex: GPUTexture,
  ): void {
    const bg = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
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
    pass.setBindGroup(0, bg);
    pass.draw(6);
    pass.end();
  }

  flushPendingDestroys(): void {
    for (const buf of this.pendingDestroyBuffers) buf.destroy();
    this.pendingDestroyBuffers = [];
    for (const tex of this.pendingDestroyTextures) destroyTrackedTexture(tex);
    this.pendingDestroyTextures = [];
  }
}

// ─── Module-level singleton ───────────────────────────────────────────────────

let _runtime: FilterRuntime | null = null;

export function initFilterCompute(
  device: GPUDevice,
  width: number,
  height: number,
  format: GPUTextureFormat = "rgba8unorm",
): void {
  _runtime?.destroy();
  _runtime = new FilterRuntime(device, width, height, format);
}

export function destroyFilterCompute(): void {
  _runtime?.destroy();
  _runtime = null;
}

export function getFilterRuntime(): FilterRuntime {
  if (!_runtime) {
    throw new Error("FilterRuntime not initialised");
  }
  return _runtime;
}

export function flushFilterComputeDestroys(): void {
  _runtime?.flushPendingDestroys();
}
