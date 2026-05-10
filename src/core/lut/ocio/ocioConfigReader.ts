// ─── OCIO config importer (subset) ───────────────────────────────────────────
//
// Loads an OCIO directory selection (config.ocio + LUT files), resolves a
// useful subset of transforms, bakes each colour space's `from_reference`
// chain into a 33³ LutTransform, and registers the result with `lutStore`.
//
// Supported transforms (sufficient for typical ACES configs and
// look-emulation packs):
//
//   - GroupTransform  — sequence its children
//   - MatrixTransform — 4×4 row-major (we use the upper 3×3)
//   - ExponentTransform — per-channel power
//   - ExponentWithLinearTransform — sRGB-style piecewise transfer
//   - FileTransform   — references a `.cube` file (3D LUT body)
//
// Anything else is skipped with a console warning. Built ACES-style
// configs typically combine MatrixTransform + FileTransform + ExponentTransform,
// which is exactly the surface this importer covers.

import type { ShaperLut } from "../LUT";
import { lutStore } from "../lutStore";
import { parseCubeLut } from "../parseCubeLut";
import { parseYaml, type YamlValue } from "./yaml";

const CUBE_SIZE = 33;

interface OcioRoot {
  __tag?: string;
  search_path?: string | string[];
  colorspaces?: YamlValue;
  roles?: { [k: string]: string };
  looks?: YamlValue;
  displays?: YamlValue;
}

function asObj(v: YamlValue): { [k: string]: YamlValue } | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as { [k: string]: YamlValue })
    : null;
}
function asArray(v: YamlValue): YamlValue[] | null {
  return Array.isArray(v) ? v : null;
}

// ─── Transforms ─────────────────────────────────────────────────────────────

type Transform = (rgb: [number, number, number]) => [number, number, number];

const IDENTITY: Transform = (rgb) => rgb;

function compose(transforms: Transform[]): Transform {
  if (transforms.length === 0) return IDENTITY;
  if (transforms.length === 1) return transforms[0];
  return (rgb) => transforms.reduce((c, t) => t(c), rgb);
}

function matrixTransform(matrix: number[]): Transform {
  // Accept 16-element row-major 4×4; use the top-left 3×3 for RGB.
  if (matrix.length < 9) return IDENTITY;
  const m =
    matrix.length === 16
      ? [
          matrix[0], matrix[1], matrix[2],
          matrix[4], matrix[5], matrix[6],
          matrix[8], matrix[9], matrix[10],
        ]
      : matrix.slice(0, 9);
  return ([r, g, b]) => [
    m[0] * r + m[1] * g + m[2] * b,
    m[3] * r + m[4] * g + m[5] * b,
    m[6] * r + m[7] * g + m[8] * b,
  ];
}

function exponentTransform(values: number[]): Transform {
  const [er, eg, eb] = values;
  return ([r, g, b]) => [
    r >= 0 ? Math.pow(r, er) : -Math.pow(-r, er),
    g >= 0 ? Math.pow(g, eg) : -Math.pow(-g, eg),
    b >= 0 ? Math.pow(b, eb) : -Math.pow(-b, eb),
  ];
}

function lut1DTransform(table: number[][], domain: [number, number]): Transform {
  // OCIO `Lut1DTransform.values` is typically a flat list of N×3 floats
  // (RGB-interleaved) or N×1 (monochrome). The caller has already split it
  // into rows of 1 or 3 values.
  const N = table.length;
  if (N < 2) return IDENTITY;
  const [d0, d1] = domain;
  const span = d1 - d0;
  const sample = (t: number, channel: number): number => {
    const u = (Math.max(d0, Math.min(d1, t)) - d0) / (span || 1);
    const idx = u * (N - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, N - 1);
    const f = idx - i0;
    const row0 = table[i0];
    const row1 = table[i1];
    const c = channel < row0.length ? channel : 0;
    return row0[c] + (row1[c] - row0[c]) * f;
  };
  return ([r, g, b]) => [sample(r, 0), sample(g, 1), sample(b, 2)];
}

