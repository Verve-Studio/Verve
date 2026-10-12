/**
 * Port type conversions exist twice — `convertExpr` (WGSL, shader graphs)
 * and `convertValue` (automation) — and must stay in sync. Every pair of
 * per-pixel port types is converted both ways and compared; the WGSL is
 * run by test/fakes/nodesWgslEval.
 */
import { describe, expect, it } from "vitest";
import { convertExpr, packValue, wgslType } from "@/core/nodes/wgsl";
import { convertValue, formatValue, makeList, valuesEqual, type RuntimeValue } from "@/core/nodes/values";
import { canConnectTypes, isSingleLink } from "@/core/nodes/portTypes";
import type { PortType } from "@/core/nodes/INode";
import { loadWgsl, f32v, vec, type WVec } from "@tests/fakes/nodesWgslEval";

const PIXEL_TYPES = ["float", "int", "bool", "vec2", "vec3", "color"] as const;
type PixelType = (typeof PIXEL_TYPES)[number];
const ALL_TYPES: PortType[] = [
  "exec", "float", "int", "bool", "vec2", "vec3", "color", "string", "image", "layer", "document", "list", "any",
];

const SAMPLES: Record<PixelType, RuntimeValue[]> = {
  float: [0, 1, 2.75, -1.25],
  int: [0, 1, 3, -2],
  bool: [true, false],
  vec2: [[0.25, -1.5], [0, 0], [2, 3]],
  vec3: [[0.2, 0.4, 0.9], [1, 1, 1], [-1, 0, 2]],
  color: [[0.1, 0.5, 0.9, 0.5], [1, 1, 1, 1], [0, 0, 0, 0]],
};
/** Fractional and out-of-0/1 scalars: where int / bool conversions differ. */
const FRACTIONAL: Record<"float" | "vec2" | "vec3" | "color", RuntimeValue[]> = {
  float: [0.3, 0.7, 2],
  vec2: [[0.3, 0.6]],
  vec3: [[0.3, 0.3, 0.3]],
  color: [[0.3, 0.3, 0.3, 1]],
};

/** A runtime value as the WGSL value of its port type. */
function toWgsl(v: RuntimeValue): WVec {
  if (typeof v === "boolean") return f32v(v ? 1 : 0);
  if (typeof v === "number") return f32v(v);
  return vec("f", [...(v as number[])]);
}

const DECL = { f32: "f32", vec2f: "vec2f", vec3f: "vec3f", vec4f: "vec4f" } as const;

/** Run `convertExpr` on a WGSL value. */
function wgslConvert(v: RuntimeValue, from: PixelType, to: PixelType): number[] {
  const code = `fn conv(x: ${DECL[wgslType(from)!]}) -> ${DECL[wgslType(to)!]} {
  return ${convertExpr("x", from, to)};
}`;
  const out = loadWgsl(code).call("conv", [toWgsl(v)]) as WVec;
  return out.c;
}

/** `convertValue` as the numbers the shader would hold. Shader bools are
 *  f32 read as `> 0.5`; compare them as 0 / 1. */
function jsConvert(v: RuntimeValue, to: PixelType): number[] {
  const c = convertValue(v, to);
  if (typeof c === "boolean") return [c ? 1 : 0];
  if (typeof c === "number") return [c];
  return [...(c as number[])];
}

function asShaderReads(values: number[], to: PixelType): number[] {
  // A bool consumer thresholds at 0.5 (Compare / Boolean Math / If / Else).
  return to === "bool" ? values.map((x) => (x > 0.5 ? 1 : 0)) : values;
}

const close = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-6);

const pairs = PIXEL_TYPES.flatMap((from) => PIXEL_TYPES.map((to) => [from, to] as const));

describe("convertExpr ↔ convertValue", () => {
  it("connect rules: every per-pixel type converts into every other", () => {
    for (const [from, to] of pairs) expect(canConnectTypes(from, to), `${from}→${to}`).toBe(true);
  });

  it("convertExpr is identity for types without a WGSL form", () => {
    for (const from of ALL_TYPES) {
      for (const to of ALL_TYPES) {
        if (wgslType(from) && wgslType(to)) continue;
        expect(convertExpr("E", from, to)).toBe("E");
      }
    }
  });

  it.each(pairs)("%s → %s produces the target's shape in both domains", (from, to) => {
    const width = { f32: 1, vec2f: 2, vec3f: 3, vec4f: 4 }[wgslType(to)!];
    for (const v of SAMPLES[from]) {
      expect(wgslConvert(v, from, to)).toHaveLength(width);
      expect(jsConvert(v, to)).toHaveLength(width);
    }
  });

  it.each(pairs)("%s → %s agrees on representative values", (from, to) => {
    for (const v of SAMPLES[from]) {
      const w = asShaderReads(wgslConvert(v, from, to), to);
      const j = jsConvert(v, to);
      expect(close(w, j), `${JSON.stringify(v)}: wgsl ${JSON.stringify(w)} vs js ${JSON.stringify(j)}`).toBe(true);
    }
  });

  it.each(["float", "vec2", "vec3", "color"] as const)("%s → int agrees on fractional values", (from) => {
    for (const v of FRACTIONAL[from]) {
      expect(wgslConvert(v, from, "int")).toEqual(jsConvert(v, "int"));
    }
  });

  it.each(["float", "vec2", "vec3", "color"] as const)("%s → bool agrees on fractional values", (from) => {
    for (const v of FRACTIONAL[from]) {
      expect(asShaderReads(wgslConvert(v, from, "bool"), "bool")).toEqual(jsConvert(v, "bool"));
    }
  });

  it("int → bool → float round-trips to 0 / 1 in both domains", () => {
    const w = wgslConvert(wgslConvert(3, "int", "bool")[0], "bool", "float");
    const j = jsConvert(convertValue(3, "bool"), "float");
    expect(w).toEqual(j);
  });
});

