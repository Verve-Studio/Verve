/**
 * Automation runtime values and implicit conversions. Mirrors the WGSL
 * conversions in `wgsl.ts` so a node behaves the same in both domains.
 */
import type { PortType } from "./INode";

/** A layer handle passed between automation nodes. */
export interface LayerRef {
  readonly id: string;
  readonly name: string;
}

/** float/int → number, bool → boolean, vec2/vec3/color → number tuple
 *  (color is sRGB 0–1 RGBA), string → string, layer → LayerRef. */
export type RuntimeValue = number | boolean | string | readonly number[] | LayerRef | null;

export type ExportFormat = "png" | "jpeg" | "webp" | "tiff";

export interface DocumentInfo {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** "rgba8" | "rgba32f" | "indexed8". */
  readonly format: string;
}

export interface LayerProperties {
  readonly name: string;
  /** "pixel" | "text" | "shape" | "group" | "composite" | … */
  readonly kind: string;
  readonly visible: boolean;
  readonly opacity: number;
  /** Top-left on the canvas and size, in pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The application operations automation nodes drive. Implemented by the
 * app; nodes only see this interface.
 */
export interface AutomationHost {
  document(): DocumentInfo;
  layerProperties(layer: LayerRef): LayerProperties;
  activeLayer(): LayerRef | null;
  /** Top-to-bottom. */
  layers(options: { visibleOnly: boolean }): LayerRef[];
  newLayer(name: string): Promise<LayerRef>;
  setLayerOpacity(layer: LayerRef, opacity: number): Promise<void>;
  renameLayer(layer: LayerRef, name: string): Promise<void>;
  exportImage(path: string, format: ExportFormat): Promise<void>;
  log(message: string): void;
}

export function isLayerRef(v: RuntimeValue | undefined): v is LayerRef {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "id" in v;
}

const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** Scalar view of a value (vec3 → average, color → luminance). */
function toScalar(v: RuntimeValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return Number(v) || 0;
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

function format(v: RuntimeValue): string {
  if (v === null) return "null";
  if (isLayerRef(v)) return v.name;
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
      return format(v);
    default:
      return v;
  }
}
