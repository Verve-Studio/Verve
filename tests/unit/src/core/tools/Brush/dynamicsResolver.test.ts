import { describe, expect, it } from "vitest";
import type { DynamicCurve } from "@/types";
import {
  resolveDynamic,
  resolveSymmetric,
  shouldFlip,
  smoothNoise1D,
  stampHash,
  type StampInputs,
} from "@/core/tools/Brush/dynamicsResolver";

const inputs = (over: Partial<StampInputs> = {}): StampInputs => ({
  pressure: 0.5,
  velocity: 0.25,
  tilt: 0.1,
  rotation: 0.9,
  direction: 0.75,
  stampIndex: 0,
  hash: 12345,
  noiseSample: 0.3,
  ...over,
});

const dyn = (over: Partial<DynamicCurve>): DynamicCurve => ({
  jitter: 1,
  source: "pressure",
  minimum: 0,
  curve: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  ...over,
});

describe("resolveDynamic", () => {
  it("returns 1 when off or jitter is 0", () => {
    expect(resolveDynamic(dyn({ source: "off" }), inputs())).toBe(1);
    expect(resolveDynamic(dyn({ jitter: 0 }), inputs())).toBe(1);
  });

  it.each([
    ["pressure", 0.5],
    ["velocity", 0.25],
    ["tilt", 0.1],
    ["rotation", 0.9],
    ["direction", 0.75],
    ["random", 0.3],
  ] as const)("reads the %s source", (source, expected) => {
    expect(resolveDynamic(dyn({ source }), inputs())).toBeCloseTo(expected, 12);
  });

  it("fade ramps from 1 to minimum over fadeStamps", () => {
    const d = dyn({ source: "fade", fadeStamps: 10, minimum: 0.2 });
    expect(resolveDynamic(d, inputs({ stampIndex: 0 }))).toBeCloseTo(1, 12);
    expect(resolveDynamic(d, inputs({ stampIndex: 5 }))).toBeCloseTo(0.6, 12);
    expect(resolveDynamic(d, inputs({ stampIndex: 10 }))).toBeCloseTo(0.2, 12);
    expect(resolveDynamic(d, inputs({ stampIndex: 50 }))).toBeCloseTo(0.2, 12);
    // Default length is 25 stamps; a non-positive length means "already faded".
    expect(resolveDynamic(dyn({ source: "fade" }), inputs({ stampIndex: 25 }))).toBeCloseTo(0, 12);
    expect(resolveDynamic(dyn({ source: "fade", fadeStamps: 0 }), inputs())).toBeCloseTo(0, 12);
  });

  it("result lies in [1 - jitter·(1 - minimum), 1]", () => {
    for (const jitter of [0.25, 0.5, 1])
      for (const minimum of [0, 0.4])
        for (let p = 0; p <= 1; p += 0.1) {
          const v = resolveDynamic(dyn({ jitter, minimum }), inputs({ pressure: p }));
          expect(v).toBeGreaterThanOrEqual(1 - jitter * (1 - minimum) - 1e-12);
          expect(v).toBeLessThanOrEqual(1 + 1e-12);
        }
  });
});

describe("resolveSymmetric", () => {
  it("returns 0 when off or jitter is 0", () => {
    expect(resolveSymmetric(dyn({ source: "off" }), inputs())).toBe(0);
    expect(resolveSymmetric(dyn({ jitter: 0 }), inputs())).toBe(0);
  });

  it("maps an identity curve to 2·sv − 1, scaled by jitter", () => {
    expect(resolveSymmetric(dyn({}), inputs({ pressure: 0 }))).toBeCloseTo(-1, 12);
    expect(resolveSymmetric(dyn({}), inputs({ pressure: 0.5 }))).toBeCloseTo(0, 12);
    expect(resolveSymmetric(dyn({ jitter: 0.5 }), inputs({ pressure: 1 }))).toBeCloseTo(0.5, 12);
  });

  it("random source is bipolar noise, ignoring the curve and minimum", () => {
    const d = dyn({ source: "random", minimum: 0.9, curve: [{ x: 0, y: 1 }, { x: 1, y: 1 }] });
    expect(resolveSymmetric(d, inputs({ noiseSample: 0 }))).toBeCloseTo(-1, 12);
    expect(resolveSymmetric(d, inputs({ noiseSample: 0.75 }))).toBeCloseTo(0.5, 12);
  });
});

describe("noise and hashes", () => {
  it("smoothNoise1D is in [0, 1], continuous and hits hashed values at integers", () => {
    let prev = smoothNoise1D(0, 99);
    for (let t = 0.01; t < 50; t += 0.01) {
      const v = smoothNoise1D(t, 99);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(Math.abs(v - prev)).toBeLessThan(0.05);
      prev = v;
    }
    expect(smoothNoise1D(3, 99)).toBe(smoothNoise1D(3, 99));
    expect(smoothNoise1D(3, 99)).not.toBe(smoothNoise1D(3, 100));
  });

  it("stampHash is deterministic, 32-bit unsigned and decorrelated across indices", () => {
    expect(stampHash(7, 3)).toBe(stampHash(7, 3));
    const vals = Array.from({ length: 2000 }, (_, i) => stampHash(42, i));
    for (const v of vals) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(2 ** 32);
    }
    expect(new Set(vals).size).toBe(vals.length);
    // Lowest bit should be ~50/50 (a regular pattern would skew it).
    const ones = vals.filter((v) => v & 1).length;
    expect(ones / vals.length).toBeGreaterThan(0.45);
    expect(ones / vals.length).toBeLessThan(0.55);
  });

  it("shouldFlip honours its probability and salts independently", () => {
    const N = 4000;
    let flips = 0;
    let both = 0;
    for (let i = 0; i < N; i++) {
      const h = stampHash(1, i);
      expect(shouldFlip(0, h, 1)).toBe(false);
      expect(shouldFlip(1, h, 1)).toBe(true);
      const x = shouldFlip(0.3, h, 1);
      const y = shouldFlip(0.3, h, 2);
      if (x) flips++;
      if (x && y) both++;
    }
    expect(flips / N).toBeCloseTo(0.3, 1);
    expect(both / N).toBeCloseTo(0.09, 1);
  });
});
