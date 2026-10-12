import { beforeEach, describe, expect, it, vi } from "vitest";

type MemModule = typeof import("@/core/store/memoryStore");
type PrefsModule = typeof import("@/core/store/preferencesStore");

const MB = 1024 * 1024;

/** Fresh memoryStore + preferencesStore singletons with the given prefs. */
async function fresh(
  prefs: Partial<import("@/core/store/preferencesStore").AppPreferences> = {},
): Promise<MemModule & { prefs: PrefsModule["preferencesStore"] }> {
  vi.resetModules();
  const p = await import("@/core/store/preferencesStore");
  p.preferencesStore.set({ bufferMemoryBytes: 100 * MB, unifiedMemory: false, ...prefs });
  const m = await import("@/core/store/memoryStore");
  return { ...m, prefs: p.preferencesStore };
}

beforeEach(() => {
  vi.stubGlobal("window", {
    api: { platform: "win32", savePreferences: vi.fn(async () => undefined) },
  });
});

function fakeDevice(): { device: GPUDevice; destroyed: number[] } {
  const destroyed: number[] = [];
  let n = 0;
  const device = {
    createTexture: () => {
      const id = n++;
      return { destroy: () => destroyed.push(id) } as unknown as GPUTexture;
    },
  } as unknown as GPUDevice;
  return { device, destroyed };
}

