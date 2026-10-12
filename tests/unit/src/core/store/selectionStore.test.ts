import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectionStore, selectionRevision } from "@/core/store/selectionStore";

const W = 10;
const H = 8;

function store(w = W, h = H): SelectionStore {
  const s = new SelectionStore();
  s.setDimensions(w, h);
  return s;
}

const subscribed: (() => void)[] = [];
function listen(s: SelectionStore): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  s.subscribe(fn);
  subscribed.push(() => s.unsubscribe(fn));
  return fn;
}
afterEach(() => {
  subscribed.splice(0).forEach((off) => off());
});

/** Selected (non-zero) pixels as "x,y" strings. */
function selected(s: SelectionStore): Set<string> {
  const out = new Set<string>();
  if (!s.mask) return out;
  for (let y = 0; y < s.height; y++)
    for (let x = 0; x < s.width; x++) if (s.mask[y * s.width + x]) out.add(`${x},${y}`);
  return out;
}

function rectSet(x1: number, y1: number, x2: number, y2: number): Set<string> {
  const out = new Set<string>();
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) out.add(`${x},${y}`);
  return out;
}

describe("SelectionStore basics", () => {
  it("no mask means everything is selected", () => {
    const s = store();
    expect(s.hasSelection()).toBe(false);
    expect(s.isPixelSelected(3, 3)).toBe(true);
  });

  it("setDimensions drops mask, pending and border", () => {
    const s = store();
    s.setRect(0, 0, 2, 2);
    s.setPending({ type: "rect", x1: 0, y1: 0, x2: 1, y2: 1 });
    s.setDimensions(4, 4);
    expect(s.mask).toBeNull();
    expect(s.pending).toBeNull();
    expect(s.borderSegments).toBeNull();
    expect(s.width).toBe(4);
  });

  it("setRect selects an inclusive, normalised, clamped rectangle", () => {
    const s = store();
    s.setRect(5, 4, 2, 1);
    expect(selected(s)).toEqual(rectSet(2, 1, 5, 4));
    s.setRect(-5, -5, 1, 100);
    expect(selected(s)).toEqual(rectSet(0, 0, 1, H - 1));
    expect(s.isPixelSelected(0, 0)).toBe(true);
    expect(s.isPixelSelected(2, 0)).toBe(false);
  });

  it("setRect fully outside the canvas in set mode clears the selection", () => {
    const s = store();
    s.setRect(0, 0, 2, 2);
    s.setRect(50, 50, 60, 60);
    expect(s.mask).toBeNull();
  });

  it("set mode replaces the previous selection", () => {
    const s = store();
    s.setRect(0, 0, 2, 2);
    s.setRect(5, 5, 6, 6, "set");
    expect(selected(s)).toEqual(rectSet(5, 5, 6, 6));
  });

  it("add mode unions", () => {
    const s = store();
    s.setRect(0, 0, 1, 1);
    s.setRect(3, 3, 4, 4, "add");
    expect(selected(s)).toEqual(new Set([...rectSet(0, 0, 1, 1), ...rectSet(3, 3, 4, 4)]));
  });

  it("subtract mode removes, and collapses an empty result to null", () => {
    const s = store();
    s.setRect(0, 0, 3, 3);
    s.setRect(2, 0, 9, 7, "subtract");
    expect(selected(s)).toEqual(rectSet(0, 0, 1, 3));
    s.setRect(0, 0, 9, 7, "subtract");
    expect(s.mask).toBeNull();
    expect(s.borderSegments).toBeNull();
  });

  it("intersect mode keeps the overlap, and collapses an empty result to null", () => {
    const s = store();
    s.setRect(0, 0, 4, 4);
    s.setRect(3, 3, 8, 8, "intersect");
    expect(selected(s)).toEqual(rectSet(3, 3, 4, 4));
    s.setRect(0, 0, 1, 1, "intersect");
    expect(s.mask).toBeNull();
  });

  it("intersect with no existing selection takes the new region", () => {
    const s = store();
    s.setRect(2, 2, 3, 3, "intersect");
    expect(selected(s)).toEqual(rectSet(2, 2, 3, 3));
  });

  it("add/subtract with an off-canvas rectangle leave the selection unchanged", () => {
    const s = store();
    s.setRect(0, 0, 2, 2);
    s.setRect(100, 100, 120, 120, "add");
    expect(selected(s)).toEqual(rectSet(0, 0, 2, 2));
    s.setRect(100, 100, 120, 120, "subtract");
    expect(selected(s)).toEqual(rectSet(0, 0, 2, 2));
  });

  it("intersect with an off-canvas rectangle leaves nothing selected", () => {
    const s = store();
    s.setRect(0, 0, 2, 2);
    s.setRect(100, 100, 120, 120, "intersect");
    expect(s.mask).toBeNull();
  });

  it("intersect with a degenerate polygon (lasso) leaves nothing selected", () => {
    const s = store();
    s.setRect(0, 0, 2, 2);
    s.setPolygon([{ x: 1, y: 1 }, { x: 2, y: 2 }], "intersect");
    expect(s.mask).toBeNull();
  });

  it("intersect with an off-canvas polygon leaves nothing selected", () => {
    const s = store();
    s.setRect(0, 0, 2, 2);
    s.setPolygon(
      [{ x: 50, y: 50 }, { x: 60, y: 50 }, { x: 60, y: 60 }],
      "intersect",
    );
    expect(s.mask).toBeNull();
  });

  it("magic wand intersect with a region that misses the selection clears it", () => {
    const data = new Uint8Array(W * H * 4);
    data[(7 * W + 9) * 4 + 3] = 255; // one opaque pixel at (9, 7)
    const s = store();
    s.setRect(0, 0, 2, 2);
    s.floodFillSelect(9, 7, data, 0, true, "intersect");
    expect(s.mask).toBeNull();
  });

  it("set with an off-canvas polygon stores no selection, not an all-zero mask", () => {
    const s = store();
    s.setPolygon([{ x: 50, y: 50 }, { x: 60, y: 50 }, { x: 60, y: 60 }], "set");
    expect(s.mask).toBeNull();
  });

  it("subtract with no existing selection does not select the region", () => {
    const s = store();
    s.setRect(2, 2, 4, 4, "subtract");
    expect(s.mask).toBeNull();
    s.mergeMask(new Uint8Array(W * H).fill(255), "subtract");
    expect(s.mask).toBeNull();
  });

  it("rejects an unknown mode", () => {
    const s = store();
    expect(() =>
      s.mergeMask(new Uint8Array(W * H), "xor" as unknown as "set"),
    ).toThrow(/Unknown selection mode/);
  });
});

