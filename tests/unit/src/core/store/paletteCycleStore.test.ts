import { describe, expect, it, vi } from "vitest";
import type { RGBAColor, SwatchGroup } from "@/types";
import {
  PaletteCycleStore,
  computeEffectivePalette,
  paletteCyclePeriod,
} from "@/core/store/paletteCycleStore";

const c = (r: number): RGBAColor => ({ r, g: 0, b: 0, a: 255 });
const SW = [c(0), c(1), c(2), c(3), c(4), c(5)];

function group(
  swatchIndices: number[],
  stepsPerStep: number,
  ticksPerStep = 1,
  enabled = true,
): SwatchGroup {
  return {
    id: `g${swatchIndices.join("")}`,
    name: "g",
    swatchIndices,
    cycle: { enabled, stepsPerStep, ticksPerStep },
  };
}

const reds = (p: RGBAColor[]): number[] => p.map((x) => x.r);

describe("PaletteCycleStore", () => {
  it("set / reset notify only on change", () => {
    const s = new PaletteCycleStore();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.reset();
    s.set(0);
    expect(fn).not.toHaveBeenCalled();
    s.set(3);
    s.set(3);
    expect(s.tick).toBe(3);
    s.reset();
    expect(s.tick).toBe(0);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
  });
});

describe("computeEffectivePalette", () => {
  it("rotates a cycling group forward: slot a shows b's colour", () => {
    const out = computeEffectivePalette(SW, [group([1, 2, 3], 1)], 1);
    expect(reds(out)).toEqual([0, 2, 3, 1, 4, 5]);
  });

  it("negative steps cycle backwards", () => {
    const out = computeEffectivePalette(SW, [group([1, 2, 3], -1)], 1);
    expect(reds(out)).toEqual([0, 3, 1, 2, 4, 5]);
  });

  it("ticksPerStep slows the rotation", () => {
    const g = [group([0, 1], 1, 3)];
    expect(reds(computeEffectivePalette(SW, g, 2))).toEqual(reds(SW));
    expect(reds(computeEffectivePalette(SW, g, 3))).toEqual([1, 0, 2, 3, 4, 5]);
  });

  it("returns to the start after a full cycle and never mutates its input", () => {
    const g = [group([0, 1, 2, 3], 1)];
    const copy = SW.map((x) => ({ ...x }));
    expect(reds(computeEffectivePalette(SW, g, 4))).toEqual(reds(SW));
    expect(SW).toEqual(copy);
  });

  it("ignores disabled, cycle-less and single-swatch groups", () => {
    const groups: SwatchGroup[] = [
      group([0, 1], 1, 1, false),
      { id: "x", name: "x", swatchIndices: [2, 3] },
      group([4], 1),
    ];
    expect(reds(computeEffectivePalette(SW, groups, 1))).toEqual(reds(SW));
  });
});

describe("paletteCyclePeriod", () => {
  it("is 0 when nothing cycles", () => {
    expect(paletteCyclePeriod([])).toBe(0);
    expect(paletteCyclePeriod([group([0, 1], 1, 1, false)])).toBe(0);
    expect(paletteCyclePeriod([group([0, 1, 2], 3)])).toBe(0); // step ≡ 0 mod n
  });

  it("accounts for step size, tick rate and the LCM across groups", () => {
    expect(paletteCyclePeriod([group([0, 1, 2, 3], 1)])).toBe(4);
    expect(paletteCyclePeriod([group([0, 1, 2, 3], 2)])).toBe(2);
    expect(paletteCyclePeriod([group([0, 1, 2], 1, 2)])).toBe(6);
    expect(paletteCyclePeriod([group([0, 1], 1), group([2, 3, 4], 1)])).toBe(6);
  });

  it("after `period` ticks every group is back at its start", () => {
    const groups = [group([0, 1, 2, 3], 3, 2), group([4, 5], -1, 3)];
    const p = paletteCyclePeriod(groups);
    expect(p).toBeGreaterThan(0);
    expect(reds(computeEffectivePalette(SW, groups, p))).toEqual(reds(SW));
  });
});
