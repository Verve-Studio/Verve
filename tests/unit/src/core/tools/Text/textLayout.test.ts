// The layout engine measures with Canvas2D. Node has no canvas, so a
// monospace stand-in (every UTF-16 unit is 10 px wide; with textBaseline
// "top" the font box is 0 px above / 20 px below the pen)
// is installed before the engine's lazily created measuring context.
import { describe, expect, it } from "vitest";
import type { TextLayerState } from "@/types";

const ADV = 10;
class FakeCtx {
  font = "";
  textBaseline = "top";
  textAlign = "left";
  direction = "ltr";
  letterSpacing = "0px";
  measureText(s: string) {
    return { width: s.length * ADV, fontBoundingBoxAscent: 0, fontBoundingBoxDescent: 20 };
  }
}
(globalThis as Record<string, unknown>).OffscreenCanvas ??= class {
  getContext() {
    return new FakeCtx();
  }
};

const {
  caretGeometry,
  caretX,
  effectiveFontSize,
  floatRgbaToCss,
  hitTestText,
  indexAtX,
  layoutText,
  lineBoundary,
  lineIndexOf,
  paragraphRangeAt,
  selectionRects,
  textFont,
  textFrame,
  toLayoutSpace,
  wordRangeAt,
} = await import("@/core/tools/Text/textLayout");

const text = (over: Partial<TextLayerState>): TextLayerState => ({
  id: "t",
  name: "t",
  visible: true,
  opacity: 1,
  locked: false,
  blendMode: "normal",
  type: "text",
  text: "",
  x: 100,
  y: 50,
  boxWidth: 0,
  boxHeight: 0,
  fontFamily: "Inter",
  fontSize: 20,
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  align: "left",
  letterSpacing: 0,
  lineHeight: 1.5,
  kerning: "auto",
  color: { r: 1, g: 1, b: 1, a: 1 },
  ...over,
});

describe("font state", () => {
  it("builds the CSS font string", () => {
    expect(textFont(text({ bold: true, italic: true }))).toBe('italic bold 20px "Inter", sans-serif');
    expect(effectiveFontSize(text({ superscript: true }))).toBeCloseTo(20 * 0.583, 9);
  });

  it("floatRgbaToCss clamps HDR at the Canvas2D boundary", () => {
    expect(floatRgbaToCss({ r: 4, g: 0.5, b: -1, a: 2 })).toBe("rgba(255, 128, 0, 1)");
  });
});

describe("point text", () => {
  it("one line per paragraph, stacked by line height", () => {
    const l = layoutText(text({ text: "ab\ncdef\n" }));
    expect(l.lines.map((x) => [x.start, x.end, x.draw])).toEqual([
      [0, 2, "ab"],
      [3, 7, "cdef"],
      [8, 8, ""],
    ]);
    expect(l.lines.map((x) => x.top)).toEqual([50, 80, 110]);
    expect(l.frame).toEqual({ x: 100, y: 50, w: 40, h: 90 });
    expect(l.clip).toBeNull();
    expect(l.identity).toBe(true);
  });

  it("aligns lines against the widest one", () => {
    const c = layoutText(text({ text: "ab\ncdef", align: "center" }));
    expect(c.lines[0].x).toBe(110);
    expect(c.lines[1].x).toBe(100);
    const r = layoutText(text({ text: "ab\ncdef", align: "right" }));
    expect(r.lines[0].x).toBe(120);
  });

  it("is cached per immutable layer object", () => {
    const ls = text({ text: "x" });
    expect(layoutText(ls)).toBe(layoutText(ls));
    expect(layoutText({ ...ls })).not.toBe(layoutText(ls));
    expect(textFrame(ls)).toBe(layoutText(ls).frame);
  });

  it("all caps keeps UTF-16 offsets valid", () => {
    const l = layoutText(text({ text: "straße", allCaps: true }));
    expect(l.lines[0].full).toHaveLength(6);
    expect(l.lines[0].full.startsWith("STRA")).toBe(true);
  });

  it("empty text has no ink", () => {
    expect(layoutText(text({ text: "" })).ink).toBeNull();
    expect(layoutText(text({ text: "a" })).ink).not.toBeNull();
  });
});

describe("area text wrapping", () => {
  it("wraps at spaces with trailing spaces hanging", () => {
    const l = layoutText(text({ text: "aaa bbb ccc", boxWidth: 65, boxHeight: 200 }));
    expect(l.lines.map((x) => x.full)).toEqual(["aaa ", "bbb ", "ccc"]);
    expect(l.lines.map((x) => x.draw)).toEqual(["aaa", "bbb", "ccc"]);
    expect(l.lines[0].width).toBe(30);
    expect(l.clip).toEqual({ x: 100, y: 50, w: 65, h: 200 });
    expect(l.overflow).toBe(false);
  });

  it("breaks over-long words at the character level", () => {
    const l = layoutText(text({ text: "abcdefghij", boxWidth: 35, boxHeight: 500 }));
    expect(l.lines.map((x) => x.full)).toEqual(["abc", "def", "ghi", "j"]);
  });

  it("never splits a surrogate pair", () => {
    const s = "a\u{1F600}\u{1F600}\u{1F600}";
    const l = layoutText(text({ text: s, boxWidth: 25, boxHeight: 500 }));
    for (const line of l.lines) {
      const first = line.full.charCodeAt(0);
      expect((first & 0xfc00) === 0xdc00).toBe(false);
    }
    expect(l.lines.map((x) => x.full).join("")).toBe(s);
  });

  it("covers the whole text exactly once, in order", () => {
    const s = "the quick brown fox jumps over the lazy dog\nand again";
    const l = layoutText(text({ text: s, boxWidth: 120, boxHeight: 10 }));
    let expectStart = 0;
    for (const line of l.lines) {
      expect(line.start).toBe(expectStart);
      expect(s.slice(line.start, line.end)).toBe(line.full);
      expectStart = line.isLastOfPara ? line.end + 1 : line.end;
    }
    expect(expectStart).toBe(s.length + 1);
    expect(l.overflow).toBe(true);
  });

  it("justified lines stretch spaces to the box; the last line does not", () => {
    const l = layoutText(text({ text: "aa bb cc dd", boxWidth: 75, boxHeight: 200, align: "justify" }));
    expect(l.lines[0].spaceWidth).not.toBeNull();
    expect(l.lines[0].width).toBe(75);
    expect(l.lines[l.lines.length - 1].spaceWidth).toBeNull();
  });
});