function logTransform(
  base: number,
  invert: boolean,
): Transform {
  // Pure-log: scene = base^signal (decode) or signal = log_base(scene) (encode).
  const lb = Math.log(base);
  if (invert) {
    // Encode: scene-linear → log-encoded.
    return ([r, g, b]) => [
      r > 0 ? Math.log(r) / lb : 0,
      g > 0 ? Math.log(g) / lb : 0,
      b > 0 ? Math.log(b) / lb : 0,
    ];
  }
  return ([r, g, b]) => [
    Math.pow(base, r),
    Math.pow(base, g),
    Math.pow(base, b),
  ];
}

function logAffineTransform(p: {
  base: number;
  logSideSlope: [number, number, number];
  logSideOffset: [number, number, number];
  linSideSlope: [number, number, number];
  linSideOffset: [number, number, number];
  invert: boolean;
}): Transform {
  // OCIO LogAffineTransform: log = logSideSlope*log(linSideSlope*lin + linSideOffset)/log(base) + logSideOffset
  const lb = Math.log(p.base);
  const fwd = (lin: number, c: number): number => {
    const inner = p.linSideSlope[c] * lin + p.linSideOffset[c];
    if (inner <= 0) return p.logSideOffset[c];
    return (p.logSideSlope[c] * Math.log(inner)) / lb + p.logSideOffset[c];
  };
  const inv = (log: number, c: number): number => {
    const inner = (log - p.logSideOffset[c]) / (p.logSideSlope[c] || 1);
    return (Math.pow(p.base, inner) - p.linSideOffset[c]) / (p.linSideSlope[c] || 1);
  };
  if (p.invert) {
    return ([r, g, b]) => [inv(r, 0), inv(g, 1), inv(b, 2)];
  }
  return ([r, g, b]) => [fwd(r, 0), fwd(g, 1), fwd(b, 2)];
}

function rangeTransform(
  minIn: number,
  maxIn: number,
  minOut: number,
  maxOut: number,
  clamp: boolean,
): Transform {
  // Linear mapping [minIn, maxIn] → [minOut, maxOut], optionally clamped.
  const inSpan = maxIn - minIn;
  const outSpan = maxOut - minOut;
  const k = outSpan / (inSpan || 1);
  const map = (v: number): number => {
    let out = minOut + (v - minIn) * k;
    if (clamp) out = Math.max(minOut, Math.min(maxOut, out));
    return out;
  };
  return ([r, g, b]) => [map(r), map(g), map(b)];
}

function cdlTransform(p: {
  slope: [number, number, number];
  offset: [number, number, number];
  power: [number, number, number];
  saturation: number;
}): Transform {
  // ASC CDL: out = (in * slope + offset)^power, then saturation around
  // luminance-preserving Rec.709 weights.
  const lumaR = 0.2126,
    lumaG = 0.7152,
    lumaB = 0.0722;
  return ([r, g, b]) => {
    const sop = (v: number, c: number): number => {
      const t = v * p.slope[c] + p.offset[c];
      return t > 0 ? Math.pow(t, p.power[c]) : 0;
    };
    const r1 = sop(r, 0);
    const g1 = sop(g, 1);
    const b1 = sop(b, 2);
    const luma = lumaR * r1 + lumaG * g1 + lumaB * b1;
    return [
      luma + (r1 - luma) * p.saturation,
      luma + (g1 - luma) * p.saturation,
      luma + (b1 - luma) * p.saturation,
    ];
  };
}

