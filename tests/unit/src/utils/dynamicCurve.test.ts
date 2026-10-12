import { describe, expect, it } from "vitest";
import type { DynamicCurve } from "@/types";
import { evaluateCurve, resolveDynamic } from "@/utils/dynamicCurve";
import { seededRandom } from "@tests/fakes/toolsPixelFakes";

const IDENTITY = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

function curve(over: Partial<DynamicCurve>): DynamicCurve {
  return { jitter: 1, source: "pressure", minimum: 0, curve: IDENTITY, ...over };
}

describe("evaluateCurve", () => {
  it("is the identity for the two-point identity curve", () => {
    for (let i = 0; i <= 20; i++) expect(evaluateCurve(IDENTITY, i / 20)).toBeCloseTo(i / 20, 12);
  });

  it("passes through every control point", () => {
    const pts = [
      { x: 0, y: 0.2 },
      { x: 0.3, y: 0.9 },
      { x: 0.6, y: 0.4 },
      { x: 1, y: 1 },
    ];
    for (const p of pts) expect(evaluateCurve(pts, p.x)).toBeCloseTo(p.y, 12);
  });

  it("clamps x outside [0, 1]", () => {
    const pts = [
      { x: 0, y: 0.25 },
      { x: 1, y: 0.75 },
    ];
    expect(evaluateCurve(pts, -5)).toBeCloseTo(0.25, 12);
    expect(evaluateCurve(pts, 7)).toBeCloseTo(0.75, 12);
  });

  it("handles degenerate inputs", () => {
    expect(evaluateCurve([], 0.3)).toBe(0.3);
    expect(evaluateCurve([{ x: 0.5, y: 0.8 }], 0.1)).toBe(0.8);
    // Endpoints inside (0, 1): past the last point holds its y.
    expect(evaluateCurve([{ x: 0.2, y: 0.1 }, { x: 0.5, y: 0.6 }], 0.9)).toBe(0.6);
  });

  it("never overshoots its control points and stays monotone on monotone data (random curves)", () => {
    const rnd = seededRandom(1234);
    for (let trial = 0; trial < 200; trial++) {
      const n = 2 + Math.floor(rnd() * 5);
      const xs = Array.from({ length: n - 2 }, () => rnd()).sort((a, b) => a - b);
      const ys = Array.from({ length: n }, () => rnd()).sort((a, b) => a - b);
      const pts = [0, ...xs, 1].map((x, i) => ({ x, y: ys[i] }));
      const lo = ys[0];
      const hi = ys[n - 1];
      let prev = -Infinity;
      for (let i = 0; i <= 200; i++) {
        const y = evaluateCurve(pts, i / 200);
        expect(y).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(y).toBeLessThanOrEqual(hi + 1e-9);
        expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = y;
      }
    }
  });

  it("stays within each segment's y-range for non-monotone data", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0.25, y: 1 },
      { x: 0.5, y: 0 },
      { x: 0.75, y: 1 },
      { x: 1, y: 0 },
    ];
    for (let i = 0; i <= 400; i++) {
      const y = evaluateCurve(pts, i / 400);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe("resolveDynamic", () => {
  it("is 1 (no modulation) when off or jitter is 0", () => {
    expect(resolveDynamic(curve({ source: "off" }), 0)).toBe(1);
    expect(resolveDynamic(curve({ jitter: 0 }), 0)).toBe(1);
  });

  it("maps the source between minimum and 1 at full jitter", () => {
    const d = curve({ minimum: 0.2 });
    expect(resolveDynamic(d, 0)).toBeCloseTo(0.2, 12);
    expect(resolveDynamic(d, 1)).toBeCloseTo(1, 12);
    expect(resolveDynamic(d, 0.5)).toBeCloseTo(0.6, 12);
  });

  it("partial jitter blends toward 1", () => {
    expect(resolveDynamic(curve({ jitter: 0.5 }), 0)).toBeCloseTo(0.5, 12);
  });

  it("stays within [minimum, 1] for any source value", () => {
    const d = curve({ minimum: 0.3, curve: [{ x: 0, y: 1 }, { x: 1, y: 0 }] });
    for (const v of [-1, 0, 0.3, 0.7, 1, 2]) {
      const r = resolveDynamic(d, v);
      expect(r).toBeGreaterThanOrEqual(0.3 - 1e-12);
      expect(r).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
});
