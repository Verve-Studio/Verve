import { describe, expect, it } from "vitest";
import type { Point, TransformParams } from "@/types";
import {
  computeForwardMatrix,
  computeInverseAffine,
  computeInverseHomography,
  getHandleWorldPositions,
  inverseAffineForResampler,
  inverseHomographyForResampler,
} from "@/core/tools/Transform/Transform";
import { seededRandom } from "@tests/fakes/toolsPixelFakes";

const params = (over: Partial<TransformParams> = {}): TransformParams => ({
  x: 10,
  y: 20,
  w: 40,
  h: 30,
  rotation: 0,
  pivotX: 30,
  pivotY: 35,
  shearX: 0,
  shearY: 0,
  perspectiveCorners: null,
  ...over,
});

const apply = (m: ArrayLike<number>, u: number, v: number): Point => ({
  x: m[0] * u + m[1] * v + m[2],
  y: m[3] * u + m[4] * v + m[5],
});

const applyH = (m: ArrayLike<number>, x: number, y: number): Point => {
  const w = m[6] * x + m[7] * y + m[8];
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
};

describe("computeForwardMatrix", () => {
  it("is a translation for an unscaled, unrotated box", () => {
    const m = computeForwardMatrix(params({ w: 40, h: 30 }), 40, 30);
    expect(apply(m, 0, 0)).toEqual({ x: 10, y: 20 });
    expect(apply(m, 5, 7)).toEqual({ x: 15, y: 27 });
    expect(m.slice(6)).toEqual([0, 0, 1]);
  });

  it("scales content to the box size", () => {
    const m = computeForwardMatrix(params({ w: 80, h: 15 }), 40, 30);
    const p = apply(m, 40, 30);
    expect(p.x).toBeCloseTo(90, 9);
    expect(p.y).toBeCloseTo(35, 9);
  });

  it("maps content corners onto the rotated handle corners", () => {
    for (const rotation of [0, 30, 90, -135, 270]) {
      const p = params({ rotation, w: 50, h: 25 });
      const m = computeForwardMatrix(p, 40, 30);
      const h = getHandleWorldPositions(p);
      const corners: [number, number, number][] = [
        [0, 0, 0],
        [40, 0, 2],
        [0, 30, 5],
        [40, 30, 7],
      ];
      for (const [u, v, idx] of corners) {
        const q = apply(m, u, v);
        expect(q.x).toBeCloseTo(h[idx].x, 9);
        expect(q.y).toBeCloseTo(h[idx].y, 9);
      }
    }
  });

  it("rotation keeps the pivot fixed", () => {
    const p = params({ rotation: 63 });
    const m0 = computeForwardMatrix(params(), 40, 30);
    const m = computeForwardMatrix(p, 40, 30);
    // The content point that sat on the pivot stays there.
    const u = p.pivotX - p.x;
    const v = p.pivotY - p.y;
    expect(apply(m0, u, v)).toEqual({ x: 30, y: 35 });
    const q = apply(m, u, v);
    expect(q.x).toBeCloseTo(30, 9);
    expect(q.y).toBeCloseTo(35, 9);
  });

  it("degenerate original size falls back to scale 1", () => {
    const m = computeForwardMatrix(params(), 0, 0);
    expect(apply(m, 1, 1)).toEqual({ x: 11, y: 21 });
  });
});

describe("computeInverseAffine", () => {
  it("inverts the forward mapping (rotation, scale, shear)", () => {
    const rnd = seededRandom(3);
    for (let i = 0; i < 25; i++) {
      const p = params({
        x: rnd() * 100 - 50,
        y: rnd() * 100 - 50,
        w: 5 + rnd() * 200,
        h: 5 + rnd() * 200,
        rotation: rnd() * 720 - 360,
        pivotX: rnd() * 100,
        pivotY: rnd() * 100,
        shearX: rnd() * 60 - 30,
        shearY: rnd() * 60 - 30,
      });
      const fwd = computeForwardMatrix(p, 64, 48);
      const inv = computeInverseAffine(p, 64, 48);
      expect(inv).toBeInstanceOf(Float32Array);
      expect(inv).toHaveLength(6);
      for (const [u, v] of [[0, 0], [64, 0], [13.5, 40.25]]) {
        const c = apply(fwd, u, v);
        const back = apply(inv, c.x, c.y);
        // Float32 storage: relative precision ~1e-7 of the magnitudes involved.
        expect(back.x).toBeCloseTo(u, 2);
        expect(back.y).toBeCloseTo(v, 2);
      }
    }
  });

  it("returns the identity for a singular (zero-size) transform instead of NaN", () => {
    const inv = computeInverseAffine(params({ w: 0 }), 40, 30);
    expect(Array.from(inv)).toEqual([1, 0, 0, 0, 1, 0]);
  });
});

