/**
 * Automation runtime values and implicit conversions. Mirrors the WGSL
 * conversions in `wgsl.ts` so a node behaves the same in both domains.
 */
import type { PortType } from "./INode";

/** A layer handle passed between automation nodes. `docId` is the
 *  document (tab) the layer lives in. */
export interface LayerRef {
  readonly kind: "layer";
  readonly id: string;
  readonly name: string;
  readonly docId: string;
}

/** An open document (tab). */
export interface DocumentRef {
  readonly kind: "document";
  readonly id: string;
  readonly name: string;
}

/** A dynamic array. Lists are immutable values: list nodes return new ones. */
export interface ListValue {
  readonly kind: "list";
  readonly items: readonly RuntimeValue[];
}

/** float/int → number, bool → boolean, vec2/vec3/color → number tuple
 *  (color is sRGB 0–1 RGBA), string → string, layer → LayerRef,
 *  document → DocumentRef, list → ListValue. */
export type RuntimeValue =
  | number
  | boolean
  | string
  | readonly number[]
  | LayerRef
  | DocumentRef
  | ListValue
  | null;

type Tagged = LayerRef | DocumentRef | ListValue;

const tagOf = (v: RuntimeValue | undefined): Tagged["kind"] | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Tagged).kind : null;

export function isLayerRef(v: RuntimeValue | undefined): v is LayerRef {
  return tagOf(v) === "layer";
}

export function isDocumentRef(v: RuntimeValue | undefined): v is DocumentRef {
  return tagOf(v) === "document";
}

export function isList(v: RuntimeValue | undefined): v is ListValue {
  return tagOf(v) === "list";
}

export function makeList(items: readonly RuntimeValue[]): ListValue {
  return { kind: "list", items };
}

const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** Scalar view of a value (vec3 → average, color → luminance). */
function toScalar(v: RuntimeValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return Number(v) || 0;
  if (isList(v)) return v.items.length;
  if (Array.isArray(v)) {
    if (v.length === 4) return v[0] * LUMA[0] + v[1] * LUMA[1] + v[2] * LUMA[2];
    if (v.length === 3) return (v[0] + v[1] + v[2]) / 3;
    return v[0] ?? 0;
  }
  return 0;
}

function toVector(v: RuntimeValue, n: 2 | 3 | 4): number[] {
  if (Array.isArray(v)) {
    const out = v.slice(0, n);
    while (out.length < n) out.push(out.length === 3 ? 1 : 0);
    return out;
  }
  const s = toScalar(v);
  return n === 4 ? [s, s, s, 1] : new Array(n).fill(s);
}

export function formatValue(v: RuntimeValue): string {
  if (v === null) return "null";
  if (isLayerRef(v) || isDocumentRef(v)) return v.name;
  if (isList(v)) return `[${v.items.map(formatValue).join(", ")}]`;
  if (Array.isArray(v)) return `(${v.map((x) => +x.toFixed(4)).join(", ")})`;
  return String(v);
}

/** Convert a value to what a port of type `to` expects. */
export function convertValue(v: RuntimeValue, to: PortType): RuntimeValue {
  switch (to) {
    case "float":
      return toScalar(v);
    case "int":
      return Math.round(toScalar(v));
    case "bool":
      return typeof v === "boolean" ? v : toScalar(v) !== 0;
    case "vec2":
      return toVector(v, 2);
    case "vec3":
      return toVector(v, 3);
    case "color":
      return toVector(v, 4);
    case "string":
      return formatValue(v);
    case "list":
      // A single value becomes a one-item list.
      return isList(v) ? v : makeList(v === null ? [] : [v]);
    default:
      return v;
  }
}

/** Structural equality (tuples and lists by item, refs by id). */
export function valuesEqual(a: RuntimeValue, b: RuntimeValue): boolean {
  if (a === b) return true;
  if (isList(a) && isList(b)) {
    return a.items.length === b.items.length && a.items.every((x, i) => valuesEqual(x, b.items[i]));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  const ta = tagOf(a);
  if (ta && ta === tagOf(b)) return (a as LayerRef | DocumentRef).id === (b as LayerRef | DocumentRef).id;
  return false;
}
