import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Brush } from "@/types";
import { makeStarterBrushes } from "@/core/tools/Brush/brushPresets";
import { parseBrushFile, serializeBrushFile } from "@/core/store/brushStore";

type BrushModule = typeof import("@/core/store/brushStore");

const starters = makeStarterBrushes();

function bitmapBrush(): Brush {
  const rgba = new Uint8Array(2 * 3 * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) & 0xff;
  return {
    ...starters[0],
    id: "bitmap-brush",
    shape: { kind: "bitmap", bitmapRgba: rgba, bitmapWidth: 2, bitmapHeight: 3 },
  };
}

let api: { loadUserBrushes: ReturnType<typeof vi.fn>; saveUserBrushes: ReturnType<typeof vi.fn> };
beforeEach(() => {
  api = {
    loadUserBrushes: vi.fn(async () => "[]"),
    saveUserBrushes: vi.fn(async () => undefined),
  };
  vi.stubGlobal("window", { api });
});

async function freshStore(): Promise<BrushModule["brushStore"]> {
  vi.resetModules();
  return (await import("@/core/store/brushStore")).brushStore;
}

describe("brush file format", () => {
  it("round-trips brushes, including bitmap tip bytes", () => {
    const brushes = [...starters, bitmapBrush()];
    const json = serializeBrushFile(brushes);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    // Bytes are base64 in the file, a typed array in memory.
    expect(typeof parsed.brushes.at(-1).shape.bitmapRgba).toBe("string");
    const back = parseBrushFile(json);
    expect(back).toEqual(brushes);
    expect(back.at(-1)!.shape.bitmapRgba).toBeInstanceOf(Uint8Array);
  });

  it("accepts a bare array of brushes", () => {
    const json = JSON.stringify(JSON.parse(serializeBrushFile([starters[0]])).brushes);
    expect(parseBrushFile(json)).toEqual([starters[0]]);
  });

  it("corrupt or foreign JSON yields no brushes instead of throwing", () => {
    expect(parseBrushFile("{not json")).toEqual([]);
    expect(parseBrushFile("42")).toEqual([]);
    expect(parseBrushFile('{"brushes": "nope"}')).toEqual([]);
    expect(parseBrushFile("[null, 3, \"x\"]")).toEqual([]);
  });
});

describe("brushStore", () => {
  it("init loads the user library once and notifies", async () => {
    api.loadUserBrushes.mockResolvedValue(serializeBrushFile([starters[0]]));
    const store = await freshStore();
    const fn = vi.fn();
    store.subscribe(fn);
    await store.init();
    await store.init();
    expect(api.loadUserBrushes).toHaveBeenCalledTimes(1);
    expect(store.getUserBrushes()).toEqual([starters[0]]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a failing load leaves an empty library", async () => {
    api.loadUserBrushes.mockRejectedValue(new Error("io"));
    const store = await freshStore();
    await store.init();
    expect(store.getUserBrushes()).toEqual([]);
  });

  it("add / update / rename / remove persist the whole library", async () => {
    const store = await freshStore();
    const [a, b] = starters;
    await store.addUserBrush(a);
    await store.addUserBrush(b);
    await store.updateUserBrush({ ...a, opacity: 12 });
    await store.renameUserBrush(b.id, "Renamed");
    expect(store.getUserBrushes().map((x) => [x.id, x.name, x.opacity])).toEqual([
      [a.id, a.name, 12],
      [b.id, "Renamed", b.opacity],
    ]);
    expect(parseBrushFile(api.saveUserBrushes.mock.lastCall![0])).toEqual(store.getUserBrushes());
    await store.removeUserBrush(a.id);
    expect(store.getUserBrushes().map((x) => x.id)).toEqual([b.id]);
    expect(api.saveUserBrushes).toHaveBeenCalledTimes(5);
  });

  it("each mutation produces a new array (identity changes for React)", async () => {
    const store = await freshStore();
    const before = store.getUserBrushes();
    await store.setUserBrushes([starters[0]]);
    expect(store.getUserBrushes()).not.toBe(before);
  });

  it("a failing save keeps the in-memory edit and reports it", async () => {
    api.saveUserBrushes.mockRejectedValue(new Error("disk full"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = await freshStore();
    await expect(store.addUserBrush(starters[0])).resolves.toBeUndefined();
    expect(store.getUserBrushes()).toHaveLength(1);
    expect(err).toHaveBeenCalled();
  });

  it("unsubscribe stops notifications", async () => {
    const store = await freshStore();
    const fn = vi.fn();
    store.subscribe(fn);
    store.unsubscribe(fn);
    await store.setUserBrushes([]);
    expect(fn).not.toHaveBeenCalled();
  });
});
