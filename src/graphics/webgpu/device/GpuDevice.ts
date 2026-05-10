import { WebGPUUnavailableError } from "../types";

let sharedDevicePromise: Promise<GPUDevice> | null = null;

async function getSharedDevice(): Promise<GPUDevice> {
  if (!sharedDevicePromise) {
    sharedDevicePromise = (async () => {
      const adapter = await navigator.gpu.requestAdapter({
        powerPreference: "high-performance",
      });
      if (!adapter) {
        sharedDevicePromise = null;
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
      device.lost.then(() => {
        sharedDevicePromise = null;
      });
      return device;
    })();
  }
  return sharedDevicePromise;
}

/**
 * Owns the bottom-most WebGPU infrastructure: adapter, device, canvas context,
 * swap-chain configuration, and lost-handling. Pure infrastructure — no
 * domain knowledge of layers, pipelines, or rendering passes.
 *
 * The underlying GPUDevice is shared across all GpuDevice instances for the
 * process lifetime. Each instance owns its canvas context but not the device,
 * so callers must NOT call `device.destroy()` on disposal.
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
    const device = await getSharedDevice();
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

  /**
   * No-op. The shared GPUDevice persists for the process lifetime and is
   * reused by subsequent renderers. The canvas context is owned by the canvas
   * element itself — it cannot be safely unconfigured here, because in
   * StrictMode dev double-mount two renderers may briefly share the same
   * canvas context, and unconfiguring it from the first cleanup breaks the
   * second renderer.
   */
  destroy(): void {}
}
