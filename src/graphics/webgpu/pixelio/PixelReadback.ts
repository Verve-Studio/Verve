import type { GpuDevice } from "../device/GpuDevice";
import { unpackRows, unpackF32Rows } from "../rendering/readbackUnpack";
import { StagingBufferPool } from "./StagingBufferPool";

/**
 * Centralised GPU→CPU pixel readback. Every readback path (full-canvas export,
 * adjustment-input sampling, future region reads) goes through this service.
 *
 * Owns a {@link StagingBufferPool} so per-call allocations are amortised, and
 * encapsulates the row-unpadding logic (WebGPU requires copyTextureToBuffer
 * destinations to use a 256-byte-aligned bytesPerRow).
 */
export class PixelReadback {
  private readonly gpu: GpuDevice;
  private readonly pool: StagingBufferPool;

  constructor(gpu: GpuDevice) {
    this.gpu = gpu;
    this.pool = new StagingBufferPool(gpu.device);
  }

  /**
   * Read the full contents of a GPU texture into a packed CPU buffer. The
   * caller supplies the texture format (rgba8unorm-style or rgba32float) so
   * the unpacker picks the right element type.
   *
   * Encodes a copyTextureToBuffer at the end of `encoder`, submits, then waits
   * on map and returns the unpacked array.
   */
  async readTexture(
    encoder: GPUCommandEncoder,
    texture: GPUTexture,
    width: number,
    height: number,
    isFloat32: boolean,
    onSubmit?: () => void,
  ): Promise<Uint8Array | Float32Array> {
    const bytesPerPixel = isFloat32 ? 16 : 4;
    const alignedBpr = Math.ceil((width * bytesPerPixel) / 256) * 256;
    const device = this.gpu.device;
    const buf = this.pool.acquire(alignedBpr * height);
    // Capture validation / OOM errors from finishing and submitting the
    // encoder. Without this, a failed composite submits nothing while
    // `mapAsync` still resolves with whatever a reused pool buffer held from
    // a previous readback — an export of stale pixels with no error.
    device.pushErrorScope("validation");
    device.pushErrorScope("out-of-memory");
    let mapped = false;
    try {
      encoder.copyTextureToBuffer(
        { texture },
        { buffer: buf, bytesPerRow: alignedBpr, rowsPerImage: height },
        { width, height },
      );
      device.queue.submit([encoder.finish()]);
      onSubmit?.();
      const oomError = await device.popErrorScope();
      const validationError = await device.popErrorScope();
      const gpuError = oomError ?? validationError;
      if (gpuError) {
        throw new Error(`GPU readback failed: ${gpuError.message}`);
      }

      await buf.mapAsync(GPUMapMode.READ);
      mapped = true;
      const raw = buf.getMappedRange();
      return isFloat32
        ? unpackF32Rows(new Float32Array(raw), width, height, alignedBpr / 4)
        : unpackRows(new Uint8Array(raw), width, height, alignedBpr);
    } finally {
      if (mapped) buf.unmap();
      this.pool.release(buf);
    }
  }

  destroy(): void {
    this.pool.destroy();
  }
}
