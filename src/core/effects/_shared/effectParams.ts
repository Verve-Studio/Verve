/**
 * Declarative parameter schema for an effect (`IPipelineEffect.paramFields`).
 *
 * Each field maps one user-facing value onto the effect's params object:
 * an editor spec (range, step, enum options, …) plus a getter / immutable
 * setter for the value's place in the params (a dotted path, or custom
 * logic). Surfaces that edit effects without the effect's own panel — the
 * automation graph's effect nodes — are generated from it, so ranges and
 * option lists live in one place next to the effect.
 *
 * Values cross the boundary in the shared `ParamValue` model: numbers,
 * booleans, strings (enums) and colours as sRGB 0–1 `[r, g, b, a]`. The
 * builders convert from the params' own representation (e.g. `{r, g, b}`
 * in 0–255).
 */
import type { ParamSpec, ParamValue } from "@/core/params/paramTypes";

/** Spec without its default: the default comes from the effect's
 *  `defaultParams` through the field's getter. */
type SpecTemplate<S = ParamSpec> = S extends ParamSpec ? Omit<S, "default"> : never;

export interface EffectParamField<P = unknown> {
  /** Stable id (used as the node port id). */
  readonly id: string;
  readonly label: string;
  readonly spec: SpecTemplate;
  get(params: P): ParamValue;
  /** Returns a new params object with the value applied. */
  set(params: P, value: ParamValue): P;
}

/** The field's full spec, defaulting to its value in `defaults`. */
export function fieldSpec<P>(field: EffectParamField<P>, defaults: P): ParamSpec {
  return { ...field.spec, default: field.get(defaults) } as ParamSpec;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Obj)[key];
  }
  return cur;
}

function setPath<P>(obj: P, path: string, value: unknown): P {
  const [head, ...rest] = path.split(".");
  const base = (obj ?? {}) as Obj;
  return {
    ...base,
    [head]: rest.length === 0 ? value : setPath(base[head], rest.join("."), value),
  } as P;
}

const idOf = (path: string): string => path.replace(/\./g, "_");

// ─── Conversions ────────────────────────────────────────────────────────────

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const to255 = (v: number): number => Math.round(clamp01(v) * 255);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const asColor = (v: ParamValue): readonly number[] =>
  Array.isArray(v) ? (v as readonly number[]) : [0, 0, 0, 1];

// ─── Builders ───────────────────────────────────────────────────────────────

interface NumberOptions {
  min?: number;
  max?: number;
  /** Value change per pixel of scrub (floats only). */
  step?: number;
  /** Integer-valued (rounded on write). */
  int?: boolean;
  /** Field id when it should differ from the path. */
  id?: string;
}

/** A number at `path`. */
export function numberField<P>(path: string, label: string, o: NumberOptions = {}): EffectParamField<P> {
  const lo = o.min;
  const hi = o.max;
  return {
    id: o.id ?? idOf(path),
    label,
    spec: o.int
      ? { kind: "int", min: lo, max: hi }
      : { kind: "float", min: lo, max: hi, step: o.step ?? defaultStep(lo, hi) },
    get: (p) => num(getPath(p, path)),
    set: (p, v) => {
      let n = num(v);
      if (o.int) n = Math.round(n);
      if (lo !== undefined) n = Math.max(lo, n);
      if (hi !== undefined) n = Math.min(hi, n);
      return setPath(p, path, n);
    },
  };
}

function defaultStep(min?: number, max?: number): number {
  if (min === undefined || max === undefined) return 0.01;
  const span = max - min;
  return span > 100 ? 1 : span > 10 ? 0.1 : 0.01;
}

/** A boolean at `path`. */
export function boolField<P>(path: string, label: string, id?: string): EffectParamField<P> {
  return {
    id: id ?? idOf(path),
    label,
    spec: { kind: "bool" },
    get: (p) => getPath(p, path) === true,
    set: (p, v) => setPath(p, path, v === true),
  };
}

/** An enum at `path`. `numeric` enums store their value as a number
 *  (the option values are its decimal text, e.g. "0" / "1"). */
