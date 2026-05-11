/**
 * Pool of GPU readback buffers, keyed by exact byte size. Prior to this pool
 * every readback (`readFlattenedPlan`, `readAdjustmentInputPlan`, etc.) allocated
 * a fresh `MAP_READ | COPY_DST` buffer per call and destroyed it after unmap;
 * for full-canvas reads at high resolution that's tens of MB allocated and
 * freed per export operation.
 *
 * The pool returns a buffer of the requested size if one is available. Buffers
 * are returned via {@link release} after the caller has unmapped. Keys must
 * match exactly — readbacks at the same canvas size pad to the same aligned
 * BPR, so collisions are common in practice.
 */
export class StagingBufferPool {
  private readonly device: GPUDevice;
  private readonly idle = new Map<number, GPUBuffer[]>();

  constructor(device: GPUDevice) {
    this.device = device;
  }

  acquire(size: number): GPUBuffer {
    const slot = this.idle.get(size);
    if (slot && slot.length > 0) {
      return slot.pop()!;
    }
    return this.device.createBuffer({
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  release(buffer: GPUBuffer): void {
    let slot = this.idle.get(buffer.size);
    if (!slot) {
      slot = [];
      this.idle.set(buffer.size, slot);
    }
    slot.push(buffer);
  }

  /** Drop all pooled buffers (renderer destroy). */
  destroy(): void {
    for (const slot of this.idle.values()) {
      for (const b of slot) b.destroy();
    }
    this.idle.clear();
  }
}
