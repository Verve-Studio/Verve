import { describe, expect, it } from "vitest";
import { StagingBufferPool } from "@/graphics/webgpu/pixelio/StagingBufferPool";
import { FakeGpu, type FakeBuffer } from "@tests/fakes/effectsGpuRecorder";

const MB = 1024 * 1024;
const fb = (b: GPUBuffer) => b as unknown as FakeBuffer;

describe("StagingBufferPool", () => {
  it("creates MAP_READ | COPY_DST buffers and reuses released ones of the exact size", () => {
    const gpu = new FakeGpu();
    const pool = new StagingBufferPool(gpu.device);
    const a = pool.acquire(1024);
    expect(fb(a).usage).toBe(GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    pool.release(a);
    expect(pool.acquire(2048)).not.toBe(a);
    expect(pool.acquire(1024)).toBe(a);
    // Taken again → not handed out twice.
    expect(pool.acquire(1024)).not.toBe(a);
  });

  it("destroys instead of pooling mapped, oversized, or post-destroy buffers", () => {
    const gpu = new FakeGpu();
    const pool = new StagingBufferPool(gpu.device);
    const mapped = pool.acquire(16);
    fb(mapped).mapState = "mapped";
    pool.release(mapped);
    expect(fb(mapped).destroyed).toBe(true);

    const huge = pool.acquire(65 * MB);
    pool.release(huge);
    expect(fb(huge).destroyed).toBe(true);

    const idle = pool.acquire(32);
    pool.release(idle);
    const inFlight = pool.acquire(64);
    pool.destroy();
    expect(fb(idle).destroyed).toBe(true);
    pool.release(inFlight);
    expect(fb(inFlight).destroyed).toBe(true);
  });

  it("caps idle bytes, evicting the oldest released buffers first", () => {
    const gpu = new FakeGpu();
    const pool = new StagingBufferPool(gpu.device);
    const bufs = [0, 1, 2, 3].map(() => pool.acquire(64 * MB));
    bufs.forEach((b) => pool.release(b)); // 256 MB > 192 MB cap
    expect(bufs.map((b) => fb(b).destroyed)).toEqual([true, false, false, false]);
    // The evicted buffer is never handed out again.
    const again = [pool.acquire(64 * MB), pool.acquire(64 * MB), pool.acquire(64 * MB)];
    expect(new Set(again)).toEqual(new Set(bufs.slice(1)));
  });
});
