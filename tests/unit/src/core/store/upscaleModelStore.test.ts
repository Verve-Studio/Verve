import { beforeEach, describe, expect, it, vi } from "vitest";

type Module = typeof import("@/core/store/upscaleModelStore");

let listModels: ReturnType<typeof vi.fn>;
beforeEach(() => {
  listModels = vi.fn(async () => [
    { id: "a", label: "Model A", extra: 1 },
    { id: "b", label: "Model B" },
  ]);
  vi.stubGlobal("window", { api: { upscale: { listModels } } });
});

async function fresh(): Promise<Module["upscaleModelStore"]> {
  vi.resetModules();
  return (await import("@/core/store/upscaleModelStore")).upscaleModelStore;
}

describe("upscaleModelStore", () => {
  it("loads once and keeps only id + label", async () => {
    const store = await fresh();
    const fn = vi.fn();
    store.subscribe(fn);
    expect(store.all()).toEqual([]);
    await Promise.all([store.load(), store.load()]);
    await store.load();
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(store.all()).toEqual([
      { id: "a", label: "Model A" },
      { id: "b", label: "Model B" },
    ]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a failed load can be retried", async () => {
    listModels.mockRejectedValueOnce(new Error("worker down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = await fresh();
    await store.load();
    expect(store.all()).toEqual([]);
    await store.load();
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(store.all()).toHaveLength(2);
  });
});
