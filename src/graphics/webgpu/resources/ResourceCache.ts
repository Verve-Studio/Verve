import type { GpuDevice } from "../device/GpuDevice";
import {
  createUniformBuffer,
  createVertexBuffer,
  writeUniformBuffer,
} from "../utils";
import { QUAD_POSITIONS, QUAD_UVS } from "./quadGeometry";
import {
  createCompositePipeline,
  createCompositeBindGroupLayout,
} from "./pipelines/composite";
import { createCheckerPipeline } from "./pipelines/checker";
import {
  createHdrBlitPipeline,
  createHdrBlitBindGroupLayout,
} from "./pipelines/hdrBlit";
import { floatToHalf16 } from "./halfFloat";

/**
 * Owns long-lived GPU resources that don't depend on per-frame state:
 * pipelines, bind-group layouts, samplers, the static UV quad, the
 * canvas-sized vertex buffer, and the identity LUT placeholders used by
 * the HDR blit when no view transform is active.
 *
 * The renderer composes this cache; consumers (frame execution, presenter)
 * borrow references but do not own them.
 */
export class ResourceCache {
  // Pipelines
  readonly compositePipeline: GPURenderPipeline;
  readonly compositeBGL: GPUBindGroupLayout;
  readonly checkerPipeline: GPURenderPipeline;
  readonly hdrBlitPipeline: GPURenderPipeline;
  readonly hdrBlitBGL: GPUBindGroupLayout;

  // Samplers
  readonly nearestSampler: GPUSampler;
  readonly lutBlitSampler: GPUSampler;
  /** Final swap-chain blit sampler. When the device has the
   *  `float32-filterable` feature, this is `min: linear, mag: nearest`
   *  so we get bilinear downsampling at zoom < 1 (kills the jaggies on
   *  overview views) AND crisp 1:1 / upscaled rendering at zoom ≥ 1.
   *  Without that feature, falls back to a nearest sampler (same object
   *  as `nearestSampler`) — required because rgba32float composites
   *  can't be filtered. WebGPU picks min vs mag per fragment from the
   *  UV derivative, so no zoom plumbing is needed at the call site. */
  readonly screenBlitSampler: GPUSampler;

  // Shared geometry
  readonly texCoordBuffer: GPUBuffer;
  readonly canvasQuadVertBuf: GPUBuffer;

  // Shared per-frame uniform buffers
  readonly frameUniformBuf: GPUBuffer; // [w, h, 0, 0]
  readonly checkerUniformBuf: GPUBuffer; // 64 bytes
  readonly hdrUniformBuffer: GPUBuffer; // 32 bytes

  // Pre-built checker bind group (single static binding to checker uniforms)
  readonly checkerBindGroup: GPUBindGroup;

  // Identity LUT placeholders — kept always-bound so the hdr-blit BGL stays static
  readonly identityLutCube: GPUTexture;
  readonly identityLutShaper: GPUTexture;
  readonly identityLutCubeView: GPUTextureView;
  readonly identityLutShaperView: GPUTextureView;

