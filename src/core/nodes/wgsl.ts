/**
 * WGSL helpers for shader code generation: port type → WGSL type, uniform
 * value packing and implicit conversions (mirrors `convertValue` in values.ts).
 */
import { isKernelValue, type ParamValue } from "./graphTypes";
import type { PortType } from "./INode";
import { srgbToLinearChannel } from "@/utils/pixelFormatConvert";

export type WgslType = "f32" | "vec2f" | "vec3f" | "vec4f";

/** `null` for types that have no per-pixel representation. */
export function wgslType(t: PortType): WgslType | null {
  switch (t) {
    case "float":
    case "int":
    case "bool":
      return "f32";
    case "vec2":
      return "vec2f";
    case "vec3":
      return "vec3f";
    case "color":
      return "vec4f";
    default:
      return null;
  }
}

const LUMA_WGSL = "vec3f(0.2126, 0.7152, 0.0722)";

/** Convert `expr` of port type `from` into port type `to`. */
export function convertExpr(expr: string, from: PortType, to: PortType): string {
  const a = wgslType(from);
  const b = wgslType(to);
  if (!a || !b || a === b) return expr;
  switch (`${a}>${b}`) {
    case "f32>vec2f":
      return `vec2f(${expr})`;
    case "f32>vec3f":
      return `vec3f(${expr})`;
    case "f32>vec4f":
      return `vec4f(vec3f(${expr}), 1.0)`;
    case "vec2f>f32":
      return `(${expr}).x`;
    case "vec2f>vec3f":
      return `vec3f(${expr}, 0.0)`;
    case "vec2f>vec4f":
      return `vec4f(${expr}, 0.0, 1.0)`;
    case "vec3f>f32":
      return `dot(${expr}, vec3f(1.0 / 3.0))`;
    case "vec3f>vec2f":
      return `(${expr}).xy`;
    case "vec3f>vec4f":
      return `vec4f(${expr}, 1.0)`;
    case "vec4f>f32":
      return `dot((${expr}).rgb, ${LUMA_WGSL})`;
    case "vec4f>vec2f":
      return `(${expr}).xy`;
    case "vec4f>vec3f":
      return `(${expr}).rgb`;
    default:
      return expr;
  }
}

/** An inline value packed into one `vec4f` uniform slot. */
export interface PackedValue {
  readonly data: readonly [number, number, number, number];
  /** Port type the slot's swizzle yields. */
  readonly type: PortType;
  readonly swizzle: "" | ".x" | ".xy";
}

/**
 * Pack an inline value for the uniform buffer. Colours are stored
 * sRGB-encoded and are decoded to linear when `linear` is set. Returns
 * `null` for values with no WGSL form (strings).
 */
export function packValue(value: ParamValue, linear: boolean): PackedValue | null {
  if (typeof value === "number") return { data: [value, 0, 0, 0], type: "float", swizzle: ".x" };
  if (typeof value === "boolean") {
    return { data: [value ? 1 : 0, 0, 0, 0], type: "float", swizzle: ".x" };
  }
  if (typeof value === "string" || isKernelValue(value)) return null;
  if (value.length === 2) return { data: [value[0], value[1], 0, 0], type: "vec2", swizzle: ".xy" };
  const c = (i: number): number => (linear ? srgbToLinearChannel(value[i]) : value[i]);
  return { data: [c(0), c(1), c(2), value[3]], type: "color", swizzle: "" };
}

/** Identifier-safe version of a port / node id. */
export function ident(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_");
}
