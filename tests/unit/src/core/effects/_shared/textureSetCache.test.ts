import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextureSetCache } from "@/core/effects/_shared/textureSetCache";
import { EffectRuntime } from "@/graphics/webgpu/EffectRuntime";
import { FakeGpu, type FakeTexture } from "@tests/fakes/effectsGpuRecorder";

describe("TextureSetCache", () => {
  let now = 1000;
  let gpu: FakeGpu;
  let runtime: EffectRuntime;

  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    gpu = new FakeGpu();
    runtime = new EffectRuntime(gpu.device, 8, 8);
  });
  afterEach(() => {
    runtime.destroy();
  });

  const makeSet = () => ({
    a: gpu.makeTarget(8, 8, "rgba8unorm"),
    b: gpu.makeTarget(4, 4, "rgba8unorm"),
  });
  const destroyed = (s: { a: GPUTexture; b: GPUTexture }) =>
    [(s.a as unknown as FakeTexture).destroyed, (s.b as unknown as FakeTexture).destroyed];

  it("creates once per key and returns the cached set afterwards", () => {
    const cache = new TextureSetCache<{ a: GPUTexture; b: GPUTexture }>();
    const create = vi.fn(makeSet);
    const s1 = cache.get(runtime, "k", create);
    const s2 = cache.get(runtime, "k", create);
    expect(s2).toBe(s1);
    expect(create).toHaveBeenCalledTimes(1);
    const other = cache.get(runtime, "other", create);
    expect(other).not.toBe(s1);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("evicts the least-recently-used key over capacity, deferring destruction until after submit", () => {
    const cache = new TextureSetCache<{ a: GPUTexture; b: GPUTexture }>(10_000, 2);
    const k1 = cache.get(runtime, "k1", makeSet);
    const k2 = cache.get(runtime, "k2", makeSet);
    cache.get(runtime, "k1", makeSet); // touch k1 → k2 is now LRU
    cache.get(runtime, "k3", makeSet);
    // Not destroyed mid-encode: the textures may already be recorded into
    // the open command encoder.
    expect(destroyed(k2)).toEqual([false, false]);
    expect(runtime.pendingDestroyTextures).toEqual([k2.a, k2.b]);
    expect(cache.get(runtime, "k1", makeSet)).toBe(k1);
    runtime.flushPendingDestroys();
    expect(destroyed(k2)).toEqual([true, true]);
    expect(destroyed(k1)).toEqual([false, false]);
  });

  it("releases only entries idle longer than idleMs on frame end", () => {
    const cache = new TextureSetCache<{ a: GPUTexture; b: GPUTexture }>(500, 4);
    const old = cache.get(runtime, "old", makeSet);
    now += 400;
    const fresh = cache.get(runtime, "fresh", makeSet);
    now += 200; // old idle 600ms, fresh 200ms
    cache.onFrameEnd();
    expect(destroyed(old)).toEqual([true, true]);
    expect(destroyed(fresh)).toEqual([false, false]);
    // Re-requesting the evicted key creates a new set.
    expect(cache.get(runtime, "old", makeSet)).not.toBe(old);
  });

  it("an entry touched every frame never idles out", () => {
    const cache = new TextureSetCache<{ a: GPUTexture; b: GPUTexture }>(500, 4);
    const s = cache.get(runtime, "k", makeSet);
    for (let i = 0; i < 10; i++) {
      now += 300;
      expect(cache.get(runtime, "k", makeSet)).toBe(s);
      cache.onFrameEnd();
    }
    expect(destroyed(s)).toEqual([false, false]);
  });

  it("destroyAll releases everything", () => {
    const cache = new TextureSetCache<{ a: GPUTexture; b: GPUTexture }>();
    const s1 = cache.get(runtime, "1", makeSet);
    const s2 = cache.get(runtime, "2", makeSet);
    cache.destroyAll();
    expect([...destroyed(s1), ...destroyed(s2)]).toEqual([true, true, true, true]);
    expect(cache.get(runtime, "1", makeSet)).not.toBe(s1);
  });
});
