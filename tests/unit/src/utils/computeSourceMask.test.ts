import { describe, expect, it } from "vitest";
import { computeSourceMask } from "@/utils/computeSourceMask";

function grid(w: number, h: number, fill: (x: number, y: number) => boolean): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = fill(x, y) ? 1 : 0;
  return m;
}

describe("computeSourceMask", () => {
  it("returns null (unconstrained) for radius <= 0", () => {
    expect(computeSourceMask(new Uint8Array(4), 2, 2, 0)).toBeNull();
    expect(computeSourceMask(new Uint8Array(4), 2, 2, -3)).toBeNull();
  });

  it("marks exactly the source pixels within the 4-connected radius of the fill", () => {
    const w = 11;
    const h = 11;
    const fill = grid(w, h, (x, y) => x === 5 && y === 5);
    const r = 3;
    const out = computeSourceMask(fill, w, h, r)!;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const manhattan = Math.abs(x - 5) + Math.abs(y - 5);
        // Pixels adjacent to the fill are distance 0, so eligible at L1 <= r + 1.
        const expected = manhattan >= 1 && manhattan <= r + 1 ? 1 : 0;
        expect(out[y * w + x], `(${x},${y})`).toBe(expected);
      }
    }
  });

  it("never marks fill pixels as sources", () => {
    const fill = grid(6, 6, (x, y) => x >= 2 && x <= 3 && y >= 1 && y <= 4);
    const out = computeSourceMask(fill, 6, 6, 100)!;
    for (let i = 0; i < 36; i++) expect(out[i] && fill[i]).toBe(0);
    // Huge radius: every non-fill pixel is a source.
    expect(out.reduce((a, b) => a + b, 0)).toBe(36 - 8);
  });

  it("returns an all-zero mask when there is no fill", () => {
    const out = computeSourceMask(new Uint8Array(9), 3, 3, 2)!;
    expect(Array.from(out)).toEqual(new Array(9).fill(0));
  });

  it("does not wrap across row ends", () => {
    // Fill at the right edge of row 0; the left edge of row 1 is not adjacent.
    const w = 4;
    const fill = grid(w, 3, (x, y) => x === 3 && y === 0);
    const out = computeSourceMask(fill, w, 3, 1)!;
    expect(out[1 * w + 0]).toBe(0);
    expect(out[0 * w + 2]).toBe(1);
    expect(out[1 * w + 3]).toBe(1);
  });
});
