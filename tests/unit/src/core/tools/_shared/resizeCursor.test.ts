import { describe, expect, it } from "vitest";
import { angleToResizeCursor, resizeCursorForHandle } from "@/core/tools/_shared/resizeCursor";

describe("angleToResizeCursor", () => {
  it.each([
    [0, "ew-resize"],
    [45, "nwse-resize"],
    [90, "ns-resize"],
    [135, "nesw-resize"],
    [180, "ew-resize"],
    [-45, "nesw-resize"],
    [22.4, "ew-resize"],
    [22.5, "nwse-resize"],
    [157.5, "ew-resize"],
    [720 + 90, "ns-resize"],
  ] as const)("%f° -> %s", (angle, cursor) => {
    expect(angleToResizeCursor(angle)).toBe(cursor);
  });

  it("is symmetric across 180°", () => {
    for (let a = -360; a <= 360; a += 7.5) expect(angleToResizeCursor(a)).toBe(angleToResizeCursor(a + 180));
  });
});

describe("resizeCursorForHandle", () => {
  it("maps the unrotated handles", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => resizeCursorForHandle(i, 0))).toEqual([
      "nwse-resize", "ns-resize", "nesw-resize", "ew-resize", "ew-resize", "nesw-resize", "ns-resize", "nwse-resize",
    ]);
  });

  it("opposite handles share a cursor at any rotation", () => {
    for (let rot = 0; rot < 360; rot += 10) {
      expect(resizeCursorForHandle(0, rot)).toBe(resizeCursorForHandle(7, rot));
      expect(resizeCursorForHandle(1, rot)).toBe(resizeCursorForHandle(6, rot));
      expect(resizeCursorForHandle(2, rot)).toBe(resizeCursorForHandle(5, rot));
      expect(resizeCursorForHandle(3, rot)).toBe(resizeCursorForHandle(4, rot));
    }
  });

  it("rotating by 90° swaps horizontal and vertical", () => {
    expect(resizeCursorForHandle(4, 90)).toBe("ns-resize");
    expect(resizeCursorForHandle(1, 90)).toBe("ew-resize");
  });

  it("returns null for non-scale handles", () => {
    expect(resizeCursorForHandle(-1, 0)).toBeNull();
    expect(resizeCursorForHandle(8, 0)).toBeNull();
  });
});
