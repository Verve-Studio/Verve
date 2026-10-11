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
 *
 * Only buffers up to {@link MAX_POOLED_BYTES} are kept, and the idle set is
 * capped at {@link MAX_IDLE_BYTES} (oldest released evicted first). A
 * full-canvas float readback is ~1 GiB at 8000²; pooling those kept one
 * mapped-memory buffer alive per distinct size for the renderer's lifetime.
 */
/** Larger buffers are destroyed after use instead of pooled. */
const MAX_POOLED_BYTES = 64 * 1024 * 1024;
/** Upper bound on the total size of idle pooled buffers. */
const MAX_IDLE_BYTES = 192 * 1024 * 1024;

export class StagingBufferPool {
  private readonly device: GPUDevice;
  private readonly idle = new Map<number, GPUBuffer[]>();
  /** Idle buffers in release order (oldest first), for eviction. */
  private readonly idleOrder: GPUBuffer[] = [];
  private idleBytes = 0;
  private destroyed = false;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  acquire(size: number): GPUBuffer {
    const slot = this.idle.get(size);
    if (slot && slot.length > 0) {
      const buf = slot.pop()!;
      this.idleOrder.splice(this.idleOrder.indexOf(buf), 1);
      this.idleBytes -= buf.size;
      return buf;
    }
    return this.device.createBuffer({
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  release(buffer: GPUBuffer): void {
    // A readback can still be in flight when the renderer is destroyed (tab
    // switch during export). Pooling the buffer then would leak it forever.
    if (
      this.destroyed ||
      buffer.mapState !== "unmapped" ||
      buffer.size > MAX_POOLED_BYTES
    ) {
      buffer.destroy();
      return;
    }
    let slot = this.idle.get(buffer.size);
    if (!slot) {
      slot = [];
      this.idle.set(buffer.size, slot);
    }
    slot.push(buffer);
    this.idleOrder.push(buffer);
    this.idleBytes += buffer.size;
    while (this.idleBytes > MAX_IDLE_BYTES && this.idleOrder.length > 0) {
      const old = this.idleOrder.shift()!;
      const oldSlot = this.idle.get(old.size)!;
      oldSlot.splice(oldSlot.indexOf(old), 1);
      if (oldSlot.length === 0) this.idle.delete(old.size);
      this.idleBytes -= old.size;
      old.destroy();
    }
  }

  /** Drop all pooled buffers (renderer destroy). */
  destroy(): void {
    this.destroyed = true;
    for (const slot of this.idle.values()) {
      for (const b of slot) b.destroy();
    }
    this.idle.clear();
    this.idleOrder.length = 0;
    this.idleBytes = 0;
  }
}
