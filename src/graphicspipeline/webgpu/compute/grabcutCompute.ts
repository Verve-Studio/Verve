import { FILTER_GRABCUT_NLINKS_COMPUTE } from "../shaders/compute/grabcut/nlinks";
import { FILTER_GRABCUT_DATATERMS_COMPUTE } from "../shaders/compute/grabcut/dataterms";
import {
  createUniformBuffer,
  writeUniformBuffer,
  createReadbackBuffer,
} from "../utils";
import {
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";

const K = 5;
const GAMMA = 75.0; // must match grabcut.cpp

class GrabCutComputeEngine {
  private readonly device: GPUDevice;
  private readonly nlinksPipeline: GPUComputePipeline;
  private readonly datatermsPipeline: GPUComputePipeline;

  private constructor(device: GPUDevice) {
    this.device = device;
    this.nlinksPipeline = this.makePipeline(
      FILTER_GRABCUT_NLINKS_COMPUTE,
      "cs_nlinks",
    );
    this.datatermsPipeline = this.makePipeline(
      FILTER_GRABCUT_DATATERMS_COMPUTE,
      "cs_dataterms",
    );
  }

  static create(device: GPUDevice): GrabCutComputeEngine {
    return new GrabCutComputeEngine(device);
  }

  destroy(): void {}

  private makePipeline(wgsl: string, entryPoint: string): GPUComputePipeline {
    const m = this.device.createShaderModule({ code: wgsl });
    return this.device.createComputePipeline({
      layout: "auto",
      compute: { module: m, entryPoint },
    });
  }

  async computeNLinks(
    rgba: Uint8Array,
    w: number,
    h: number,
    beta: number,
  ): Promise<{ hW: Float32Array; vW: Float32Array }> {
    const device = this.device;

    const srcTex = createTrackedTexture(device, {
      size: { width: w, height: h },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: srcTex },
      rgba as Uint8Array<ArrayBuffer>,
      { bytesPerRow: w * 4, rowsPerImage: h },
      { width: w, height: h },
    );

    const hLen = (w - 1) * h;
    const vLen = w * (h - 1);
    const hBytes = Math.max(hLen * 4, 4);
    const vBytes = Math.max(vLen * 4, 4);

    const hBuf = device.createBuffer({
      size: hBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const vBuf = device.createBuffer({
      size: vBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const paramsBuf = createUniformBuffer(device, 16);
    const paramsData = new ArrayBuffer(16);
    const dv = new DataView(paramsData);
    dv.setUint32(0, w, true);
    dv.setUint32(4, h, true);
    dv.setFloat32(8, beta, true);
    dv.setFloat32(12, GAMMA, true);
    writeUniformBuffer(device, paramsBuf, paramsData);

    const bindGroup = device.createBindGroup({
      layout: this.nlinksPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: { buffer: hBuf } },
        { binding: 2, resource: { buffer: vBuf } },
        { binding: 3, resource: { buffer: paramsBuf } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.nlinksPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();

    const hReadbuf = createReadbackBuffer(device, hBytes);
    const vReadbuf = createReadbackBuffer(device, vBytes);
    encoder.copyBufferToBuffer(hBuf, 0, hReadbuf, 0, hBytes);
    encoder.copyBufferToBuffer(vBuf, 0, vReadbuf, 0, vBytes);
    device.queue.submit([encoder.finish()]);

    await Promise.all([
      hReadbuf.mapAsync(GPUMapMode.READ),
      vReadbuf.mapAsync(GPUMapMode.READ),
    ]);
    const hW =
      hLen > 0
        ? new Float32Array(hReadbuf.getMappedRange(0, hLen * 4).slice(0))
        : new Float32Array(0);
    const vW =
      vLen > 0
        ? new Float32Array(vReadbuf.getMappedRange(0, vLen * 4).slice(0))
        : new Float32Array(0);
    hReadbuf.unmap();
    vReadbuf.unmap();

    destroyTrackedTexture(srcTex);
    hBuf.destroy();
    vBuf.destroy();
    paramsBuf.destroy();
    hReadbuf.destroy();
    vReadbuf.destroy();

    return { hW, vW };
  }

  async computeDataTerms(
    rgba: Uint8Array,
    trimap: Uint8Array,
    w: number,
    h: number,
    gmmParams: Float32Array,
  ): Promise<{ capS: Float32Array; capT: Float32Array }> {
    const device = this.device;
    const n = w * h;

    const srcTex = createTrackedTexture(device, {
      size: { width: w, height: h },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: srcTex },
      rgba as Uint8Array<ArrayBuffer>,
      { bytesPerRow: w * 4, rowsPerImage: h },
      { width: w, height: h },
    );

    const trimapTex = createTrackedTexture(device, {
      size: { width: w, height: h },
      format: "r8uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: trimapTex },
      trimap as Uint8Array<ArrayBuffer>,
      { bytesPerRow: w, rowsPerImage: h },
      { width: w, height: h },
    );

    const dimsBuf = createUniformBuffer(device, 16);
    writeUniformBuffer(device, dimsBuf, new Uint32Array([w, h, 0, 0]));

    const gmmBytes = 2 * K * 20 * 4;
    if (gmmParams.byteLength !== gmmBytes) {
      throw new Error(
        `gmmParams length mismatch: expected ${gmmBytes} bytes, got ${gmmParams.byteLength}`,
      );
    }
    const gmmBuf = createUniformBuffer(device, gmmBytes);
    device.queue.writeBuffer(gmmBuf, 0, gmmParams as Float32Array<ArrayBuffer>);

    const capBytes = n * 4;
    const capSBuf = device.createBuffer({
      size: capBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const capTBuf = device.createBuffer({
      size: capBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const bindGroup = device.createBindGroup({
      layout: this.datatermsPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: trimapTex.createView() },
        { binding: 2, resource: { buffer: dimsBuf } },
        { binding: 3, resource: { buffer: gmmBuf } },
        { binding: 4, resource: { buffer: capSBuf } },
        { binding: 5, resource: { buffer: capTBuf } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.datatermsPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();

    const capSReadbuf = createReadbackBuffer(device, capBytes);
    const capTReadbuf = createReadbackBuffer(device, capBytes);
    encoder.copyBufferToBuffer(capSBuf, 0, capSReadbuf, 0, capBytes);
    encoder.copyBufferToBuffer(capTBuf, 0, capTReadbuf, 0, capBytes);
    device.queue.submit([encoder.finish()]);

    await Promise.all([
      capSReadbuf.mapAsync(GPUMapMode.READ),
      capTReadbuf.mapAsync(GPUMapMode.READ),
    ]);
    const capS = new Float32Array(capSReadbuf.getMappedRange().slice(0));
    const capT = new Float32Array(capTReadbuf.getMappedRange().slice(0));
    capSReadbuf.unmap();
    capTReadbuf.unmap();

    destroyTrackedTexture(srcTex);
    destroyTrackedTexture(trimapTex);
    dimsBuf.destroy();
    gmmBuf.destroy();
    capSBuf.destroy();
    capTBuf.destroy();
    capSReadbuf.destroy();
    capTReadbuf.destroy();

    return { capS, capT };
  }
}

let _engine: GrabCutComputeEngine | null = null;

export function initGrabCutCompute(device: GPUDevice): void {
  _engine?.destroy();
  _engine = GrabCutComputeEngine.create(device);
}

export function isGrabCutComputeReady(): boolean {
  return _engine !== null;
}

export async function gpuComputeNLinks(
  rgba: Uint8Array,
  w: number,
  h: number,
  beta: number,
): Promise<{ hW: Float32Array; vW: Float32Array }> {
  return _engine!.computeNLinks(rgba, w, h, beta);
}

export async function gpuComputeDataTerms(
  rgba: Uint8Array,
  trimap: Uint8Array,
  w: number,
  h: number,
  gmmParams: Float32Array,
): Promise<{ capS: Float32Array; capT: Float32Array }> {
  return _engine!.computeDataTerms(rgba, trimap, w, h, gmmParams);
}