describe("convertValue", () => {
  it("wraps single values into one-item lists and keeps lists", () => {
    expect(convertValue(5, "list")).toEqual(makeList([5]));
    const list = makeList([1, 2]);
    expect(convertValue(list, "list")).toBe(list);
    expect(convertValue(null, "list")).toEqual(makeList([]));
    const layer = { kind: "layer", id: "l1", name: "L", docId: "d" } as const;
    expect(convertValue(layer, "list")).toEqual(makeList([layer]));
  });

  it("formats values as text", () => {
    expect(convertValue(1.5, "string")).toBe("1.5");
    expect(convertValue(true, "string")).toBe("true");
    expect(convertValue(null, "string")).toBe("null");
    expect(convertValue([0.123456, 1], "string")).toBe("(0.1235, 1)");
    expect(convertValue(makeList([1, "a"]), "string")).toBe("[1, a]");
    expect(formatValue({ kind: "document", id: "d", name: "Doc" })).toBe("Doc");
  });

  it("reads lists and text as scalars", () => {
    expect(convertValue(makeList([1, 2, 3]), "float")).toBe(3);
    expect(convertValue("2.5", "float")).toBe(2.5);
    expect(convertValue("abc", "float")).toBe(0);
  });

  it("passes values through any / layer / document ports", () => {
    const layer = { kind: "layer", id: "l1", name: "L", docId: "d" } as const;
    expect(convertValue(layer, "layer")).toBe(layer);
    expect(convertValue(7, "any")).toBe(7);
  });

  it("compares values structurally", () => {
    expect(valuesEqual([1, 2], [1, 2])).toBe(true);
    expect(valuesEqual([1, 2], [1, 3])).toBe(false);
    expect(valuesEqual(makeList([1, [2, 3]]), makeList([1, [2, 3]]))).toBe(true);
    expect(
      valuesEqual({ kind: "layer", id: "a", name: "x", docId: "d" }, { kind: "layer", id: "a", name: "y", docId: "d" }),
    ).toBe(true);
    expect(valuesEqual({ kind: "layer", id: "a", name: "x", docId: "d" }, { kind: "document", id: "a", name: "x" })).toBe(
      false,
    );
    expect(valuesEqual(1, true)).toBe(false);
  });
});

describe("port rules", () => {
  it("exec only connects to exec; any accepts every value type", () => {
    for (const t of ALL_TYPES) {
      expect(canConnectTypes("exec", t)).toBe(t === "exec");
      expect(canConnectTypes(t, "exec")).toBe(t === "exec");
      if (t !== "exec") {
        expect(canConnectTypes("any", t)).toBe(true);
        expect(canConnectTypes(t, "any")).toBe(true);
        expect(canConnectTypes(t, "list"), `${t} → list`).toBe(true);
      }
    }
    expect(canConnectTypes("string", "float")).toBe(false);
    expect(canConnectTypes("layer", "document")).toBe(false);
  });

  it("data inputs take one link, exec outputs continue to one node", () => {
    expect(isSingleLink("float", "in")).toBe(true);
    expect(isSingleLink("float", "out")).toBe(false);
    expect(isSingleLink("exec", "out")).toBe(true);
    expect(isSingleLink("exec", "in")).toBe(false);
  });
});

describe("packValue", () => {
  it("packs scalars, vectors and colours into one vec4 slot", () => {
    expect(packValue(2, false)).toEqual({ data: [2, 0, 0, 0], type: "float", swizzle: ".x" });
    expect(packValue(true, false)).toEqual({ data: [1, 0, 0, 0], type: "float", swizzle: ".x" });
    expect(packValue([3, 4], false)).toEqual({ data: [3, 4, 0, 0], type: "vec2", swizzle: ".xy" });
    expect(packValue([1, 0.5, 0, 0.25], false)).toEqual({ data: [1, 0.5, 0, 0.25], type: "color", swizzle: "" });
    expect(packValue("text", false)).toBeNull();
    expect(packValue({ size: 1, weights: [1] }, false)).toBeNull();
  });

  it("decodes colour RGB (not alpha) to linear for float documents", () => {
    const p = packValue([0.5, 1, 0, 0.5], true)!;
    expect(p.data[0]).toBeCloseTo(0.214, 3);
    expect(p.data[1]).toBe(1);
    expect(p.data[2]).toBe(0);
    expect(p.data[3]).toBe(0.5);
  });
});
