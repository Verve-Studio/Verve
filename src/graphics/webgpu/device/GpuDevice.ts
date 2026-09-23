import { WebGPUUnavailableError } from "../types";

let sharedDevicePromise: Promise<GPUDevice> | null = null;

type DeviceLostListener = (info: GPUDeviceLostInfo) => void;
type UncapturedErrorListener = (error: GPUError) => void;
const deviceLostListeners = new Set<DeviceLostListener>();
const uncapturedErrorListeners = new Set<UncapturedErrorListener>();

/**
 * Subscribe to loss of the shared GPUDevice (driver reset / TDR, GPU process
 * crash, OOM). Every renderer built on the lost device is dead afterwards;
 * the listener is expected to rebuild them (the next `GpuDevice.create`
 * requests a fresh device). Returns an unsubscribe function.
 */
export function onGpuDeviceLost(listener: DeviceLostListener): () => void {
  deviceLostListeners.add(listener);
  return () => deviceLostListeners.delete(listener);
}

/** Subscribe to GPU validation / out-of-memory errors that no error scope
 *  captured. Returns an unsubscribe function. */
export function onGpuUncapturedError(
  listener: UncapturedErrorListener,
): () => void {
  uncapturedErrorListeners.add(listener);
  return () => uncapturedErrorListeners.delete(listener);
}

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
      // Opt-in features. `float32-filterable` lets the screen-blit sampler
      // bilinear-filter rgba32float composites at zoom < 1, eliminating the
      // jaggies you'd otherwise get from nearest sampling on an HDR doc.
      // Universally supported on modern GPUs (Chromium ships it stable);
      // we gracefully fall back to nearest sampling on adapters that
      // don't have it.
      const optionalFeatures: GPUFeatureName[] = [];
      if (adapter.features.has("float32-filterable")) {
        optionalFeatures.push("float32-filterable" as GPUFeatureName);
      }
      const device = await adapter.requestDevice({
        requiredFeatures: optionalFeatures,
        requiredLimits: {
          maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
          maxBufferSize: adapter.limits.maxBufferSize,
          // Default is 128 MiB, which a single per-pixel f32 storage buffer
          // (GrabCut n-links / data terms) exceeds above ~33 MP.
          maxStorageBufferBindingSize:
            adapter.limits.maxStorageBufferBindingSize,
        },
      });
      device.lost.then((info) => {
        sharedDevicePromise = null;
        console.error(
          `[GpuDevice] Device lost (${info.reason}): ${info.message}`,
        );
        // "destroyed" means we destroyed it on purpose — nothing to recover.
        if (info.reason === "destroyed") return;
        for (const listener of deviceLostListeners) listener(info);
      });
      device.addEventListener("uncapturederror", (event) => {
        const error = (event as GPUUncapturedErrorEvent).error;
        console.error("[GpuDevice] Uncaptured GPU error:", error.message);
        for (const listener of uncapturedErrorListeners) listener(error);
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
  /** True when the adapter supports filtering rgba32float textures. Drives
   *  whether the screen-blit pipeline binds a filtering sampler + plain
   *  "float" texture (smooth downscale on HDR docs at zoom < 1) or falls
   *  back to non-filtering + "unfilterable-float" (nearest only). */
  readonly hasFloat32Filterable: boolean;

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
    this.hasFloat32Filterable = device.features.has("float32-filterable");
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
