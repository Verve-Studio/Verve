import { describe, expect, it } from "vitest";
import {
  blendPixelOver,
  bresenham,
  clearTouchedBuffer,
  ditherBias,
  flushIfPending,
  makeTouchedBuffer,
  markCanvasRectDirty,
  noteTouchedWrite,
  resetTouchedWrites,
  srgbColorToLinearF32,
  wuLine,
} from "@/core/tools/_shared/primitives";
import { srgbToLinearChannel } from "@/utils/pixelFormatConvert";
import {
  asRenderer,
  isMarkedDirty,
  makeFakeRenderer,
  makeLayer,
  makeTouched,
  px,
} from "@tests/fakes/toolsPixelFakes";

const R = (w = 8, h = 8) => makeFakeRenderer(w, h);

describe("blendPixelOver — rgba8", () => {
  it("writes the source colour exactly at full opacity", () => {
    const r = R();
    const layer = makeLayer("rgba8", 8, 8);
    blendPixelOver(asRenderer(r), layer, 3, 4, 200, 100, 7, 255, 100);
    expect(px(layer, 3, 4)).toEqual([200, 100, 7, 255]);
    expect(px(layer, 4, 4)).toEqual([0, 0, 0, 0]);
  });

  it("Porter-Duff over: 50% white over opaque black is mid grey", () => {
    const layer = makeLayer("rgba8", 1, 1, { fill: [0, 0, 0, 255] });
    blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 255, 255, 255, 255, 50);
    expect(px(layer, 0, 0)).toEqual([128, 128, 128, 255]);
  });

  it("over a transparent pixel keeps colour unpremultiplied and sets alpha", () => {
    const layer = makeLayer("rgba8", 1, 1);
    blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 40, 80, 120, 255, 50);
    expect(px(layer, 0, 0)).toEqual([40, 80, 120, 128]);
  });

  it("scales by source alpha and opacity together", () => {
    const layer = makeLayer("rgba8", 1, 1);
    blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 255, 0, 0, 128, 50);
    expect(px(layer, 0, 0)[3]).toBe(Math.round(255 * (128 / 255) * 0.5));
  });

  it("ignores zero opacity / alpha", () => {
    const layer = makeLayer("rgba8", 1, 1, { fill: [1, 2, 3, 4] });
    blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 255, 255, 255, 255, 0);
    blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 255, 255, 255, 0, 100);
    expect(px(layer, 0, 0)).toEqual([1, 2, 3, 4]);
  });

  it("translates canvas -> layer-local coordinates and clips to the layer", () => {
    const r = R(10, 10);
    const layer = makeLayer("rgba8", 3, 3, { offsetX: 5, offsetY: 2 });
    blendPixelOver(asRenderer(r), layer, 6, 3, 9, 9, 9, 255, 100);
    expect(px(layer, 1, 1)).toEqual([9, 9, 9, 255]);
    blendPixelOver(asRenderer(r), layer, 4, 3, 9, 9, 9, 255, 100); // left of layer
    blendPixelOver(asRenderer(r), layer, 8, 3, 9, 9, 9, 255, 100); // right of layer
    expect(Array.from(layer.data).filter((v) => v === 9)).toHaveLength(3);
  });

  it("rejects off-canvas pixels before index math (no row wrap)", () => {
    const r = R(4, 4);
    const layer = makeLayer("rgba8", 8, 8, { offsetX: -2, offsetY: 0 });
    const touched = makeTouched(4, 4);
    blendPixelOver(asRenderer(r), layer, -1, 1, 9, 9, 9, 255, 100, touched);
    blendPixelOver(asRenderer(r), layer, 4, 1, 9, 9, 9, 255, 100, touched);
    expect(Array.from(layer.data).some((v) => v !== 0)).toBe(false);
    expect(Array.from(touched.data).some((v) => v !== 0)).toBe(false);
  });

  it("wraps canvas coordinates in tiled mode", () => {
    const r = R(4, 4);
    const layer = makeLayer("rgba8", 4, 4);
    blendPixelOver(asRenderer(r), layer, -1, 9, 9, 9, 9, 255, 100, undefined, undefined, 4, 4);
    expect(px(layer, 3, 1)).toEqual([9, 9, 9, 255]);
  });
});

