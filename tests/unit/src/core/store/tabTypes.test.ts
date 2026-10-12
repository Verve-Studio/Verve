import { describe, expect, it } from "vitest";
import { DEFAULT_SWATCHES, INITIAL_SNAPSHOT, fileTitle, makeTabId } from "@/core/store/tabTypes";

describe("tabTypes helpers", () => {
  it("fileTitle takes the basename for either separator", () => {
    expect(fileTitle("C:\\art\\sprites\\hero.verve")).toBe("hero.verve");
    expect(fileTitle("/home/me/a.png")).toBe("a.png");
    expect(fileTitle("plain.png")).toBe("plain.png");
    expect(fileTitle("mixed/dir\\x.tga")).toBe("x.tga");
  });

  it("makeTabId produces unique ids", () => {
    const ids = new Set(Array.from({ length: 200 }, makeTabId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id.startsWith("tab-")).toBe(true);
  });

  it("the initial snapshot is a 512² rgba8 document with one active layer", () => {
    expect(INITIAL_SNAPSHOT.canvasWidth).toBe(512);
    expect(INITIAL_SNAPSHOT.pixelFormat).toBe("rgba8");
    expect(INITIAL_SNAPSHOT.layers.map((l) => l.id)).toEqual([INITIAL_SNAPSHOT.activeLayerId]);
    expect(INITIAL_SNAPSHOT.swatches).toBe(DEFAULT_SWATCHES);
  });

  it("default swatches are opaque 8-bit colours", () => {
    for (const c of DEFAULT_SWATCHES) {
      expect(c.a).toBe(255);
      for (const v of [c.r, c.g, c.b]) {
        expect(Number.isInteger(v) && v >= 0 && v <= 255).toBe(true);
      }
    }
  });
});
