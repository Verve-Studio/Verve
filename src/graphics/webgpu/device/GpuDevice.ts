import { WebGPUUnavailableError } from "../types";

/**
 * Owns the bottom-most WebGPU infrastructure: adapter, device, canvas context,
 * swap-chain configuration, and lost-handling. Pure infrastructure — no
 * domain knowledge of layers, pipelines, or rendering passes.
 */
export class GpuDevice {
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly canvasFormat: GPUTextureFormat;
  readonly canvas: HTMLCanvasElement;

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    canvasFormat: GPUTextureFormat,
    canvas: HTMLCanvasElement,
  ) {
    this.device = device;
    this.context = context;
    this.canvasFormat = canvasFormat;
    this.canvas = canvas;
  }

  static async create(canvas: HTMLCanvasElement): Promise<GpuDevice> {
    if (!navigator.gpu) {
      throw new WebGPUUnavailableError(
        "WebGPU is not available in this environment. Verve requires WebGPU to run.",
      );
    }
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) {
      throw new WebGPUUnavailableError(
        "WebGPU adapter could not be obtained. Your GPU driver may not support WebGPU.",
      );
    }
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
    const ctx = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!ctx) {
      throw new WebGPUUnavailableError(
        "Failed to obtain WebGPU canvas context.",
      );
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: "premultiplied" });
    return new GpuDevice(device, ctx, format, canvas);
  }
}