describe("blendPixelOver — selection masks", () => {
  it("skips pixels outside the selection", () => {
    const layer = makeLayer("rgba8", 2, 1);
    const sel = { mask: new Uint8Array([0, 255]), width: 2 };
    blendPixelOver(asRenderer(R(2, 1)), layer, 0, 0, 255, 0, 0, 255, 100, undefined, sel);
    blendPixelOver(asRenderer(R(2, 1)), layer, 1, 0, 255, 0, 0, 255, 100, undefined, sel);
    expect(px(layer, 0, 0)[3]).toBe(0);
    expect(px(layer, 1, 0)[3]).toBe(255);
  });

  it("soft selections scale the deposit by mask/255", () => {
    const layer = makeLayer("rgba8", 1, 1);
    const sel = { mask: new Uint8Array([64]), width: 1 };
    blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 255, 0, 0, 255, 100, undefined, sel);
    expect(px(layer, 0, 0)[3]).toBe(64);
  });

  it("soft selections also scale the per-stroke ceiling", () => {
    const layer = makeLayer("rgba8", 1, 1);
    const touched = makeTouched(1, 1);
    const sel = { mask: new Uint8Array([128]), width: 1 };
    for (let i = 0; i < 20; i++)
      blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 255, 0, 0, 255, 100, touched, sel);
    expect(px(layer, 0, 0)[3]).toBe(128);
  });

  it("soft selections apply to rgba32f srcFloat deposits too", () => {
    const layer = makeLayer("rgba32f", 1, 1);
    const sel = { mask: new Uint8Array([51]), width: 1 };
    blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 0, 0, 0, 255, 100, undefined, sel, undefined, undefined, [2, 0, 0, 1]);
    expect(px(layer, 0, 0)[3]).toBeCloseTo(0.2, 6);
    expect(px(layer, 0, 0)[0]).toBeCloseTo(2, 6);
  });
});

describe("blendPixelOver — rgba32f", () => {
  it("gamma-decodes sRGB byte input into linear light", () => {
    const layer = makeLayer("rgba32f", 1, 1);
    blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 128, 255, 0, 255, 100);
    const [r, g, b, a] = px(layer, 0, 0);
    expect(r).toBeCloseTo(srgbToLinearChannel(128 / 255), 6);
    expect(g).toBeCloseTo(1, 6);
    expect(b).toBe(0);
    expect(a).toBeCloseTo(1, 6);
  });

  it("uses srcFloat verbatim (HDR > 1 survives) and ignores the byte colour", () => {
    const layer = makeLayer("rgba32f", 1, 1);
    blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 0, 0, 0, 0, 100, undefined, undefined, undefined, undefined, [4.5, 0.25, 12, 1]);
    const [r, g, b, a] = px(layer, 0, 0);
    expect(r).toBeCloseTo(4.5, 6);
    expect(g).toBeCloseTo(0.25, 6);
    expect(b).toBeCloseTo(12, 6);
    expect(a).toBeCloseTo(1, 6);
  });

  it("blends in linear light: 50% white over black is 0.5 linear (not sRGB mid-grey)", () => {
    const layer = makeLayer("rgba32f", 1, 1, { fill: [0, 0, 0, 1] });
    blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 255, 255, 255, 255, 50);
    expect(px(layer, 0, 0)[0]).toBeCloseTo(0.5, 6);
  });

  it("does not quantise alpha", () => {
    const layer = makeLayer("rgba32f", 1, 1);
    blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 0, 0, 0, 255, 33.3);
    expect(px(layer, 0, 0)[3]).toBeCloseTo(0.333, 6);
  });

  it("srcFloat alpha is used for the deposit", () => {
    const layer = makeLayer("rgba32f", 1, 1);
    blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 0, 0, 0, 255, 50, undefined, undefined, undefined, undefined, [1, 1, 1, 0.5]);
    expect(px(layer, 0, 0)[3]).toBeCloseTo(0.25, 6);
  });
});

describe("blendPixelOver — indexed8", () => {
  it("full-opacity writes store the palette index passed in r", () => {
    const layer = makeLayer("indexed8", 2, 1);
    blendPixelOver(asRenderer(R(2, 1)), layer, 1, 0, 7, 0, 0, 255, 100);
    expect(Array.from(layer.data)).toEqual([255, 7]);
  });
});