describe("computeInverseHomography", () => {
  const square: [Point, Point, Point, Point] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it("maps each destination corner back to its source corner", () => {
    const dst: [Point, Point, Point, Point] = [
      { x: 12, y: 8 },
      { x: 140, y: 30 },
      { x: 120, y: 150 },
      { x: -5, y: 110 },
    ];
    const hinv = computeInverseHomography(square, dst);
    expect(hinv).toHaveLength(9);
    for (let i = 0; i < 4; i++) {
      const p = applyH(hinv, dst[i].x, dst[i].y);
      expect(p.x).toBeCloseTo(square[i].x, 2);
      expect(p.y).toBeCloseTo(square[i].y, 2);
    }
  });

  it("is a pure translation for a translated quad", () => {
    const dst = square.map((p) => ({ x: p.x + 7, y: p.y - 3 })) as [Point, Point, Point, Point];
    const hinv = computeInverseHomography(square, dst);
    const p = applyH(hinv, 57, 47);
    expect(p.x).toBeCloseTo(50, 3);
    expect(p.y).toBeCloseTo(50, 3);
  });

  it("preserves straight lines (collinear points stay collinear)", () => {
    const dst: [Point, Point, Point, Point] = [
      { x: 20, y: 10 },
      { x: 90, y: 0 },
      { x: 110, y: 120 },
      { x: 0, y: 90 },
    ];
    const hinv = computeInverseHomography(square, dst);
    const pts = [0, 0.3, 0.7, 1].map((t) => applyH(hinv, 20 + 70 * t, 10 - 10 * t));
    const cross = (a: Point, b: Point, c: Point): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    expect(Math.abs(cross(pts[0], pts[1], pts[2]))).toBeLessThan(1e-2);
    expect(Math.abs(cross(pts[0], pts[1], pts[3]))).toBeLessThan(1e-2);
  });
});

describe("resampler (pixel-centre) conversion", () => {
  it("an untransformed box maps every destination pixel centre onto its source pixel", () => {
    const p = params({ x: 10, y: 20, w: 40, h: 30 });
    const inv = inverseAffineForResampler(computeInverseAffine(p, 40, 30));
    // Canvas pixel (10, 20) is source pixel (0, 0).
    expect(apply(inv, 10, 20).x).toBeCloseTo(0, 5);
    expect(apply(inv, 10, 20).y).toBeCloseTo(0, 5);
    expect(apply(inv, 49, 49).x).toBeCloseTo(39, 5);
    expect(apply(inv, 49, 49).y).toBeCloseTo(29, 5);
  });

  it("a 90° rotation about the box centre lands on whole source pixels (no off-by-one)", () => {
    // 4×2 box at the origin rotated 90° CW about its centre (2, 1): the
    // result covers canvas [1, 3) × [-1, 3). Its top-right pixel (2, -1) is
    // source pixel (0, 0); its top-left (1, -1) is source (0, 1); its
    // bottom-left (1, 2) is source (3, 1).
    const p = params({ x: 0, y: 0, w: 4, h: 2, pivotX: 2, pivotY: 1, rotation: 90 });
    const inv = inverseAffineForResampler(computeInverseAffine(p, 4, 2));
    const cases: [number, number, number, number][] = [
      [2, -1, 0, 0],
      [1, -1, 0, 1],
      [1, 2, 3, 1],
      [2, 2, 3, 0],
    ];
    for (const [x, y, u, v] of cases) {
      const q = apply(inv, x, y);
      expect(q.x).toBeCloseTo(u, 5);
      expect(q.y).toBeCloseTo(v, 5);
    }
  });

  it("the homography conversion agrees with the affine one for an affine quad", () => {
    const src: [Point, Point, Point, Point] = [
      { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 },
    ];
    const p = params({ rotation: 30, w: 50, h: 20 });
    const fwd = computeForwardMatrix(p, 40, 30);
    const dst = src.map((c) => apply(fwd, c.x, c.y)) as [Point, Point, Point, Point];
    const h = inverseHomographyForResampler(computeInverseHomography(src, dst));
    const a = inverseAffineForResampler(computeInverseAffine(p, 40, 30));
    for (const [x, y] of [[20, 30], [33, 41], [0, 0]]) {
      const ph = applyH(h, x, y);
      const pa = apply(a, x, y);
      expect(ph.x).toBeCloseTo(pa.x, 2);
      expect(ph.y).toBeCloseTo(pa.y, 2);
    }
  });
});

describe("getHandleWorldPositions", () => {
  it("lays out the 8 scale handles, rotation handle and pivot", () => {
    const h = getHandleWorldPositions(params());
    expect(h).toHaveLength(10);
    expect(h[0]).toEqual({ x: 10, y: 20 });
    expect(h[1]).toEqual({ x: 30, y: 20 });
    expect(h[7]).toEqual({ x: 50, y: 50 });
    expect(h[8].x).toBe(30);
    expect(h[8].y).toBeLessThan(20);
    expect(h[9]).toEqual({ x: 30, y: 35 });
  });

  it("appends perspective corners", () => {
    const corners: [Point, Point, Point, Point] = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }];
    const h = getHandleWorldPositions(params({ perspectiveCorners: corners }));
    expect(h.slice(10)).toEqual(corners);
  });

  it("rotating 180° about the box centre swaps opposite handles", () => {
    const p = params({ rotation: 180, pivotX: 30, pivotY: 35 });
    const h = getHandleWorldPositions(p);
    const h0 = getHandleWorldPositions(params());
    expect(h[0].x).toBeCloseTo(h0[7].x, 9);
    expect(h[0].y).toBeCloseTo(h0[7].y, 9);
    expect(h[1].x).toBeCloseTo(h0[6].x, 9);
  });
});