describe("SelectionStore soft masks", () => {
  it("add takes the max, subtract reduces by strength, intersect takes the min", () => {
    const s = store(2, 1);
    s.replaceMask(new Uint8Array([100, 200]));
    s.mergeMask(new Uint8Array([150, 50]), "add");
    expect([...s.mask!]).toEqual([150, 200]);
    s.mergeMask(new Uint8Array([50, 255]), "subtract");
    expect([...s.mask!]).toEqual([100, 0]);
    s.mergeMask(new Uint8Array([60, 255]), "intersect");
    expect([...s.mask!]).toEqual([60, 0]);
  });

  it("partially selected pixels count as selected", () => {
    const s = store(2, 1);
    s.replaceMask(new Uint8Array([1, 0]));
    expect(s.isPixelSelected(0, 0)).toBe(true);
    expect(s.isPixelSelected(1, 0)).toBe(false);
  });

  it("feather produces soft edges and keeps the interior fully selected", () => {
    const s = store(21, 21);
    s.setRect(5, 5, 15, 15, "set", 2);
    const m = s.mask!;
    expect(m[10 * 21 + 10]).toBe(255);
    const edge = m[10 * 21 + 5];
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
    // Feather bleeds outside the rect.
    expect(m[10 * 21 + 4]).toBeGreaterThan(0);
    expect(m[0]).toBe(0);
  });

  it("invert flips values (255 - v)", () => {
    const s = store(3, 1);
    s.replaceMask(new Uint8Array([0, 100, 255]));
    s.invert();
    expect([...s.mask!]).toEqual([255, 155, 0]);
  });

  it("invert of a full selection collapses to null", () => {
    const s = store(2, 2);
    s.setRect(0, 0, 1, 1);
    s.invert();
    expect(s.mask).toBeNull();
  });

  it("invert with no selection (everything) leaves nothing selected", () => {
    const s = store();
    const fn = listen(s);
    s.invert();
    expect(s.mask).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("double invert restores a soft mask", () => {
    const s = store(4, 1);
    const orig = [0, 37, 128, 255];
    s.replaceMask(new Uint8Array(orig));
    s.invert();
    s.invert();
    expect([...s.mask!]).toEqual(orig);
  });
});

describe("SelectionStore polygon", () => {
  it("fewer than three points clears in set mode and keeps the mask otherwise", () => {
    const s = store();
    s.setRect(0, 0, 1, 1);
    s.setPolygon([{ x: 0, y: 0 }, { x: 5, y: 5 }], "add");
    expect(selected(s)).toEqual(rectSet(0, 0, 1, 1));
    s.setPolygon([{ x: 0, y: 0 }, { x: 5, y: 5 }], "set");
    expect(s.mask).toBeNull();
  });

  it("a polygon covering the canvas selects every pixel", () => {
    const s = store(6, 6);
    s.setPolygon([
      { x: -1, y: -1 },
      { x: 10, y: -1 },
      { x: 10, y: 10 },
      { x: -1, y: 10 },
    ]);
    expect(selected(s).size).toBe(36);
  });

  it("anti-aliased polygon edges are partial coverage", () => {
    const s = store(10, 4);
    s.setPolygon(
      [
        { x: 2.5, y: 0 },
        { x: 6.5, y: 0 },
        { x: 6.5, y: 4 },
        { x: 2.5, y: 4 },
      ],
      "set",
      0,
      true,
    );
    const row = [...s.mask!.subarray(10, 20)];
    expect(row[3]).toBe(255);
    expect(row[2]).toBe(128);
    expect(row[6]).toBe(128);
    expect(row[0]).toBe(0);
  });
});

describe("SelectionStore flood fill", () => {
  // 4×3 RGBA: left two columns red, right two blue, one isolated red at (3,2).
  function image(): Uint8Array {
    const d = new Uint8Array(4 * 3 * 4);
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 4; x++) {
        const i = (y * 4 + x) * 4;
        const red = x < 2 || (x === 3 && y === 2);
        d.set(red ? [255, 0, 0, 255] : [0, 0, 255, 255], i);
      }
    return d;
  }

  it("contiguous selects only the connected region", () => {
    const s = store(4, 3);
    s.floodFillSelect(0, 0, image(), 0, true);
    expect(selected(s)).toEqual(rectSet(0, 0, 1, 2));
  });

  it("non-contiguous selects every matching pixel", () => {
    const s = store(4, 3);
    s.floodFillSelect(0, 0, image(), 0, false);
    expect(selected(s)).toEqual(new Set([...rectSet(0, 0, 1, 2), "3,2"]));
  });

  it("a large tolerance selects everything", () => {
    const s = store(4, 3);
    s.floodFillSelect(0, 0, image(), 255, true);
    expect(selected(s).size).toBe(12);
  });

  it("an out-of-bounds seed is a no-op without notifying", () => {
    const s = store(4, 3);
    const fn = listen(s);
    s.floodFillSelect(-1, 0, image(), 0, true);
    s.floodFillSelect(4, 0, image(), 0, true);
    expect(s.mask).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it("dilation grows the region", () => {
    const s = store(4, 3);
    s.floodFillSelect(0, 0, image(), 0, true, "set", 0, 1);
    expect(selected(s)).toEqual(rectSet(0, 0, 2, 2));
  });
});

describe("SelectionStore translate / replace / restore", () => {
  it("translateMask shifts and drops pixels that leave the canvas", () => {
    const s = store(4, 4);
    s.setRect(0, 0, 1, 1);
    s.translateMask(3, 1);
    expect(selected(s)).toEqual(new Set(["3,1", "3,2"]));
  });

  it("translateMask without a selection is a no-op", () => {
    const s = store();
    const fn = listen(s);
    s.translateMask(1, 1);
    expect(s.mask).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it("replaceMask(null) and restoreMask set the mask and notify", () => {
    const s = store(2, 2);
    const fn = listen(s);
    s.replaceMask(new Uint8Array([255, 0, 0, 0]));
    expect(s.borderSegments!.length).toBeGreaterThan(0);
    s.replaceMask(null);
    expect(s.borderSegments).toBeNull();
    const saved = new Uint8Array([0, 0, 0, 255]);
    s.restoreMask(saved);
    expect(s.mask).toBe(saved);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("clear drops everything and notifies", () => {
    const s = store();
    s.setRect(0, 0, 1, 1);
    const fn = listen(s);
    s.clear();
    expect(s.hasSelection()).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("SelectionStore border segments", () => {
  /** Total length of the border runs. */
  function perimeter(seg: Float32Array): number {
    let n = 0;
    for (let i = 0; i < seg.length; i += 4) n += Math.abs(seg[i + 2] - seg[i]) + Math.abs(seg[i + 3] - seg[i + 1]);
    return n;
  }

  it("a rectangle's border is its perimeter as four runs", () => {
    const s = store();
    s.setRect(2, 1, 5, 3); // 4×3
    const seg = s.borderSegments!;
    expect(seg.length).toBe(16);
    expect(perimeter(seg)).toBe(2 * (4 + 3));
    for (let i = 0; i < seg.length; i += 4) {
      const horizontal = seg[i + 1] === seg[i + 3];
      const vertical = seg[i] === seg[i + 2];
      expect(horizontal !== vertical).toBe(true);
    }
  });

  it("a full-canvas selection's border runs along the canvas edges", () => {
    const s = store(3, 2);
    s.setRect(0, 0, 2, 1);
    const seg = [...s.borderSegments!];
    const runs = [];
    for (let i = 0; i < seg.length; i += 4) runs.push(seg.slice(i, i + 4).join(","));
    expect(runs.sort()).toEqual(["0,0,0,2", "0,0,3,0", "0,2,3,2", "3,0,3,2"].sort());
  });

  it("soft pixels at or below 127 are outside the border", () => {
    const s = store(2, 1);
    s.replaceMask(new Uint8Array([127, 128]));
    // Only the right pixel is inside: a 1×1 square.
    expect(perimeter(s.borderSegments!)).toBe(4);
  });

  it("handles more runs than the initial buffer (growth)", () => {
    // Checkerboard: every pixel contributes edges.
    const w = 64;
    const h = 64;
    const s = store(w, h);
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = (x + y) % 2 ? 255 : 0;
    s.replaceMask(m);
    // Each selected pixel has 4 unit edges; no two selected pixels share one.
    expect(perimeter(s.borderSegments!)).toBe((w * h) / 2 * 4);
  });
});

describe("SelectionStore notifications", () => {
  it("setPending does not notify (the overlay polls it)", () => {
    const s = store();
    const fn = listen(s);
    const points = [{ x: 0, y: 0 }];
    s.setPending({ type: "path", points });
    expect(fn).not.toHaveBeenCalled();
    // The live array is kept, not copied.
    expect(s.pending).toEqual({ type: "path", points });
    expect((s.pending as { points: unknown }).points).toBe(points);
  });

  it("commit operations clear pending and notify once", () => {
    const s = store();
    const fn = listen(s);
    s.setPending({ type: "rect", x1: 0, y1: 0, x2: 3, y2: 3 });
    s.setRect(0, 0, 3, 3);
    expect(s.pending).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("every notify bumps selectionRevision (live binding)", () => {
    const s = store();
    const before = selectionRevision;
    s.notify();
    s.clear();
    expect(selectionRevision).toBe(before + 2);
  });

  it("listeners are module-level: shared by every instance", () => {
    const a = store();
    const b = store();
    const fn = listen(a);
    b.setRect(0, 0, 1, 1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