describe("blendPixelOver — per-stroke touched buffer", () => {
  it("caps a stroke at its opacity instead of accumulating", () => {
    const layer = makeLayer("rgba8", 1, 1);
    const touched = makeTouched(1, 1);
    for (let i = 0; i < 10; i++)
      blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 255, 0, 0, 255, 50, touched);
    expect(px(layer, 0, 0)[3]).toBe(128);
  });

  it("upgrades to a higher coverage exactly (AA overlap)", () => {
    const layer = makeLayer("rgba8", 1, 1);
    const touched = makeTouched(1, 1);
    blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 255, 0, 0, 255, 50, touched);
    blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 255, 0, 0, 255, 80, touched);
    expect(px(layer, 0, 0)[3]).toBe(204);
    expect(touched.data[0]).toBe(204);
  });

  it("without touched, repeated stamps accumulate", () => {
    const layer = makeLayer("rgba8", 1, 1);
    for (let i = 0; i < 2; i++) blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 255, 0, 0, 255, 50);
    expect(px(layer, 0, 0)[3]).toBe(192); // 0.5 + (128/255)·0.5
  });

  it("bypassTouchedCap re-blends but still records the stroke silhouette", () => {
    const layer = makeLayer("rgba8", 1, 1);
    const touched = makeTouched(1, 1);
    for (let i = 0; i < 2; i++)
      blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 255, 0, 0, 255, 50, touched, undefined, undefined, undefined, undefined, true);
    expect(px(layer, 0, 0)[3]).toBe(192); // 0.5 + (128/255)·0.5
    expect(Math.abs(touched.data[0] - 127.5)).toBeLessThanOrEqual(0.5); // geometric 50%
  });

  it("flow (capOpacity) builds up toward the ceiling and never exceeds it", () => {
    for (const format of ["rgba8", "rgba32f"] as const) {
      const layer = makeLayer(format, 1, 1);
      const touched = makeTouched(1, 1);
      const alphas: number[] = [];
      for (let i = 0; i < 40; i++) {
        blendPixelOver(asRenderer(R(1, 1)), layer, 0, 0, 255, 255, 255, 255, 20, touched, undefined, undefined, undefined, undefined, false, 60);
        alphas.push(format === "rgba8" ? px(layer, 0, 0)[3] / 255 : px(layer, 0, 0)[3]);
      }
      expect(alphas[0]).toBeCloseTo(0.2, 2);
      for (let i = 1; i < alphas.length; i++) expect(alphas[i]).toBeGreaterThanOrEqual(alphas[i - 1]);
      expect(alphas[alphas.length - 1]).toBeLessThanOrEqual(0.6 + 1 / 255);
      expect(alphas[alphas.length - 1]).toBeGreaterThan(0.55);
    }
  });

  it("capOpacity equal to opacity reduces to the plain capped path", () => {
    const a = makeLayer("rgba8", 1, 1);
    const b = makeLayer("rgba8", 1, 1);
    const ta = makeTouched(1, 1);
    const tb = makeTouched(1, 1);
    for (const op of [30, 30, 70, 50]) {
      blendPixelOver(asRenderer(R(1, 1)), a, 0, 0, 10, 20, 30, 255, op, ta);
      blendPixelOver(asRenderer(R(1, 1)), b, 0, 0, 10, 20, 30, 255, op, tb, undefined, undefined, undefined, undefined, false, op);
    }
    expect(px(b, 0, 0)).toEqual(px(a, 0, 0));
  });

  it("records the write box and shares touched entries across tile wraps", () => {
    const touched = makeTouched(4, 4);
    resetTouchedWrites(touched);
    const layer = makeLayer("rgba8", 4, 4);
    blendPixelOver(asRenderer(R(4, 4)), layer, -1, 0, 255, 0, 0, 255, 50, touched, undefined, 4, 4);
    blendPixelOver(asRenderer(R(4, 4)), layer, 3, 0, 255, 0, 0, 255, 50, touched, undefined, 4, 4);
    expect(px(layer, 3, 0)[3]).toBe(128);
    expect([touched.wx0, touched.wy0, touched.wx1, touched.wy1]).toEqual([3, 0, 3, 0]);
  });
});

