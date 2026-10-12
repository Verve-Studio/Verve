import { describe, expect, it, vi } from "vitest";
import { InpaintMaskStore } from "@/core/store/inpaintMaskStore";

function count(m: Uint8Array): number {
  let n = 0;
  for (const v of m) if (v) n++;
  return n;
}

describe("InpaintMaskStore", () => {
  it("stamps are no-ops before a mask is allocated", () => {
    const s = new InpaintMaskStore();
    s.stampCircle(1, 1, 3);
    s.stampLine(0, 0, 5, 5, 2);
    expect(s.mask).toBeNull();
    expect(s.hasMaskedPixels()).toBe(false);
  });

  it("ensureSize allocates once per size and resets on resize", () => {
    const s = new InpaintMaskStore();
    s.ensureSize(8, 6);
    const m = s.mask;
    expect(m!.length).toBe(48);
    s.stampCircle(3, 3, 1);
    s.ensureSize(8, 6);
    expect(s.mask).toBe(m);
    expect(s.hasMaskedPixels()).toBe(true);
    s.ensureSize(4, 4);
    expect(s.mask!.length).toBe(16);
    expect(s.hasMaskedPixels()).toBe(false);
  });

  it("stampCircle writes 255 inside the radius only", () => {
    const s = new InpaintMaskStore();
    s.ensureSize(11, 11);
    s.stampCircle(5, 5, 2);
    const m = s.mask!;
    expect(m[5 * 11 + 5]).toBe(255);
    expect(m[5 * 11 + 7]).toBe(255); // distance 2
    expect(m[7 * 11 + 7]).toBe(0); // distance √8 > 2
    expect(count(m)).toBe(13); // lattice points with x²+y² ≤ 4
  });

  it("clips at the canvas edges", () => {
    const s = new InpaintMaskStore();
    s.ensureSize(4, 4);
    expect(() => s.stampCircle(0, 0, 10)).not.toThrow();
    expect(count(s.mask!)).toBe(16);
    s.clear();
    s.stampCircle(-20, -20, 2);
    expect(s.hasMaskedPixels()).toBe(false);
  });

  it("stampLine fills the gap between samples and notifies once", () => {
    const s = new InpaintMaskStore();
    s.ensureSize(20, 3);
    const fn = vi.fn();
    s.subscribe(fn);
    s.stampLine(1, 1, 18, 1, 1);
    s.unsubscribe(fn);
    for (let x = 1; x <= 18; x++) expect(s.mask![1 * 20 + x]).toBe(255);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("clear empties the mask but keeps the allocation", () => {
    const s = new InpaintMaskStore();
    s.ensureSize(5, 5);
    s.stampCircle(2, 2, 2);
    const m = s.mask;
    s.clear();
    expect(s.mask).toBe(m);
    expect(count(m!)).toBe(0);
    expect(s.hasMaskedPixels()).toBe(false);
  });
});
