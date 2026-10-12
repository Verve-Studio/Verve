import { describe, expect, it } from "vitest";
import {
  brushFalloff,
  copyLayerRect,
  forEachBrushPixel,
  forEachStamp,
  markBrushDirty,
  scratchBuffer,
  selectionWeight,
  type BrushSelection,
} from "@/core/tools/_shared/localBrush";
import { asRenderer, makeFakeRenderer, makeLayer } from "@tests/fakes/toolsPixelFakes";

describe("brushFalloff", () => {
  it("is 1 inside the hard core, 0 at/after the edge, monotone between", () => {
    for (const h of [0, 0.3, 0.8, 1]) {
      expect(brushFalloff(0, h)).toBe(1);
      expect(brushFalloff(1, h)).toBe(0);
      expect(brushFalloff(1.5, h)).toBe(0);
      let prev = 1;
      for (let t = 0; t < 1; t += 0.01) {
        const f = brushFalloff(t, h);
        expect(f).toBeLessThanOrEqual(prev + 1e-12);
        expect(f).toBeGreaterThanOrEqual(0);
        prev = f;
      }
    }
    expect(brushFalloff(0.3, 0.5)).toBe(1);
    expect(brushFalloff(0.75, 0.5)).toBeCloseTo(0.5, 12);
  });
});

describe("forEachBrushPixel", () => {
  const collect = (w: number, h: number, p: Parameters<typeof forEachBrushPixel>[2]) => {
    const out: [number, number, number][] = [];
    forEachBrushPixel(w, h, p, (x, y, wt) => out.push([x, y, wt]));
    return out;
  };

  it("visits only pixels within the radius with weight in (0, strength]", () => {
    const pts = collect(20, 20, { cxL: 10, cyL: 10, radius: 4, hardness01: 0.5, strength01: 0.7 });
    expect(pts.length).toBeGreaterThan(0);
    for (const [x, y, w] of pts) {
      expect(Math.hypot(x - 10, y - 10)).toBeLessThan(4);
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(0.7);
    }
    expect(pts.find(([x, y]) => x === 10 && y === 10)?.[2]).toBeCloseTo(0.7, 12);
    // Symmetric footprint.
    const set = new Set(pts.map(([x, y]) => `${x},${y}`));
    for (const [x, y] of pts) expect(set.has(`${20 - x},${y}`)).toBe(true);
  });

  it("clips to the layer bounds", () => {
    const pts = collect(5, 5, { cxL: 0, cyL: 0, radius: 3, hardness01: 1, strength01: 1 });
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
    }
    expect(collect(5, 5, { cxL: 50, cyL: 50, radius: 3, hardness01: 1, strength01: 1 })).toEqual([]);
  });

  it("scales by a soft selection and skips unselected pixels", () => {
    const mask = new Uint8Array(10 * 10);
    mask.fill(255, 0, 50); // top half fully selected
    mask.fill(51, 50, 60); // row 5 at 20%
    const selection: BrushSelection = { mask, width: 10, height: 10, offsetX: 0, offsetY: 0 };
    const pts = collect(10, 10, { cxL: 5, cyL: 5, radius: 3, hardness01: 1, strength01: 1, selection });
    for (const [, y, w] of pts) {
      expect(y).toBeLessThanOrEqual(5);
      if (y === 5) expect(w).toBeCloseTo(0.2, 9);
    }
  });
});

describe("selectionWeight", () => {
  it("maps layer-local to canvas coordinates and is 0 off-canvas", () => {
    const sel: BrushSelection = { mask: new Uint8Array([0, 255, 128, 0]), width: 2, height: 2, offsetX: 1, offsetY: 0 };
    expect(selectionWeight(sel, 0, 0)).toBe(1);
    expect(selectionWeight(sel, -1, 1)).toBeCloseTo(128 / 255, 12);
    expect(selectionWeight(sel, 1, 0)).toBe(0);
    expect(selectionWeight(sel, 0, 5)).toBe(0);
  });
});

describe("forEachStamp", () => {
  it("emits the end point once for short segments", () => {
    const pts: number[][] = [];
    forEachStamp(0, 0, 1, 1, 5, (x, y) => pts.push([x, y]));
    expect(pts).toEqual([[1, 1]]);
  });

  it("subdivides long segments evenly, ending exactly at cur and excluding prev", () => {
    const pts: number[][] = [];
    forEachStamp(0, 0, 10, 0, 2.5, (x, y) => pts.push([x, y]));
    expect(pts).toEqual([[2.5, 0], [5, 0], [7.5, 0], [10, 0]]);
  });
});

describe("scratchBuffer / copyLayerRect", () => {
  it("returns views of the requested length and type, reusing storage per slot", () => {
    const a = scratchBuffer(3, false, 16);
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBe(16);
    const b = scratchBuffer(3, false, 8);
    expect(b.buffer).toBe(a.buffer);
    const f = scratchBuffer(3, true, 8);
    expect(f).toBeInstanceOf(Float32Array);
    expect(f.buffer).not.toBe(a.buffer);
  });

  it("copies a rect tightly packed", () => {
    const data = new Uint8Array(4 * 3 * 4).map((_, i) => i);
    const dst = new Uint8Array(2 * 2 * 4);
    copyLayerRect(data, 4, 1, 1, 2, 2, dst);
    const row1 = (4 + 1) * 4;
    const row2 = (8 + 1) * 4;
    expect(Array.from(dst)).toEqual([
      ...Array.from(data.subarray(row1, row1 + 8)),
      ...Array.from(data.subarray(row2, row2 + 8)),
    ]);
  });
});

describe("markBrushDirty", () => {
  it("marks a clipped rect that covers every pixel forEachBrushPixel visits", () => {
    const r = makeFakeRenderer(10, 10);
    const layer = makeLayer("rgba8", 10, 10);
    markBrushDirty(asRenderer(r), layer, 1.5, 8.2, 3);
    const [d] = r.dirty.get(layer.id)!;
    expect(d.lx).toBe(0);
    expect(d.ry).toBe(10);
    forEachBrushPixel(10, 10, { cxL: 1.5, cyL: 8.2, radius: 3, hardness01: 0, strength01: 1 }, (x, y) => {
      expect(x >= d.lx && x < d.rx && y >= d.ly && y < d.ry).toBe(true);
    });
  });
});
