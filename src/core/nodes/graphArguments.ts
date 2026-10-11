/**
 * Effect arguments (`NodeGraph.arguments`): defaults, value specs for the
 * editors, and range clamping shared by the shader editor, the effect's
 * settings window and rendering.
 */
import type { ArgumentType, GraphArgument, ParamValue } from "./graphTypes";
import type { ParamSpec } from "./INode";

export const ARGUMENT_TYPES: readonly { type: ArgumentType; label: string }[] = [
  { type: "float", label: "Float" },
  { type: "int", label: "Integer" },
  { type: "bool", label: "Boolean" },
  { type: "vec2", label: "Vector" },
  { type: "color", label: "Color" },
];

export function newArgumentId(): string {
  return `a_${crypto.randomUUID().slice(0, 8)}`;
}

export function defaultArgumentValue(type: ArgumentType): ParamValue {
  switch (type) {
    case "float":
    case "int":
      return 0;
    case "bool":
      return false;
    case "vec2":
      return [0, 0];
    case "color":
      return [1, 1, 1, 1];
  }
}

export const isNumericArgument = (a: GraphArgument): boolean =>
  a.type === "float" || a.type === "int" || a.type === "vec2";

/** Editor spec for an argument's value (range applied). */
export function argumentSpec(a: GraphArgument, value: ParamValue = a.default): ParamSpec {
  switch (a.type) {
    case "float":
      return { kind: "float", default: Number(value) || 0, min: a.min, max: a.max, step: a.step ?? 0.01 };
    case "int":
      return { kind: "int", default: Number(value) || 0, min: a.min, max: a.max };
    case "bool":
      return { kind: "bool", default: value === true };
    case "vec2":
      return {
        kind: "vec2",
        default: Array.isArray(value) && value.length === 2 ? (value as [number, number]) : [0, 0],
        step: a.step ?? 0.01,
      };
    case "color":
      return {
        kind: "color",
        default:
          Array.isArray(value) && value.length === 4
            ? (value as [number, number, number, number])
            : [1, 1, 1, 1],
      };
  }
}

const clampNum = (v: number, a: GraphArgument): number => {
  let r = a.type === "int" ? Math.round(v) : v;
  if (a.min !== undefined) r = Math.max(a.min, r);
  if (a.max !== undefined) r = Math.min(a.max, r);
  return r;
};

/** `value` coerced to the argument's type and clamped to its range;
 *  falls back to the default when the shape doesn't fit. */
export function resolveArgumentValue(a: GraphArgument, value: ParamValue | undefined): ParamValue {
  const v = value ?? a.default;
  switch (a.type) {
    case "float":
    case "int":
      return clampNum(typeof v === "number" ? v : Number(a.default) || 0, a);
    case "bool":
      return typeof v === "boolean" ? v : a.default === true;
    case "vec2": {
      const xy = Array.isArray(v) && v.length === 2 ? v : [0, 0];
      return [clampNum(xy[0], a), clampNum(xy[1], a)] as const;
    }
    case "color":
      return Array.isArray(v) && v.length === 4 ? v : [1, 1, 1, 1];
  }
}
