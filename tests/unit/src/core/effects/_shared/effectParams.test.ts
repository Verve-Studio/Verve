import { describe, expect, it } from "vitest";
import {
  applyFieldValues,
  boolField,
  customField,
  enumField,
  fieldSpec,
  numberField,
  rgbField,
  rgbSplitField,
  rgbaField,
  textField,
  vec2Field,
} from "@/core/effects/_shared/effectParams";

type P = Record<string, unknown>;

describe("numberField", () => {
  it("reads and writes nested dotted paths immutably", () => {
    const f = numberField<P>("a.b.c", "C", { min: 0, max: 10 });
    expect(f.id).toBe("a_b_c");
    const p = Object.freeze({ a: Object.freeze({ b: Object.freeze({ c: 3, keep: 1 }), other: 2 }) });
    const q = f.set(p, 7) as { a: { b: { c: number; keep: number }; other: number } };
    expect(q.a.b).toEqual({ c: 7, keep: 1 });
    expect(q.a.other).toBe(2);
    expect(p.a.b.c).toBe(3);
    expect(f.get(q)).toBe(7);
  });

  it("clamps to the range, rounds ints and rejects non-finite input", () => {
    const f = numberField<P>("v", "V", { min: -5, max: 5, int: true });
    expect(f.set({ v: 0 }, 99)).toEqual({ v: 5 });
    expect(f.set({ v: 0 }, -99)).toEqual({ v: -5 });
    expect(f.set({ v: 0 }, 2.6)).toEqual({ v: 3 });
    expect(f.set({ v: 1 }, NaN)).toEqual({ v: 0 });
    expect(f.set({ v: 1 }, "3" as never)).toEqual({ v: 0 });
    expect(f.spec).toEqual({ kind: "int", min: -5, max: 5 });
  });

  it("missing values read as 0", () => {
    expect(numberField<P>("x.y", "Y").get({})).toBe(0);
    expect(numberField<P>("x", "X").get({ x: Infinity })).toBe(0);
  });

  it("derives a scrub step from the range unless given", () => {
    expect(numberField<P>("v", "V", { min: 0, max: 1 }).spec).toMatchObject({ kind: "float", step: 0.01 });
    expect(numberField<P>("v", "V", { min: 0, max: 50 }).spec).toMatchObject({ step: 0.1 });
    expect(numberField<P>("v", "V", { min: 0, max: 500 }).spec).toMatchObject({ step: 1 });
    expect(numberField<P>("v", "V").spec).toMatchObject({ step: 0.01 });
    expect(numberField<P>("v", "V", { min: 0, max: 500, step: 0.5 }).spec).toMatchObject({ step: 0.5 });
    expect(numberField<P>("v", "V", { id: "custom" }).id).toBe("custom");
  });
});

describe("boolField / textField", () => {
  it("only true is true", () => {
    const f = boolField<P>("on", "On");
    expect(f.get({ on: 1 })).toBe(false);
    expect(f.get({ on: true })).toBe(true);
    expect(f.set({}, "yes" as never)).toEqual({ on: false });
    expect(f.set({}, true)).toEqual({ on: true });
  });

  it("text fields stringify", () => {
    const f = textField<P>("name", "Name", "hint");
    expect(f.get({})).toBe("");
    expect(f.set({}, 42)).toEqual({ name: "42" });
    expect(f.spec).toEqual({ kind: "string", placeholder: "hint" });
  });
});

describe("enumField", () => {
  const opts = [
    ["a", "A"],
    ["b", "B"],
  ] as const;

  it("falls back to the first option for unknown values", () => {
    const f = enumField<P>("mode", "Mode", opts);
    expect(f.get({})).toBe("a");
    expect(f.set({}, "b")).toEqual({ mode: "b" });
    expect(f.set({}, "zzz")).toEqual({ mode: "a" });
    expect(f.spec).toEqual({
      kind: "enum",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });
  });

  it("numeric enums store numbers and read their decimal text", () => {
    const f = enumField<P>("n", "N", [["0", "Zero"], ["2", "Two"]], { numeric: true });
    expect(f.set({}, "2")).toEqual({ n: 2 });
    expect(f.get({ n: 2 })).toBe("2");
    expect(f.set({}, 7)).toEqual({ n: 0 });
  });
});

describe("colour fields", () => {
  it("rgbField maps 0–255 objects to sRGB 0–1 with opaque alpha, clamping writes", () => {
    const f = rgbField<P>("c", "C");
    expect(f.get({ c: { r: 255, g: 0, b: 51 } })).toEqual([1, 0, 0.2, 1]);
    expect(f.set({}, [2, -1, 0.5, 0.1])).toEqual({ c: { r: 255, g: 0, b: 128 } });
    expect(f.get({})).toEqual([0, 0, 0, 1]);
  });

  it("rgbaField keeps alpha and defaults missing alpha to opaque", () => {
    const f = rgbaField<P>("c", "C");
    expect(f.get({ c: { r: 0, g: 0, b: 0 } })).toEqual([0, 0, 0, 1]);
    expect(f.set({}, [1, 1, 1, 0.5])).toEqual({ c: { r: 255, g: 255, b: 255, a: 128 } });
    expect(f.set({}, [1, 1, 1] as never)).toEqual({ c: { r: 255, g: 255, b: 255, a: 255 } });
  });

  it("rgbSplitField writes three separate channels", () => {
    const f = rgbSplitField<P>("fg", "FG", ["fgR", "fgG", "fgB"]);
    expect(f.set({ other: 1 }, [1, 0.5, 0, 1])).toEqual({ other: 1, fgR: 255, fgG: 128, fgB: 0 });
    expect(f.get({ fgR: 255, fgG: 0, fgB: 0 })).toEqual([1, 0, 0, 1]);
  });

  it("colour round trips are exact for byte values", () => {
    const f = rgbaField<P>("c", "C");
    for (let v = 0; v <= 255; v += 17) {
      const p = { c: { r: v, g: 255 - v, b: v, a: v } };
      expect(f.set({}, f.get(p))).toEqual(p);
    }
  });
});

describe("vec2Field / customField / fieldSpec / applyFieldValues", () => {
  it("vec2 reads and writes two paths", () => {
    const f = vec2Field<P>("center", "Center", ["cx", "cy"]);
    expect(f.get({ cx: 0.25, cy: 0.75 })).toEqual([0.25, 0.75]);
    expect(f.set({}, [0.1, 0.9])).toEqual({ cx: 0.1, cy: 0.9 });
    expect(f.set({}, "x" as never)).toEqual({ cx: 0, cy: 0 });
    expect(f.spec).toEqual({ kind: "vec2", step: 0.01 });
  });

  it("customField is the identity", () => {
    const f = numberField<P>("v", "V");
    expect(customField(f)).toBe(f);
  });

  it("fieldSpec fills the default from the defaults object", () => {
    expect(fieldSpec(numberField<P>("v", "V", { min: 0, max: 2 }), { v: 1.5 })).toEqual({
      kind: "float",
      min: 0,
      max: 2,
      step: 0.01,
      default: 1.5,
    });
  });

  it("applyFieldValues applies known ids in field order and ignores unknown / undefined ones", () => {
    const fields = [numberField<P>("a", "A", { max: 10 }), boolField<P>("b", "B")];
    const out = applyFieldValues(fields, { a: 1, b: false, c: 3 }, { a: 50, b: undefined, zzz: 1 });
    expect(out).toEqual({ a: 10, b: false, c: 3 });
  });
});