describe("blendPixelOver — stochastic rounding (ditherSeed)", () => {
  it("rgba8 writes average to the exact fractional value", () => {
    const W = 64;
    const layer = makeLayer("rgba8", W, W);
    const r = R(W, W);
    // 30% of 255 = 76.5: round-to-nearest gives 77 everywhere.
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++)
        blendPixelOver(asRenderer(r), layer, x, y, 255, 255, 255, 255, 30, undefined, undefined, undefined, undefined, undefined, false, undefined, 1234);
    let sum = 0;
    const seen = new Set<number>();
    for (let i = 3; i < layer.data.length; i += 4) {
      sum += layer.data[i];
      seen.add(layer.data[i]);
    }
    expect([...seen].sort()).toEqual([76, 77]);
    expect(sum / (W * W)).toBeCloseTo(76.5, 1);

    const plain = makeLayer("rgba8", 1, 1);
    blendPixelOver(asRenderer(R(1, 1)), plain, 0, 0, 255, 255, 255, 255, 30);
    expect(px(plain, 0, 0)[3]).toBe(77);
  });

  it("an exact level is never dithered away", () => {
    const layer = makeLayer("rgba8", 16, 1);
    for (let x = 0; x < 16; x++)
      blendPixelOver(asRenderer(R(16, 1)), layer, x, 0, 200, 100, 50, 255, 100, undefined, undefined, undefined, undefined, undefined, false, undefined, 99);
    for (let x = 0; x < 16; x++) expect(px(layer, x, 0)).toEqual([200, 100, 50, 255]);
  });

  it("is deterministic per (x, y, seed)", () => {
    const run = (seed: number): number[] => {
      const layer = makeLayer("rgba8", 8, 8);
      for (let i = 0; i < 64; i++)
        blendPixelOver(asRenderer(R()), layer, i % 8, i >> 3, 255, 255, 255, 255, 30, undefined, undefined, undefined, undefined, undefined, false, undefined, seed);
      return Array.from(layer.data);
    };
    expect(run(5)).toEqual(run(5));
    expect(run(5)).not.toEqual(run(6));
  });
});

describe("ditherBias", () => {
  it("stays strictly inside (0, 1) and is roughly uniform", () => {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < 64; y++)
      for (let x = -32; x < 32; x++) {
        const b = ditherBias(x, y, 7);
        expect(b).toBeGreaterThan(0);
        expect(b).toBeLessThan(1);
        sum += b;
        n++;
      }
    expect(sum / n).toBeCloseTo(0.5, 1);
    expect(ditherBias(3, 4, 5)).toBe(ditherBias(3, 4, 5));
  });
});

describe("srgbColorToLinearF32", () => {
  it("decodes RGB, passes alpha through", () => {
    const out = srgbColorToLinearF32({ r: 0.5, g: 1, b: 0, a: 0.3 });
    expect(out[0]).toBeCloseTo(srgbToLinearChannel(0.5), 12);
    expect(out.slice(1)).toEqual([1, 0, 0.3]);
  });
});