describe("caret geometry and hit testing", () => {
  const ls = text({ text: "hello world\nxy", boxWidth: 75, boxHeight: 200 });
  const l = layoutText(ls);

  it("lineIndexOf puts a soft-wrap boundary on the following line", () => {
    expect(l.lines.map((x) => x.full)).toEqual(["hello ", "world", "xy"]);
    expect(lineIndexOf(l, 0)).toBe(0);
    expect(lineIndexOf(l, 6)).toBe(1);
    expect(lineIndexOf(l, 11)).toBe(1);
    expect(lineIndexOf(l, 12)).toBe(2);
    expect(lineIndexOf(l, 99)).toBe(2);
  });

  it("caretX advances by glyph widths", () => {
    expect(caretX(l, 0, 0)).toBe(100);
    expect(caretX(l, 0, 3)).toBe(130);
    expect(caretX(l, 1, 8)).toBe(120);
    const g = caretGeometry(l, 13);
    expect(g).toEqual({ x: 110, top: l.lines[2].y, bottom: l.lines[2].y + 20, line: 2 });
  });

  it("indexAtX picks the nearest boundary and skips the hanging break space", () => {
    expect(indexAtX(l, 0, 114)).toBe(1);
    expect(indexAtX(l, 0, 116)).toBe(2);
    expect(indexAtX(l, 0, 1000)).toBe(5);
    expect(indexAtX(l, 1, 1000)).toBe(11);
  });

  it("hitTestText ∘ caret position round-trips every index", () => {
    for (let i = 0; i <= ls.text.length; i++) {
      if (i === 6) continue; // the break space's end is the next line's start
      const g = caretGeometry(l, i);
      expect(hitTestText(l, g.x, (g.top + g.bottom) / 2)).toBe(i);
    }
  });

  it("toLayoutSpace inverts the scale / faux italic matrix", () => {
    const t = layoutText(text({ text: "ab", horizontalScale: 150, verticalScale: 50, fauxItalic: true }));
    expect(t.identity).toBe(false);
    const [a, b, c, d, e, f] = t.matrix;
    const [x, y] = [137, 61];
    const cx = a * x + c * y + e;
    const cy = b * x + d * y + f;
    const back = toLayoutSpace(t, cx, cy);
    expect(back[0]).toBeCloseTo(x, 9);
    expect(back[1]).toBeCloseTo(y, 9);
    // The anchor stays put.
    expect(a * 100 + c * 50 + e).toBeCloseTo(100, 9);
    expect(b * 100 + d * 50 + f).toBeCloseTo(50, 9);
  });

  it("selectionRects spans lines and marks the newline", () => {
    expect(selectionRects(l, 3, 3)).toEqual([]);
    const r = selectionRects(l, 2, 13);
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ x: 120, w: 40 });
    expect(r[1].x).toBe(100);
    expect(r[1].w).toBe(50 + 20 * 0.3);
    expect(r[2]).toMatchObject({ x: 100, w: 10 });
    expect(selectionRects(l, 13, 2)).toEqual(r);
  });

  it("lineBoundary: Home/End stop before a soft-wrap space", () => {
    expect(lineBoundary(l, 3, false)).toBe(0);
    expect(lineBoundary(l, 3, true)).toBe(5);
    expect(lineBoundary(l, 8, true)).toBe(11);
  });
});

describe("right-to-left text", () => {
  it("lays out an RTL paragraph right-aligned with every caret on the line", () => {
    const s = "שלום abc";
    const l = layoutText(text({ text: s, direction: "rtl", boxWidth: 200, boxHeight: 100, align: "right" }));
    const line = l.lines[0];
    expect(line.segments).not.toBeNull();
    const covered = line.segments!.reduce((n, seg) => n + (seg.end - seg.start), 0);
    expect(covered).toBe(s.length);
    for (let i = 0; i <= s.length; i++) {
      const x = caretX(l, 0, i);
      expect(x).toBeGreaterThanOrEqual(100 - 1e-9);
      expect(x).toBeLessThanOrEqual(300 + 1e-9);
    }
    // Hebrew run is RTL, Latin run is LTR.
    expect(line.segments!.some((seg) => seg.rtl && seg.text.includes("ש"))).toBe(true);
    expect(line.segments!.some((seg) => !seg.rtl && seg.text.includes("abc"))).toBe(true);
  });
});

describe("word / paragraph ranges", () => {
  it("wordRangeAt finds the word around an index", () => {
    expect(wordRangeAt("hello big world", 7)).toEqual([6, 9]);
    expect(wordRangeAt("hello", 5)).toEqual([0, 5]);
  });

  it("paragraphRangeAt stops at newlines", () => {
    const s = "one\ntwo two\nthree";
    expect(paragraphRangeAt(s, 6)).toEqual([4, 11]);
    expect(paragraphRangeAt(s, 0)).toEqual([0, 3]);
    expect(paragraphRangeAt(s, s.length)).toEqual([12, 17]);
  });
});