export function enumField<P>(
  path: string,
  label: string,
  options: readonly (readonly [string, string])[],
  o: { numeric?: boolean; id?: string } = {},
): EffectParamField<P> {
  const values = options.map(([v]) => v);
  return {
    id: o.id ?? idOf(path),
    label,
    spec: { kind: "enum", options: options.map(([value, l]) => ({ value, label: l })) },
    get: (p) => String(getPath(p, path) ?? values[0]),
    set: (p, v) => {
      const s = values.includes(String(v)) ? String(v) : values[0];
      return setPath(p, path, o.numeric ? Number(s) : s);
    },
  };
}

/** A free-text string at `path`. */
export function textField<P>(path: string, label: string, placeholder?: string): EffectParamField<P> {
  return {
    id: idOf(path),
    label,
    spec: { kind: "string", placeholder },
    get: (p) => String(getPath(p, path) ?? ""),
    set: (p, v) => setPath(p, path, String(v)),
  };
}

/** An `{r, g, b}` (0–255) colour object at `path`. */
export function rgbField<P>(path: string, label: string): EffectParamField<P> {
  return {
    id: idOf(path),
    label,
    spec: { kind: "color" },
    get: (p) => {
      const c = (getPath(p, path) ?? {}) as Obj;
      return [num(c.r) / 255, num(c.g) / 255, num(c.b) / 255, 1];
    },
    set: (p, v) => {
      const [r, g, b] = asColor(v);
      return setPath(p, path, { r: to255(r), g: to255(g), b: to255(b) });
    },
  };
}

/** An `{r, g, b, a}` (0–255) colour object at `path`. */
export function rgbaField<P>(path: string, label: string): EffectParamField<P> {
  return {
    id: idOf(path),
    label,
    spec: { kind: "color" },
    get: (p) => {
      const c = (getPath(p, path) ?? {}) as Obj;
      return [num(c.r) / 255, num(c.g) / 255, num(c.b) / 255, num(c.a, 255) / 255];
    },
    set: (p, v) => {
      const [r, g, b, a = 1] = asColor(v);
      return setPath(p, path, { r: to255(r), g: to255(g), b: to255(b), a: to255(a) });
    },
  };
}

/** A colour stored as three separate 0–255 numbers (e.g. `fgR`, `fgG`, `fgB`). */
export function rgbSplitField<P>(
  id: string,
  label: string,
  paths: readonly [string, string, string],
): EffectParamField<P> {
  return {
    id,
    label,
    spec: { kind: "color" },
    get: (p) => {
      const [r, g, b] = paths.map((path) => num(getPath(p, path)) / 255);
      return [r, g, b, 1];
    },
    set: (p, v) => {
      const c = asColor(v);
      return paths.reduce((acc, path, i) => setPath(acc, path, to255(c[i] ?? 0)), p);
    },
  };
}

/** A 2D value stored as two numbers (e.g. `centerX` / `centerY`). */
export function vec2Field<P>(
  id: string,
  label: string,
  paths: readonly [string, string],
  step = 0.01,
): EffectParamField<P> {
  return {
    id,
    label,
    spec: { kind: "vec2", step },
    get: (p) => [num(getPath(p, paths[0])), num(getPath(p, paths[1]))],
    set: (p, v) => {
      const [x, y] = Array.isArray(v) ? (v as readonly number[]) : [0, 0];
      return setPath(setPath(p, paths[0], num(x)), paths[1], num(y));
    },
  };
}

/** Escape hatch for values that need custom mapping (e.g. curve points). */
export function customField<P>(field: EffectParamField<P>): EffectParamField<P> {
  return field;
}

/** Apply `values` (by field id) onto `params`. Unknown ids are ignored. */
export function applyFieldValues<P>(
  fields: readonly EffectParamField<P>[],
  params: P,
  values: Readonly<Record<string, ParamValue | undefined>>,
): P {
  let out = params;
  for (const f of fields) {
    const v = values[f.id];
    if (v !== undefined) out = f.set(out, v);
  }
  return out;
}