describe("bresenham", () => {
  const line = (x0: number, y0: number, x1: number, y1: number): [number, number][] => {
    const pts: [number, number][] = [];
    bresenham(x0, y0, x1, y1, (x, y) => pts.push([x, y]));
    return pts;
  };

  it("plots max(|dx|,|dy|)+1 8-connected pixels including both endpoints", () => {
    const cases: [number, number, number, number][] = [
      [0, 0, 7, 3], [5, 5, -2, 9], [0, 0, 0, 0], [3, 1, 3, -6], [-4, 2, 4, 2], [0, 0, 5, 5],
    ];
    for (const [x0, y0, x1, y1] of cases) {
      const pts = line(x0, y0, x1, y1);
      expect(pts).toHaveLength(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1);
      expect(pts[0]).toEqual([x0, y0]);
      expect(pts[pts.length - 1]).toEqual([x1, y1]);
      for (let i = 1; i < pts.length; i++) {
        expect(Math.max(Math.abs(pts[i][0] - pts[i - 1][0]), Math.abs(pts[i][1] - pts[i - 1][1]))).toBe(1);
      }
    }
  });

  it("stays within half a pixel of the ideal line", () => {
    const pts = line(0, 0, 11, 4);
    for (const [x, y] of pts) expect(Math.abs(y - (4 / 11) * x)).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it("rounds fractional endpoints and terminates", () => {
    expect(line(0.4, 0.6, 2.6, 0.6)).toEqual([[0, 1], [1, 1], [2, 1], [3, 1]]);
  });

  it("does nothing for non-finite endpoints", () => {
    expect(line(NaN, 0, 3, 3)).toEqual([]);
    expect(line(0, 0, Infinity, 3)).toEqual([]);
  });
});

describe("wuLine", () => {
  const plotAll = (x0: number, y0: number, x1: number, y1: number) => {
    const out: { x: number; y: number; c: number }[] = [];
    wuLine(x0, y0, x1, y1, (x, y, c) => out.push({ x, y, c }));
    return out;
  };

  it("plots a single point at full coverage", () => {
    expect(plotAll(2, 3, 2, 3)).toEqual([{ x: 2, y: 3, c: 1 }]);
  });

  it("emits coverage in (0, 1]", () => {
    for (const c of plotAll(0.3, 1.7, 9.2, 5.1)) {
      expect(c.c).toBeGreaterThan(0);
      expect(c.c).toBeLessThanOrEqual(1);
    }
  });

  it("interior columns of a shallow line carry total coverage 1", () => {
    const cols = new Map<number, number>();
    for (const p of plotAll(0, 0, 10, 3.5)) cols.set(p.x, (cols.get(p.x) ?? 0) + p.c);
    for (let x = 1; x < 10; x++) expect(cols.get(x)).toBeCloseTo(1, 9);
  });

  it("steep lines are transposed: interior rows carry total coverage 1", () => {
    const rows = new Map<number, number>();
    const pts = plotAll(2, 0, 4.5, 10);
    for (const p of pts) rows.set(p.y, (rows.get(p.y) ?? 0) + p.c);
    for (let y = 1; y < 10; y++) expect(rows.get(y)).toBeCloseTo(1, 9);
    for (const p of pts) expect(p.x).toBeGreaterThanOrEqual(2);
  });

  it("is direction independent", () => {
    const key = (a: { x: number; y: number; c: number }[]) =>
      a.map((p) => `${p.x},${p.y},${p.c.toFixed(9)}`).sort();
    expect(key(plotAll(1, 1, 8, 4))).toEqual(key(plotAll(8, 4, 1, 1)));
  });
});

describe("markCanvasRectDirty", () => {
  it("marks the layer-local intersection (non-tiled)", () => {
    const r = makeFakeRenderer(20, 20);
    const layer = makeLayer("rgba8", 10, 10, { offsetX: 5, offsetY: 5 });
    markCanvasRectDirty(asRenderer(r), layer, 2.5, 7, 9.2, 30, false);
    expect(r.dirty.get(layer.id)).toEqual([{ lx: 0, ly: 2, rx: 5, ry: 10 }]);
  });

  it("ignores empty and fully-outside rects", () => {
    const r = makeFakeRenderer(20, 20);
    const layer = makeLayer("rgba8", 10, 10);
    markCanvasRectDirty(asRenderer(r), layer, 3, 3, 3, 8, false);
    markCanvasRectDirty(asRenderer(r), layer, 12, 0, 15, 4, false);
    expect(r.dirty.get(layer.id)).toBeUndefined();
  });

  it("tiled mode covers every wrapped pixel of the rect, and nothing else", () => {
    const W = 8;
    const H = 6;
    const rects: [number, number, number, number][] = [
      [-2, -1, 3, 2], [6, 4, 10, 9], [-20, 1, 30, 3], [5, -7, 7, 0], [1, 1, 3, 3],
    ];
    for (const [x0, y0, x1, y1] of rects) {
      const r = makeFakeRenderer(W, H);
      const layer = makeLayer("rgba8", W, H);
      markCanvasRectDirty(asRenderer(r), layer, x0, y0, x1, y1, true);
      const expected = new Set<string>();
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) expected.add(`${((x % W) + W) % W},${((y % H) + H) % H}`);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          expect(isMarkedDirty(r, layer, x, y), `rect ${[x0, y0, x1, y1]} at ${x},${y}`).toBe(expected.has(`${x},${y}`));
    }
  });

  it("flushIfPending flushes only when something is pending", () => {
    const r = makeFakeRenderer(4, 4);
    const layer = makeLayer("rgba8", 4, 4);
    flushIfPending(asRenderer(r), layer);
    expect(r.flushed).toEqual([]);
    markCanvasRectDirty(asRenderer(r), layer, 0, 0, 1, 1, false);
    flushIfPending(asRenderer(r), layer);
    expect(r.flushed).toEqual([layer.id]);
  });
});

describe("TouchedBuffer bookkeeping", () => {
  it("starts with an empty write box and grows it", () => {
    const t = makeTouchedBuffer(10, 10);
    expect(t.data.length).toBe(100);
    expect(t.wx1).toBe(-1);
    noteTouchedWrite(t, 4, 2);
    noteTouchedWrite(t, 1, 7);
    expect([t.wx0, t.wy0, t.wx1, t.wy1]).toEqual([1, 2, 4, 7]);
    t.untracked = true;
    resetTouchedWrites(t);
    expect([t.wx0, t.wy0, t.wx1, t.wy1, t.untracked]).toEqual([Infinity, Infinity, -1, -1, false]);
  });

  it("clearTouchedBuffer zeroes the coverage", () => {
    const t = makeTouchedBuffer(3, 3);
    t.data.fill(9);
    clearTouchedBuffer(t);
    expect(Array.from(t.data).every((v) => v === 0)).toBe(true);
  });
});
