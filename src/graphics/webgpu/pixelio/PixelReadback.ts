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
    const buf = this.pool.acquire(alignedBpr * height);
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: buf, bytesPerRow: alignedBpr, rowsPerImage: height },
      { width, height },
    );
    this.gpu.device.queue.submit([encoder.finish()]);
    onSubmit?.();

    await buf.mapAsync(GPUMapMode.READ);
    const raw = buf.getMappedRange();
    const result: Uint8Array | Float32Array = isFloat32
      ? unpackF32Rows(new Float32Array(raw), width, height, alignedBpr / 4)
      : unpackRows(new Uint8Array(raw), width, height, alignedBpr);
    buf.unmap();
    this.pool.release(buf);
    return result;
  }

  destroy(): void {
    this.pool.destroy();
  }
}
