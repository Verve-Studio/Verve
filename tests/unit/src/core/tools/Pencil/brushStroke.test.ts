import { describe, expect, it } from "vitest";
import { drawAirbrushCapsule, drawAirbrushSegment, stampAirbrush, walkQuadBezier } from "@/core/tools/Pencil/brushStroke";
import { footprintCentreOffset, footprintStart, inPencilFootprint } from "@/core/tools/Pencil/pencilFootprint";
import { stampIndexedShape } from "@/utils/indexedColorUtils";
import {
  asRenderer,
  makeFakeRenderer,
  makeLayer,
  makeTouched,
  px,
} from "@tests/fakes/toolsPixelFakes";

const W = 24;
const H = 24;

const alphaGrid = (layer: ReturnType<typeof makeLayer>): number[] => {
  const out: number[] = [];
  for (let i = 3; i < layer.data.length; i += 4) out.push(layer.data[i]);
  return out;
};

describe("pencil footprint rule", () => {
  it("size-N footprints span exactly N×N boxes starting at -floor(N/2)", () => {
    for (let n = 1; n <= 9; n++) {
      expect(footprintStart(n)).toBe(-Math.floor(n / 2));
      expect(footprintCentreOffset(n)).toBe(n % 2 === 0 ? -0.5 : 0);
    }
  });

  it("square fills the box; round and diamond are symmetric subsets", () => {
    for (let n = 1; n <= 8; n++) {
      const start = footprintStart(n);
      const c = footprintCentreOffset(n);
      let sq = 0;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const ox = start + i - c;
          const oy = start + j - c;
          if (inPencilFootprint(ox, oy, n, "square")) sq++;
          for (const shape of ["round", "diamond"] as const) {
            const a = inPencilFootprint(ox, oy, n, shape);
            expect(inPencilFootprint(-ox, oy, n, shape)).toBe(a);
            expect(inPencilFootprint(oy, ox, n, shape)).toBe(a);
            if (a) expect(inPencilFootprint(ox, oy, n, "square")).toBe(true);
          }
        }
      expect(sq).toBe(n * n);
    }
  });

  it("matches the documented pixel counts", () => {
    const count = (n: number, shape: "round" | "diamond"): number => {
      let k = 0;
      const start = footprintStart(n);
      const c = footprintCentreOffset(n);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (inPencilFootprint(start + i - c, start + j - c, n, shape)) k++;
      return k;
    };
    expect(count(2, "round")).toBe(4);
    expect(count(3, "round")).toBe(5);
    expect(count(4, "round")).toBe(12);
    expect(count(1, "round")).toBe(1);
    expect(count(3, "diamond")).toBe(5);
  });
});

describe("stampAirbrush", () => {
  it("a hard, non-AA stamp paints exactly the pencil footprint (cursor preview parity)", () => {
    for (const shape of ["round", "square", "diamond"] as const)
      for (const size of [1, 2, 3, 4, 5, 7]) {
        const r = makeFakeRenderer(W, H);
        const layer = makeLayer("rgba8", W, H);
        stampAirbrush(asRenderer(r), layer, 12, 12, size, 255, 0, 0, 255, 100, 100, shape);
        const idx = makeLayer("indexed8", W, H);
        stampIndexedShape(idx, 12, 12, 1, size, shape);
        const painted = alphaGrid(layer).map((a) => (a > 0 ? 1 : 0));
        const expected = Array.from(idx.data).map((v) => (v === 1 ? 1 : 0));
        expect(painted, `${shape} ${size}`).toEqual(expected);
      }
  });

  it("soft stamps fall off from the centre", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H);
    stampAirbrush(asRenderer(r), layer, 12, 12, 11, 255, 255, 255, 255, 100, 0, "round", true, makeTouched(W, H));
    const a = [0, 1, 2, 3, 4, 5].map((d) => px(layer, 12 + d, 12)[3]);
    expect(a[0]).toBe(255);
    for (let i = 1; i < a.length; i++) expect(a[i]).toBeLessThanOrEqual(a[i - 1]);
    expect(a[5]).toBeLessThan(40);
  });

  it("paints linear light on rgba32f with srcFloat (HDR passes through)", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba32f", W, H);
    stampAirbrush(asRenderer(r), layer, 5, 5, 1, 0, 0, 0, 255, 100, 100, "round", false, undefined, undefined, undefined, undefined, [3, 2, 1, 1]);
    const [rr, gg, bb, aa] = px(layer, 5, 5);
    expect([rr, gg, bb, aa]).toEqual([3, 2, 1, 1]);
  });
});

describe("drawAirbrushCapsule / segments", () => {
  it("a capsule covers both endpoints and the line between, capped at the stroke opacity", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H);
    const touched = makeTouched(W, H);
    drawAirbrushCapsule(asRenderer(r), layer, 4, 12, 20, 12, 5, 255, 255, 255, 255, 60, 100, "round", true, touched);
    drawAirbrushCapsule(asRenderer(r), layer, 20, 12, 4, 12, 5, 255, 255, 255, 255, 60, 100, "round", true, touched);
    for (let x = 4; x <= 20; x++) expect(px(layer, x, 12)[3]).toBe(153);
    expect(px(layer, 12, 12 + 4)[3]).toBe(0);
  });

  it("square capsules use the Chebyshev metric (square caps)", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H);
    drawAirbrushCapsule(asRenderer(r), layer, 12, 12, 12, 12, 6, 255, 255, 255, 255, 100, 100, "square", false);
    expect(px(layer, 15, 15)[3]).toBe(255);
    expect(px(layer, 16, 12)[3]).toBe(0);
  });

  it("segments leave no gaps along their length", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H);
    drawAirbrushSegment(asRenderer(r), layer, 2, 3, 21, 19, 3, 255, 0, 0, 255, 100, 100, "round", makeTouched(W, H));
    for (let i = 0; i <= 19; i++) {
      const x = Math.round(2 + (19 * i) / 19);
      const y = Math.round(3 + (16 * i) / 19);
      expect(px(layer, x, y)[3]).toBe(255);
    }
  });

  it("walkQuadBezier passes through both endpoints and tapers size", () => {
    const r = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H);
    walkQuadBezier(asRenderer(r), layer, 3, 20, 12, 0, 21, 20, 5, 1, 255, 255, 255, 255, 100, 100, 100, "round", false, 0, makeTouched(W, H));
    expect(px(layer, 3, 20)[3]).toBe(255);
    expect(px(layer, 21, 20)[3]).toBe(255);
    // The wide end paints neighbours; the 1 px end does not.
    expect(px(layer, 3, 22)[3]).toBe(255);
    expect(px(layer, 21, 22)[3]).toBe(0);
  });
});