describe("memoryStore buckets and caps", () => {
  it("discrete GPU: the cap covers CPU only; GPU is tracked but uncapped", async () => {
    const { memoryStore } = await fresh({ unifiedMemory: false });
    expect(memoryStore.tryAlloc("cpu", 60 * MB)).toBe(true);
    expect(memoryStore.tryAlloc("cpu", 50 * MB)).toBe(false);
    expect(memoryStore.tryAlloc("gpu", 500 * MB)).toBe(true);
    expect(memoryStore.getCpu()).toBe(60 * MB);
    expect(memoryStore.getGpu()).toBe(500 * MB);
    expect(memoryStore.getCapped()).toBe(60 * MB);
  });

  it("unified memory: CPU and GPU share one cap", async () => {
    const { memoryStore } = await fresh({ unifiedMemory: true });
    expect(memoryStore.tryAlloc("gpu", 70 * MB)).toBe(true);
    expect(memoryStore.tryAlloc("cpu", 40 * MB)).toBe(false);
    expect(memoryStore.tryAlloc("cpu", 30 * MB)).toBe(true);
    expect(memoryStore.getCapped()).toBe(100 * MB);
    expect(memoryStore.tryAlloc("gpu", 1)).toBe(false);
  });

  it("a corrupt buffer cap falls back to the default instead of refusing everything", async () => {
    const { memoryStore, MemoryLimitError } = await fresh({ unifiedMemory: false });
    const prefs = (await import("@/core/store/preferencesStore")).preferencesStore;
    for (const bad of [0, -1, NaN]) {
      vi.spyOn(prefs, "get").mockReturnValue({ ...prefs.get(), bufferMemoryBytes: bad });
      expect(memoryStore.tryAlloc("cpu", 100 * MB)).toBe(true);
      memoryStore.release("cpu", 100 * MB);
      try {
        memoryStore.alloc("cpu", 9 * 1024 * MB);
        throw new Error("expected a MemoryLimitError");
      } catch (e) {
        expect(e).toBeInstanceOf(MemoryLimitError);
        expect((e as InstanceType<typeof MemoryLimitError>).capBytes).toBe(8 * 1024 * MB);
      }
      vi.restoreAllMocks();
    }
  });

  it("an allocation exactly at the cap fits", async () => {
    const { memoryStore } = await fresh();
    expect(memoryStore.tryAlloc("cpu", 100 * MB)).toBe(true);
  });

  it("max-out ignores the cap", async () => {
    const { memoryStore } = await fresh({ bufferMemoryMaxOut: true, unifiedMemory: true });
    expect(memoryStore.tryAlloc("cpu", 10_000 * MB)).toBe(true);
    expect(() => memoryStore.alloc("gpu", 10_000 * MB)).not.toThrow();
  });

  it("alloc throws MemoryLimitError with the request, usage and cap", async () => {
    const { memoryStore, MemoryLimitError } = await fresh();
    memoryStore.alloc("cpu", 90 * MB);
    let err: unknown;
    try {
      memoryStore.alloc("cpu", 20 * MB);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MemoryLimitError);
    const e = err as InstanceType<typeof MemoryLimitError>;
    expect(e.bucket).toBe("cpu");
    expect(e.requestedBytes).toBe(20 * MB);
    expect(e.currentBytes).toBe(90 * MB);
    expect(e.capBytes).toBe(100 * MB);
    expect(e.message).toMatch(/20\.0 MB/);
    expect(e.name).toBe("MemoryLimitError");
    // A failed alloc reserves nothing.
    expect(memoryStore.getCpu()).toBe(90 * MB);
  });

  it("release never goes below zero; non-positive sizes are no-ops", async () => {
    const { memoryStore } = await fresh();
    const fn = vi.fn();
    memoryStore.subscribe(fn);
    memoryStore.alloc("cpu", 10);
    memoryStore.release("cpu", 50);
    expect(memoryStore.getCpu()).toBe(0);
    expect(memoryStore.tryAlloc("cpu", 0)).toBe(true);
    memoryStore.alloc("gpu", -5);
    memoryStore.release("gpu", 0);
    expect(memoryStore.getGpu()).toBe(0);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("the cap follows preference changes live", async () => {
    const { memoryStore, prefs } = await fresh();
    memoryStore.alloc("cpu", 80 * MB);
    expect(memoryStore.tryAlloc("cpu", 30 * MB)).toBe(false);
    prefs.set({ bufferMemoryBytes: 200 * MB });
    expect(memoryStore.tryAlloc("cpu", 30 * MB)).toBe(true);
  });
});

describe("typed-array helpers", () => {
  it("allocUint8 / allocFloat32 reserve their byte size", async () => {
    const { memoryStore, allocUint8, allocFloat32 } = await fresh();
    const a = allocUint8(1000);
    const f = allocFloat32(1000);
    expect(a).toBeInstanceOf(Uint8Array);
    expect(f).toBeInstanceOf(Float32Array);
    expect(f.length).toBe(1000);
    expect(memoryStore.getCpu()).toBe(1000 + 4000);
  });

  it("over-cap allocations throw before allocating", async () => {
    const { memoryStore, allocFloat32, MemoryLimitError } = await fresh({ bufferMemoryBytes: 1000 });
    expect(() => allocFloat32(251)).toThrow(MemoryLimitError);
    expect(memoryStore.getCpu()).toBe(0);
  });
});

describe("tracked GPU textures", () => {
  it("textureBytes uses the format's bytes per pixel", async () => {
    const { textureBytes } = await fresh();
    expect(textureBytes(10, 10, "rgba8unorm")).toBe(400);
    expect(textureBytes(10, 10, "rgba16float")).toBe(800);
    expect(textureBytes(10, 10, "rgba32float")).toBe(1600);
    expect(textureBytes(10, 10, "r8unorm")).toBe(100);
    expect(textureBytes(-3, 10, "rgba8unorm")).toBe(0);
  });

  it("create reserves GPU bytes; destroy releases them once", async () => {
    const { memoryStore, createTrackedTexture, destroyTrackedTexture } = await fresh();
    const { device, destroyed } = fakeDevice();
    const tex = createTrackedTexture(device, {
      size: { width: 64, height: 32 },
      format: "rgba32float",
      usage: 0,
    });
    expect(memoryStore.getGpu()).toBe(64 * 32 * 16);
    destroyTrackedTexture(tex);
    destroyTrackedTexture(tex); // second destroy doesn't double-release
    expect(memoryStore.getGpu()).toBe(0);
    expect(destroyed).toEqual([0, 0]);
    expect(() => destroyTrackedTexture(null)).not.toThrow();
  });

  it("an over-cap texture on unified memory throws and is never created", async () => {
    const { memoryStore, createTrackedTexture, MemoryLimitError } = await fresh({
      unifiedMemory: true,
      bufferMemoryBytes: 1000,
    });
    const createTexture = vi.fn();
    expect(() =>
      createTrackedTexture({ createTexture } as unknown as GPUDevice, {
        size: { width: 100, height: 100 },
        format: "rgba8unorm",
        usage: 0,
      }),
    ).toThrow(MemoryLimitError);
    expect(createTexture).not.toHaveBeenCalled();
    expect(memoryStore.getGpu()).toBe(0);
  });

  it("a device failure releases the reservation", async () => {
    const { memoryStore, createTrackedTexture } = await fresh();
    const device = {
      createTexture: () => {
        throw new Error("device lost");
      },
    } as unknown as GPUDevice;
    expect(() =>
      createTrackedTexture(device, { size: { width: 8, height: 8 }, format: "rgba8unorm", usage: 0 }),
    ).toThrow("device lost");
    expect(memoryStore.getGpu()).toBe(0);
  });
});
