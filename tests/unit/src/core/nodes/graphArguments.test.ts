import { describe, expect, it } from "vitest";
import {
  ARGUMENT_TYPES,
  argumentSpec,
  defaultArgumentValue,
  isNumericArgument,
  newArgumentId,
  resolveArgumentValue,
} from "@/core/nodes/graphArguments";
import type { ArgumentType, GraphArgument } from "@/core/nodes/graphTypes";

const arg = (type: ArgumentType, extra: Partial<GraphArgument> = {}): GraphArgument => ({
  id: "a",
  name: "A",
  type,
  default: defaultArgumentValue(type),
  ...extra,
});

describe("resolveArgumentValue", () => {
  it("clamps floats to the range", () => {
    const a = arg("float", { default: 0.5, min: 0, max: 1 });
    expect(resolveArgumentValue(a, 2)).toBe(1);
    expect(resolveArgumentValue(a, -3)).toBe(0);
    expect(resolveArgumentValue(a, 0.25)).toBe(0.25);
    expect(resolveArgumentValue(a, undefined)).toBe(0.5);
  });

  it("rounds and clamps ints", () => {
    const a = arg("int", { default: 3, min: 1, max: 10 });
    expect(resolveArgumentValue(a, 4.6)).toBe(5);
    expect(resolveArgumentValue(a, 99)).toBe(10);
    expect(resolveArgumentValue(a, 0.2)).toBe(1);
  });

  it("leaves unbounded numbers alone", () => {
    expect(resolveArgumentValue(arg("float"), -1e6)).toBe(-1e6);
    expect(resolveArgumentValue(arg("float", { min: 0 }), 1e6)).toBe(1e6);
  });

  it("falls back to the (clamped) default when the value has the wrong shape", () => {
    const a = arg("float", { default: 5, min: 0, max: 2 });
    expect(resolveArgumentValue(a, "x")).toBe(2);
    expect(resolveArgumentValue(a, [1, 2])).toBe(2);
    expect(resolveArgumentValue(arg("bool", { default: true }), 1)).toBe(true);
    expect(resolveArgumentValue(arg("bool"), false)).toBe(false);
  });

  it("clamps each vec2 component", () => {
    const a = arg("vec2", { default: [0, 0], min: -1, max: 1 });
    expect(resolveArgumentValue(a, [5, -5])).toEqual([1, -1]);
    expect(resolveArgumentValue(a, [0.5] as never)).toEqual([0, 0]);
  });

  it("passes colours through and replaces malformed ones with white", () => {
    const a = arg("color");
    expect(resolveArgumentValue(a, [0.1, 0.2, 0.3, 0.4])).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(resolveArgumentValue(a, [1, 2])).toEqual([1, 1, 1, 1]);
    expect(resolveArgumentValue(a, 3)).toEqual([1, 1, 1, 1]);
  });

  it("is idempotent", () => {
    const cases: [GraphArgument, unknown][] = [
      [arg("float", { min: 0, max: 1 }), 7],
      [arg("int", { min: -2, max: 2 }), 1.5],
      [arg("vec2", { min: 0, max: 1 }), [3, -3]],
      [arg("bool"), "yes"],
      [arg("color"), [0.5, 0.5, 0.5, 1]],
    ];
    for (const [a, v] of cases) {
      const once = resolveArgumentValue(a, v as never);
      expect(resolveArgumentValue(a, once)).toEqual(once);
    }
  });
});

describe("argument helpers", () => {
  it("offers every argument type with a default of the right shape", () => {
    expect(ARGUMENT_TYPES.map((t) => t.type)).toEqual(["float", "int", "bool", "vec2", "color"]);
    for (const { type } of ARGUMENT_TYPES) {
      const a = arg(type);
      expect(resolveArgumentValue(a, a.default)).toEqual(a.default);
      expect(argumentSpec(a).kind).toBe(type);
    }
  });

  it("builds editor specs carrying the range and the current value", () => {
    expect(argumentSpec(arg("float", { min: 0, max: 2, step: 0.5 }), 1.5)).toEqual({
      kind: "float",
      default: 1.5,
      min: 0,
      max: 2,
      step: 0.5,
    });
    expect(argumentSpec(arg("int", { min: 1 }), 4)).toMatchObject({ kind: "int", default: 4, min: 1 });
    expect(argumentSpec(arg("vec2"), "bad" as never)).toMatchObject({ kind: "vec2", default: [0, 0] });
    expect(argumentSpec(arg("color"), [0, 0, 0, 1])).toEqual({ kind: "color", default: [0, 0, 0, 1] });
  });

  it("classifies numeric arguments", () => {
    expect(["float", "int", "vec2"].every((t) => isNumericArgument(arg(t as ArgumentType)))).toBe(true);
    expect(isNumericArgument(arg("bool"))).toBe(false);
    expect(isNumericArgument(arg("color"))).toBe(false);
  });

  it("creates distinct ids", () => {
    const ids = new Set(Array.from({ length: 20 }, newArgumentId));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^a_[0-9a-f]{8}$/);
  });
});