  constructor(
    gpu: GpuDevice,
    pixelWidth: number,
    pixelHeight: number,
    internalFormat: GPUTextureFormat,
  ) {
    const device = gpu.device;
    const canvasFormat = gpu.canvasFormat;

    this.nearestSampler = device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.lutBlitSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.screenBlitSampler = gpu.hasFloat32Filterable
      ? device.createSampler({
          // See field doc above: nearest mag keeps pixel-perfect rendering
          // at zoom ≥ 1, linear min smooths the downscale at zoom < 1.
          magFilter: "nearest",
          minFilter: "linear",
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
        })
      : this.nearestSampler; // graceful fall-through on adapters without filterable f32

    this.texCoordBuffer = createVertexBuffer(device, QUAD_UVS);
    this.canvasQuadVertBuf = createVertexBuffer(
      device,
      QUAD_POSITIONS(pixelWidth, pixelHeight),
    );

    this.frameUniformBuf = createUniformBuffer(device, 16);
    writeUniformBuffer(
      device,
      this.frameUniformBuf,
      new Float32Array([pixelWidth, pixelHeight, 0, 0]),
    );

    const cuData = new DataView(new ArrayBuffer(64));
    cuData.setFloat32(0, 8.0, true); // tileSize
    cuData.setFloat32(16, 0.549, true);
    cuData.setFloat32(20, 0.549, true);
    cuData.setFloat32(24, 0.549, true); // colorA
    cuData.setFloat32(28, 0.0, true);
    cuData.setFloat32(32, 0.392, true);
    cuData.setFloat32(36, 0.392, true);
    cuData.setFloat32(40, 0.392, true); // colorB
    cuData.setFloat32(44, 0.0, true);
    cuData.setFloat32(48, pixelWidth, true);
    cuData.setFloat32(52, pixelHeight, true); // resolution
    this.checkerUniformBuf = createUniformBuffer(device, 64);
    writeUniformBuffer(device, this.checkerUniformBuf, cuData.buffer);

    this.compositeBGL = createCompositeBindGroupLayout(device);
    this.hdrBlitBGL = createHdrBlitBindGroupLayout(
      device,
      gpu.hasFloat32Filterable,
    );
    this.compositePipeline = createCompositePipeline(
      device,
      internalFormat,
      this.compositeBGL,
    );
    this.checkerPipeline = createCheckerPipeline(device, canvasFormat);
    this.hdrBlitPipeline = createHdrBlitPipeline(
      device,
      canvasFormat,
      this.hdrBlitBGL,
    );

    this.hdrUniformBuffer = createUniformBuffer(device, 32);
    // Initialize: exposureLinear=1.0, isFp32=0.0, operator=1 (Reinhard),
    // hasViewLut=0, cubeSize=1, lutInSpace=0, lutOutSpace=0, hasShaper=0.
    const initData = new ArrayBuffer(32);
    const initView = new DataView(initData);
    initView.setFloat32(0, 1.0, true);
    initView.setFloat32(4, 0.0, true);
    initView.setUint32(8, 1, true);
    initView.setUint32(12, 0, true);
    initView.setFloat32(16, 1, true);
    initView.setUint32(20, 0, true);
    initView.setUint32(24, 0, true);
    initView.setUint32(28, 0, true);
    writeUniformBuffer(device, this.hdrUniformBuffer, initData);

    this.checkerBindGroup = device.createBindGroup({
      layout: this.checkerPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.checkerUniformBuf } }],
    });

    // Identity LUT placeholders
    this.identityLutCube = device.createTexture({
      size: { width: 2, height: 4, depthOrArrayLayers: 1 },
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.identityLutShaper = device.createTexture({
      size: { width: 2, height: 3, depthOrArrayLayers: 1 },
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const cubeData = new Uint16Array(2 * 4 * 4);
    for (let bi = 0; bi < 2; bi++) {
      for (let gi = 0; gi < 2; gi++) {
        for (let ri = 0; ri < 2; ri++) {
          const off = ((bi * 2 + gi) * 2 + ri) * 4;
          cubeData[off] = floatToHalf16(ri);
          cubeData[off + 1] = floatToHalf16(gi);
          cubeData[off + 2] = floatToHalf16(bi);
          cubeData[off + 3] = floatToHalf16(1);
        }
      }
    }
    device.queue.writeTexture(
      { texture: this.identityLutCube },
      cubeData.buffer,
      { bytesPerRow: 2 * 4 * 2, rowsPerImage: 4 },
      { width: 2, height: 4, depthOrArrayLayers: 1 },
    );
    const shaperData = new Uint16Array(2 * 3 * 4);
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 2; i++) {
        const o = (row * 2 + i) * 4;
        const v = floatToHalf16(i);
        shaperData[o] = v;
        shaperData[o + 1] = v;
        shaperData[o + 2] = v;
        shaperData[o + 3] = floatToHalf16(1);
      }
    }
    device.queue.writeTexture(
      { texture: this.identityLutShaper },
      shaperData.buffer,
      { bytesPerRow: 2 * 4 * 2, rowsPerImage: 3 },
      { width: 2, height: 3, depthOrArrayLayers: 1 },
    );
    this.identityLutCubeView = this.identityLutCube.createView();
    this.identityLutShaperView = this.identityLutShaper.createView();
  }
}
