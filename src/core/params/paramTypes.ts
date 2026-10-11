/**
 * User-editable parameter values and their editor specs. Shared by node
 * graphs (inline inputs, node parameters), effect parameter schemas and
 * document operations, so one value model drives every surface.
 */

/** A square convolution kernel, `size × size` weights in row order. */
export interface KernelValue {
  readonly size: number;
  readonly weights: readonly number[];
}

/** A user-editable value stored on a node: an inline input value or a
 *  node parameter. Colours are `[r, g, b, a]` in sRGB 0–1. */
export type ParamValue =
  | number
  | boolean
  | string
  | readonly [number, number]
  | readonly [number, number, number, number]
  | KernelValue;

export function isKernelValue(v: unknown): v is KernelValue {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "weights" in v;
}

/** Editor for a user-entered value, used both by parameters and by inline
 *  values on unconnected inputs. */
export type ParamSpec =
  | {
      kind: "float";
      default: number;
      min?: number;
      max?: number;
      /** Value change per pixel of horizontal scrub. */
      step?: number;
    }
  | { kind: "int"; default: number; min?: number; max?: number }
  | { kind: "bool"; default: boolean }
  | {
      kind: "enum";
      default: string;
      options: readonly { value: string; label: string }[];
    }
  /** sRGB 0–1. */
  | { kind: "color"; default: readonly [number, number, number, number] }
  | { kind: "vec2"; default: readonly [number, number]; step?: number }
  | { kind: "string"; default: string; placeholder?: string }
  /** Square convolution kernel (odd size); weights edited in a grid. */
  | {
      kind: "kernel";
      default: KernelValue;
      sizes: readonly number[];
      /** Offered in the editor; `build` returns size × size weights. */
      presets?: readonly { label: string; build(size: number): number[] }[];
    };

