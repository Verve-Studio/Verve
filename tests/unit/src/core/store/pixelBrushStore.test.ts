import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PixelBrush } from "@/types";
import { bytesToBase64 } from "@/utils/base64";
import {
  deserializePixelBrush,
  isValidPixelBrush,
  parsePixelBrushFile,
  serializePixelBrushFile,
} from "@/core/store/pixelBrushStore";

type Module = typeof import("@/core/store/pixelBrushStore");

function brush(id: string, w = 2, h = 3): PixelBrush {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 13 + id.length) & 0xff;
  return { id, name: `Brush ${id}`, width: w, height: h, rgba, createdAt: 123 };
}

let api: {
  loadUserPixelBrushes: ReturnType<typeof vi.fn>;
  saveUserPixelBrushes: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  api = {
    loadUserPixelBrushes: vi.fn(async () => "[]"),
    saveUserPixelBrushes: vi.fn(async () => undefined),
  };
  vi.stubGlobal("window", { api });
});

async function freshStore(): Promise<Module["pixelBrushStore"]> {
  vi.resetModules();
  return (await import("@/core/store/pixelBrushStore")).pixelBrushStore;
}

describe("isValidPixelBrush", () => {
  it("accepts a well-formed brush", () => {
    expect(isValidPixelBrush(brush("a"))).toBe(true);
  });

  it("rejects bad sizes, truncated payloads and wrong types", () => {
    const ok = brush("a");
    expect(isValidPixelBrush({ ...ok, width: 0 })).toBe(false);
    expect(isValidPixelBrush({ ...ok, width: 1.5 })).toBe(false);
    expect(isValidPixelBrush({ ...ok, height: -1 })).toBe(false);
    expect(isValidPixelBrush({ ...ok, rgba: ok.rgba.subarray(4) })).toBe(false);
    expect(isValidPixelBrush({ ...ok, rgba: [...ok.rgba] })).toBe(false);
    expect(isValidPixelBrush({ ...ok, id: 5 })).toBe(false);
    expect(isValidPixelBrush(null)).toBe(false);
    expect(isValidPixelBrush("brush")).toBe(false);
  });

  it("rejects absurd dimensions (> 1M pixels)", () => {
    const huge = { id: "h", width: 1025, height: 1024, rgba: new Uint8Array(4) };
    expect(isValidPixelBrush(huge)).toBe(false);
  });
});

describe("pixel brush file format", () => {
  it("round-trips through base64 JSON", () => {
    const list = [brush("a"), brush("b", 1, 1)];
    const json = serializePixelBrushFile(list);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.brushes[0].rgba).toBe(bytesToBase64(list[0].rgba));
    expect(parsePixelBrushFile(json)).toEqual(list);
  });

  it("drops malformed entries and keeps the good ones", () => {
    const good = brush("good");
    const json = JSON.stringify([
      { ...good, rgba: bytesToBase64(good.rgba) },
      { ...good, id: "bad-size", width: 0, rgba: bytesToBase64(good.rgba) },
      { ...good, id: "truncated", rgba: bytesToBase64(good.rgba.subarray(1)) },
      { ...good, id: "bad-base64", rgba: "!!!not base64!!!" },
      { ...good, id: "no-rgba", rgba: 7 },
      null,
    ]);
    expect(parsePixelBrushFile(json).map((b) => b.id)).toEqual(["good"]);
  });

  it("corrupt JSON yields an empty list", () => {
    expect(parsePixelBrushFile("{")).toEqual([]);
    expect(parsePixelBrushFile('{"brushes":{}}')).toEqual([]);
  });

  it("deserializePixelBrush resolves rgba through the given decoder", () => {
    const b = brush("a");
    const decode = vi.fn(() => b.rgba);
    const out = deserializePixelBrush({ ...b, rgba: "blob:1" }, decode);
    expect(decode).toHaveBeenCalledWith("blob:1");
    expect(out).toEqual(b);
    expect(
      deserializePixelBrush({ ...b, rgba: "x" }, () => {
        throw new Error("missing blob");
      }),
    ).toBeNull();
  });
});

describe("pixelBrushStore", () => {
  it("init loads once; a failing load yields an empty library", async () => {
    api.loadUserPixelBrushes.mockResolvedValue(serializePixelBrushFile([brush("a")]));
    const store = await freshStore();
    await store.init();
    await store.init();
    expect(api.loadUserPixelBrushes).toHaveBeenCalledTimes(1);
    expect(store.getUserBrushes().map((b) => b.id)).toEqual(["a"]);

    api.loadUserPixelBrushes.mockRejectedValue(new Error("io"));
    const store2 = await freshStore();
    await store2.init();
    expect(store2.getUserBrushes()).toEqual([]);
  });

  it("mutations notify and persist the whole library", async () => {
    const store = await freshStore();
    const fn = vi.fn();
    store.subscribe(fn);
    await store.addUserBrush(brush("a"));
    await store.addUserBrush(brush("b"));
    await store.renameUserBrush("a", "Renamed");
    await store.removeUserBrush("b");
    expect(store.getUserBrushes().map((b) => [b.id, b.name])).toEqual([["a", "Renamed"]]);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(parsePixelBrushFile(api.saveUserPixelBrushes.mock.lastCall![0])).toEqual(
      store.getUserBrushes(),
    );
    store.unsubscribe(fn);
    await store.setUserBrushes([]);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("a failing save is non-fatal", async () => {
    api.saveUserPixelBrushes.mockRejectedValue(new Error("disk full"));
    const store = await freshStore();
    await expect(store.addUserBrush(brush("a"))).resolves.toBeUndefined();
    expect(store.getUserBrushes()).toHaveLength(1);
  });
});