function fileTransformFromCube(cubeText: string): Transform {
  const parsed = parseCubeLut(cubeText);
  if (!parsed.cube) return IDENTITY;
  const { size, table } = parsed.cube;
  // Trilinear sampler closure.
  return ([r, g, b]) => {
    const cr = Math.max(0, Math.min(1, r)) * (size - 1);
    const cg = Math.max(0, Math.min(1, g)) * (size - 1);
    const cb = Math.max(0, Math.min(1, b)) * (size - 1);
    const r0 = Math.floor(cr), g0 = Math.floor(cg), b0 = Math.floor(cb);
    const r1 = Math.min(r0 + 1, size - 1);
    const g1 = Math.min(g0 + 1, size - 1);
    const b1 = Math.min(b0 + 1, size - 1);
    const fr = cr - r0, fg = cg - g0, fb = cb - b0;
    const fetch = (rr: number, gg: number, bb: number): [number, number, number] => {
      const i = ((bb * size + gg) * size + rr) * 3;
      return [table[i], table[i + 1], table[i + 2]];
    };
    const lerp3 = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
      [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const c00 = lerp3(fetch(r0, g0, b0), fetch(r1, g0, b0), fr);
    const c01 = lerp3(fetch(r0, g0, b1), fetch(r1, g0, b1), fr);
    const c10 = lerp3(fetch(r0, g1, b0), fetch(r1, g1, b0), fr);
    const c11 = lerp3(fetch(r0, g1, b1), fetch(r1, g1, b1), fr);
    const c0 = lerp3(c00, c10, fg);
    const c1 = lerp3(c01, c11, fg);
    return lerp3(c0, c1, fb);
  };
}

// ─── Build per-colorspace transforms ────────────────────────────────────────

function buildTransform(
  node: YamlValue,
  cubeFiles: Map<string, string>,
  warn: (msg: string) => void,
  invert = false,
): Transform {
  const obj = asObj(node);
  if (!obj || !obj.__tag) return IDENTITY;
  switch (obj.__tag) {
    case "GroupTransform": {
      const children = asArray(obj.children) ?? [];
      const ts = children.map((c) => buildTransform(c, cubeFiles, warn, invert));
      return invert ? compose([...ts].reverse()) : compose(ts);
    }
    case "MatrixTransform": {
      const m = asArray(obj.matrix);
      if (!m) return IDENTITY;
      const flat = m.map((x) => Number(x));
      return matrixTransform(flat);
    }
    case "ExponentTransform":
    case "ExponentWithLinearTransform": {
      const v = asArray(obj.value);
      if (!v) return IDENTITY;
      const exps = v.slice(0, 3).map((x) => Number(x));
      while (exps.length < 3) exps.push(exps[0] ?? 1);
      return exponentTransform(exps);
    }
    case "FileTransform": {
      const src = String(obj.src ?? "");
      const tail = src.split("/").pop();
      const text = cubeFiles.get(src) ?? (tail ? cubeFiles.get(tail) : undefined);
      if (!text) {
        warn(`OCIO FileTransform: missing source ${src}`);
        return IDENTITY;
      }
      return fileTransformFromCube(text);
    }
    case "Lut1DTransform": {
      const values = asArray(obj.values ?? null);
      if (!values) return IDENTITY;
      // OCIO encodes Lut1D as a flat list of N or N*3 numbers. Group into
      // rows of 3 (RGB) or 1 (mono) by dividing the length.
      const flat = values.map((v) => Number(v));
      const channels = flat.length % 3 === 0 ? 3 : 1;
      const rows = flat.length / channels;
      const table: number[][] = [];
      for (let i = 0; i < rows; i++) {
        const row: number[] = [];
        for (let c = 0; c < channels; c++) row.push(flat[i * channels + c]);
        table.push(row);
      }
      const dom = asArray(obj.domain ?? null);
      const domain: [number, number] = dom
        ? [Number(dom[0] ?? 0), Number(dom[1] ?? 1)]
        : [0, 1];
      return lut1DTransform(table, domain);
    }
    case "Lut3DTransform": {
      const values = asArray(obj.values ?? null);
      const sizeRaw = obj.size ?? obj.length;
      const size = Number(sizeRaw ?? 0);
      if (!values || !Number.isFinite(size) || size < 2) return IDENTITY;
      const flat = values.map((v) => Number(v));
      const expected = size * size * size * 3;
      if (flat.length < expected) return IDENTITY;
      // Materialise as a synthetic .cube body so we share the existing
      // trilinear sampler (same memory layout: bgr-major × 3).
      const cube = {
        size,
        table: new Float32Array(flat.slice(0, expected)),
      };
      return ([r, g, b]) => {
        const cr = Math.max(0, Math.min(1, r)) * (size - 1);
        const cg = Math.max(0, Math.min(1, g)) * (size - 1);
        const cb = Math.max(0, Math.min(1, b)) * (size - 1);
        const r0 = Math.floor(cr),
          g0 = Math.floor(cg),
          b0 = Math.floor(cb);
        const r1 = Math.min(r0 + 1, size - 1);
        const g1 = Math.min(g0 + 1, size - 1);
        const b1 = Math.min(b0 + 1, size - 1);
        const fr = cr - r0,
          fg = cg - g0,
          fb = cb - b0;
        const fetch = (rr: number, gg: number, bb: number): [number, number, number] => {
          const i = ((bb * size + gg) * size + rr) * 3;
          return [cube.table[i], cube.table[i + 1], cube.table[i + 2]];
        };
        const lerp3 = (a: [number, number, number], b2: [number, number, number], t: number): [number, number, number] =>
          [a[0] + (b2[0] - a[0]) * t, a[1] + (b2[1] - a[1]) * t, a[2] + (b2[2] - a[2]) * t];
        const c00 = lerp3(fetch(r0, g0, b0), fetch(r1, g0, b0), fr);
        const c01 = lerp3(fetch(r0, g0, b1), fetch(r1, g0, b1), fr);
        const c10 = lerp3(fetch(r0, g1, b0), fetch(r1, g1, b0), fr);
        const c11 = lerp3(fetch(r0, g1, b1), fetch(r1, g1, b1), fr);
        const c0 = lerp3(c00, c10, fg);
        const c1 = lerp3(c01, c11, fg);
        return lerp3(c0, c1, fb);
      };
    }
    case "LogTransform": {
      const base = Number(obj.base ?? 2);
      const dir = String(obj.direction ?? "forward");
      return logTransform(base, dir === "inverse" || invert);
    }
    case "LogAffineTransform": {
      const base = Number(obj.base ?? 2);
      const triple = (key: string, fallback: number): [number, number, number] => {
        const v = asArray(obj[key] ?? null);
        if (!v) return [fallback, fallback, fallback];
        const arr = v.slice(0, 3).map((x) => Number(x));
        while (arr.length < 3) arr.push(arr[0] ?? fallback);
        return [arr[0], arr[1], arr[2]];
      };
      const dir = String(obj.direction ?? "forward");
      return logAffineTransform({
        base,
        logSideSlope: triple("log_side_slope", 1),
        logSideOffset: triple("log_side_offset", 0),
        linSideSlope: triple("lin_side_slope", 1),
        linSideOffset: triple("lin_side_offset", 0),
        invert: dir === "inverse" || invert,
      });
    }
    case "RangeTransform": {
      const minIn = Number(obj.min_in_value ?? 0);
      const maxIn = Number(obj.max_in_value ?? 1);
      const minOut = Number(obj.min_out_value ?? minIn);
      const maxOut = Number(obj.max_out_value ?? maxIn);
      const style = String(obj.style ?? "Clamp");
      return rangeTransform(minIn, maxIn, minOut, maxOut, /^clamp/i.test(style));
    }
    case "CDLTransform": {
      const triple = (key: string, fallback: number): [number, number, number] => {
        const v = asArray(obj[key] ?? null);
        if (!v) return [fallback, fallback, fallback];
        const arr = v.slice(0, 3).map((x) => Number(x));
        while (arr.length < 3) arr.push(arr[0] ?? fallback);
        return [arr[0], arr[1], arr[2]];
      };
      const slope = triple("slope", 1);
      const offset = triple("offset", 0);
      const power = triple("power", 1);
      const saturation = Number(obj.sat ?? obj.saturation ?? 1);
      return cdlTransform({ slope, offset, power, saturation });
    }
    case "ColorSpaceTransform":
    case "DisplayViewTransform":
    case "LookTransform":
      // These reference *other* config entries by name. Resolution requires
      // the full colour-space graph + look chain — handled at the top
      // level (importOcioConfig walks displays/views/looks separately and
      // synthesizes additional LUT entries from them).
      warn(`OCIO: !<${obj.__tag}> only supported via Display/View/Look pass`);
      return IDENTITY;
    default:
      warn(`OCIO: unsupported transform !<${obj.__tag}> — skipped`);
      return IDENTITY;
  }
}

function bakeTransform(t: Transform): {
  cube: { size: number; table: Float32Array };
} {
  const N = CUBE_SIZE;
  const table = new Float32Array(N * N * N * 3);
  for (let bi = 0; bi < N; bi++) {
    const b = bi / (N - 1);
    for (let gi = 0; gi < N; gi++) {
      const g = gi / (N - 1);
      for (let ri = 0; ri < N; ri++) {
        const r = ri / (N - 1);
        const [or, og, ob] = t([r, g, b]);
        const idx = ((bi * N + gi) * N + ri) * 3;
        table[idx] = or;
        table[idx + 1] = og;
        table[idx + 2] = ob;
      }
    }
  }
  return { cube: { size: N, table } };
}

// ─── Public entry point ─────────────────────────────────────────────────────

export interface OcioBundle {
  /** Absolute path of `config.ocio` (used as a provenance marker). */
  configPath: string;
  /** Text content of `config.ocio`. */
  configText: string;
  /** Every `.cube` reachable from the config directory. `relPath` is the
   *  path relative to the directory containing `config.ocio`. */
  files: Array<{ relPath: string; text: string }>;
}

export async function importOcioConfig(bundle: OcioBundle): Promise<number> {
  const { configPath, configText, files } = bundle;
  const cfg = asObj(parseYaml(configText)) as OcioRoot | null;
  if (!cfg) throw new Error("Failed to parse config.ocio");

  // Map of relative path / basename → text content for FileTransforms.
  // Multiple keys per file so `FileTransform { src: foo.cube }` resolves
  // whether the config references it by basename, search-path-relative,
  // or full relative path.
  const cubeFiles = new Map<string, string>();
  for (const f of files) {
    cubeFiles.set(f.relPath, f.text);
    const base = f.relPath.split("/").pop();
    if (base) cubeFiles.set(base, f.text);
    // Strip the leading directory so `<search_path>/<src>` and `<src>`
    // both resolve when the config uses `search_path: luts`.
    const tail = f.relPath.split("/").slice(1).join("/");
    if (tail) cubeFiles.set(tail, f.text);
  }

  const colorspaces = asArray(cfg.colorspaces ?? null) ?? [];
  let imported = 0;
  const warnings: string[] = [];
  const warn = (m: string): void => {
    if (!warnings.includes(m)) warnings.push(m);
  };

  // Build a name → colorspace-node lookup so we can resolve
  // `ColorSpaceTransform` and `LookTransform.process_space` references.
  const csByName = new Map<string, { [k: string]: YamlValue | undefined }>();
  for (const csNode of colorspaces) {
    const cs = asObj(csNode);
    if (!cs) continue;
    const name = String(cs.name ?? "");
    if (name) csByName.set(name, cs);
  }

  // ── ColorSpaceTransform / LookTransform resolution ────────────────────
  //
  // OCIO's `to_reference` describes "X → reference" and `from_reference`
  // describes "reference → X". A `ColorSpaceTransform { src, dst }`
  // composes to-ref(src) ∘ from-ref(dst). We patch the dispatcher with a
  // closure that knows the colorspace map so nested ColorSpaceTransforms
  // inside other transforms also resolve.

  const lookByName = new Map<string, { [k: string]: YamlValue | undefined }>();
  for (const lookNode of asArray(cfg.looks ?? null) ?? []) {
    const look = asObj(lookNode);
    if (!look) continue;
    const name = String(look.name ?? "");
    if (name) lookByName.set(name, look);
  }

  function colorspaceToReference(name: string): Transform {
    const cs = csByName.get(name);
    if (!cs) {
      warn(`OCIO: unknown colorspace "${name}"`);
      return IDENTITY;
    }
    if (cs.to_reference) return buildExt(cs.to_reference);
    if (cs.from_reference) return buildExt(cs.from_reference, true);
    return IDENTITY;
  }
  function colorspaceFromReference(name: string): Transform {
    const cs = csByName.get(name);
    if (!cs) {
      warn(`OCIO: unknown colorspace "${name}"`);
      return IDENTITY;
    }
    if (cs.from_reference) return buildExt(cs.from_reference);
    if (cs.to_reference) return buildExt(cs.to_reference, true);
    return IDENTITY;
  }

  /** Wraps `buildTransform` and additionally resolves the cross-referencing
   *  transform tags (`ColorSpaceTransform`, `LookTransform`,
   *  `DisplayViewTransform`) that need the full config map. */
  function buildExt(node: YamlValue, invert = false): Transform {
    const obj = asObj(node);
    if (!obj || !obj.__tag) return buildTransform(node, cubeFiles, warn, invert);
    switch (obj.__tag) {
      case "ColorSpaceTransform": {
        const src = String(obj.src ?? "");
        const dst = String(obj.dst ?? "");
        if (!src || !dst) return IDENTITY;
        const a = invert
          ? colorspaceToReference(dst)
          : colorspaceToReference(src);
        const b = invert
          ? colorspaceFromReference(src)
          : colorspaceFromReference(dst);
        return compose([a, b]);
      }
      case "LookTransform": {
        const lookName = String(obj.look ?? "");
        const look = lookByName.get(lookName);
        if (!look) {
          warn(`OCIO: unknown look "${lookName}"`);
          return IDENTITY;
        }
        const processSpace = String(look.process_space ?? "");
        const dir = String(obj.direction ?? "forward");
        const useInverse = dir === "inverse" || invert;
        const lookXform = useInverse
          ? look.inverse_transform ?? look.transform
          : look.transform;
        if (!lookXform) return IDENTITY;
        // Apply the look in its `process_space`: ref → process → look →
        // process → ref. When src/dst are omitted we treat input as
        // already in the reference space.
        const src = String(obj.src ?? "");
        const dst = String(obj.dst ?? "");
        const toProcess = compose([
          src ? colorspaceToReference(src) : IDENTITY,
          processSpace ? colorspaceFromReference(processSpace) : IDENTITY,
        ]);
        const fromProcess = compose([
          processSpace ? colorspaceToReference(processSpace) : IDENTITY,
          dst ? colorspaceFromReference(dst) : IDENTITY,
        ]);
        return compose([toProcess, buildExt(lookXform, useInverse), fromProcess]);
      }
      case "DisplayViewTransform": {
        const src = String(obj.src ?? "");
        const display = String(obj.display ?? "");
        const view = String(obj.view ?? "");
        const viewCS = cfg ? resolveDisplayView(cfg, display, view) : null;
        if (!viewCS) {
          warn(`OCIO: display "${display}" / view "${view}" not found`);
          return IDENTITY;
        }
        return compose([
          src ? colorspaceToReference(src) : IDENTITY,
          colorspaceFromReference(viewCS),
        ]);
      }
      default:
        return buildTransform(node, cubeFiles, warn, invert);
    }
  }

  // ── Pass 1: register every colorspace as a LUT ──────────────────────────
  for (const csNode of colorspaces) {
    const cs = asObj(csNode);
    if (!cs) continue;
    const name = String(cs.name ?? "");
    if (!name) continue;
    let transform: Transform = IDENTITY;
    if (cs.from_reference) {
      transform = buildExt(cs.from_reference);
    } else if (cs.to_reference) {
      transform = buildExt(cs.to_reference, true);
    } else {
      continue;
    }
    const baked = bakeTransform(transform);
    lutStore.register({
      id: `ocio:cs:${name}`,
      name,
      inputSpace: "linear-srgb",
      outputSpace: "srgb",
      cube: { size: baked.cube.size, table: baked.cube.table, domain: { min: [0, 0, 0], max: [1, 1, 1] } },
      shaper: undefined as ShaperLut | undefined,
      source: { kind: "ocio", configPath: configPath, colorspace: name },
    });
    imported++;
  }

  // ── Pass 2: register each look as a LUT (applied in the reference space) ─
  for (const [lookName] of lookByName) {
    const t = buildExt({ __tag: "LookTransform", look: lookName });
    const baked = bakeTransform(t);
    lutStore.register({
      id: `ocio:look:${lookName}`,
      name: `Look · ${lookName}`,
      inputSpace: "linear-srgb",
      outputSpace: "linear-srgb",
      cube: { size: baked.cube.size, table: baked.cube.table, domain: { min: [0, 0, 0], max: [1, 1, 1] } },
      shaper: undefined as ShaperLut | undefined,
      source: { kind: "ocio", configPath: configPath, colorspace: `look:${lookName}` },
    });
    imported++;
  }

  // ── Pass 3: register each (display, view) pair as a LUT ─────────────────
  const displays = asObj(cfg.displays ?? null);
  if (displays) {
    for (const [displayName, viewsNode] of Object.entries(displays)) {
      const views = asArray(viewsNode ?? null);
      if (!views) continue;
      for (const v of views) {
        const view = asObj(v);
        if (!view) continue;
        const vName = String(view.name ?? "");
        const vCS = String(view.colorspace ?? view.view_transform ?? "");
        if (!vName || !vCS) continue;
        const t = buildExt({
          __tag: "DisplayViewTransform",
          display: displayName,
          view: vName,
        });
        const baked = bakeTransform(t);
        lutStore.register({
          id: `ocio:view:${displayName}:${vName}`,
          name: `${displayName} · ${vName}`,
          inputSpace: "linear-srgb",
          outputSpace: "srgb",
          cube: { size: baked.cube.size, table: baked.cube.table, domain: { min: [0, 0, 0], max: [1, 1, 1] } },
          shaper: undefined as ShaperLut | undefined,
          source: { kind: "ocio", configPath: configPath, colorspace: `${displayName}/${vName}` },
        });
        imported++;
      }
    }
  }

  if (warnings.length > 0) {
    console.warn("[OCIO]", warnings.join("\n"));
  }
  return imported;
}

/** Walk the parsed config tree to find the colorspace name a `display:view`
 *  resolves to. OCIO 1 stores `displays.<display>: [- !<View> {name, colorspace}]`. */
function resolveDisplayView(
  cfg: OcioRoot,
  display: string,
  view: string,
): string | null {
  const displays = asObj((cfg as { displays?: YamlValue }).displays ?? null);
  if (!displays) return null;
  const views = asArray(displays[display] ?? null);
  if (!views) return null;
  for (const v of views) {
    const obj = asObj(v);
    if (!obj) continue;
    if (String(obj.name ?? "") === view) {
      return String(obj.colorspace ?? obj.view_transform ?? "");
    }
  }
  return null;
}
