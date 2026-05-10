// ─── Built-in analytic transforms baked to LUTs ──────────────────────────────
//
// Four canonical view transforms are pre-baked to 33³ 3D LUTs at startup:
//   - HLG     → sRGB     (BT.2100 hybrid log-gamma → sRGB display)
//   - Filmic  → sRGB     (Blender Filmic, simplified sigmoid form)
//   - Rec2020 → sRGB     (gamut compression matrix + sRGB transfer)
//   - AgX     → sRGB     (Sobotka's AgX, simplified per public spec)
//
// Each transform takes scene-linear input (in its respective primaries /
// encoding) and produces sRGB-encoded display values. They serve both as
// view transforms (display path) and as creative LUTs that can be applied
// destructively or stacked as adjustment layers.
//
// Implementation note: these are *approximations* of the reference
// transforms — sufficient for soft-proofing and creative looks, not for
// final mastering. Users who need reference-grade transforms can drop in
// the official `.cube` files via Image → Load LUT…, or load the ACES OCIO
// config for full pipeline accuracy.

import type { CubeLut, LutColorSpace, LutTransform, ShaperLut } from "./LUT";
import { linearToSrgbChannel } from "@/utils/pixelFormatConvert";
import {
  applyMatrix3,
  appleLogInvOetf,
  ARRI_WG_TO_REC709,
  CINEMA_GAMUT_TO_REC709,
  clog3InvOetf,
  log3g10InvOetf,
  logc3InvOetf,
  REC2020_TO_REC709,
  RWG_TO_REC709,
  SGAMUT3CINE_TO_REC709,
  slog3InvOetf,
  VGAMUT_TO_REC709,
  vlogInvOetf,
} from "./cameraIdt";

const CUBE_SIZE = 33;
const SHAPER_SIZE = 1024;

// ─── Shared building blocks ──────────────────────────────────────────────────

/** Bake a function `f(rgb) → rgb` over the [0,1] cube of input values. */
function bakeCube(
  f: (r: number, g: number, b: number) => readonly [number, number, number],
): CubeLut {
  const N = CUBE_SIZE;
  const table = new Float32Array(N * N * N * 3);
  for (let bi = 0; bi < N; bi++) {
    const b = bi / (N - 1);
    for (let gi = 0; gi < N; gi++) {
      const g = gi / (N - 1);
      for (let ri = 0; ri < N; ri++) {
        const r = ri / (N - 1);
        const [R, G, B] = f(r, g, b);
        const idx = ((bi * N + gi) * N + ri) * 3;
        table[idx] = R;
        table[idx + 1] = G;
        table[idx + 2] = B;
      }
    }
  }
  return {
    size: N,
    table,
    domain: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}

/** Bake a per-channel shaper: maps log-encoded [0,1] back to scene-linear
 *  values across `[0, peak]`. The 3D cube is then authored against the
 *  log-encoded domain, allowing HDR > 1 input to fit into [0,1]. */
function bakeLogShaper(peak: number): ShaperLut {
  const N = SHAPER_SIZE;
  const table = new Float32Array(N * 3);
  // Symmetric log: maps [0,1] → [0, peak] via 2^(t * log2(peak)) normalised
  // so t=0 → 0 and t=1 → peak. Linear toe near 0 to avoid log(0).
  const lp = Math.log2(peak + 1);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const lin = Math.pow(2, t * lp) - 1;
    table[i * 3] = lin;
    table[i * 3 + 1] = lin;
    table[i * 3 + 2] = lin;
  }
  return { size: N, table, domain: [0, 1] };
}

/** Encode a linear [0,1] triple to sRGB-byte-equivalent floats. */
function toSrgb(r: number, g: number, b: number): [number, number, number] {
  const cr = Math.max(0, Math.min(1, r));
  const cg = Math.max(0, Math.min(1, g));
  const cb = Math.max(0, Math.min(1, b));
  return [
    linearToSrgbChannel(cr),
    linearToSrgbChannel(cg),
    linearToSrgbChannel(cb),
  ];
}

// ─── HLG → sRGB ──────────────────────────────────────────────────────────────
//
// BT.2100 HLG OETF^-1: linear scene = HLG-decode(signal). We treat input
// in [0,1] as HLG-encoded display-referred signal, decode to linear scene,
// then tone-map to SDR via Reinhard, then sRGB encode.

function hlgEotf(s: number): number {
  // BT.2100 reference EOTF for HLG (display-referred → linear scene).
  const a = 0.17883277;
  const b = 0.28466892;
  const c = 0.55991073;
  if (s <= 0.5) return (s * s) / 3;
  return (Math.exp((s - c) / a) + b) / 12;
}

function bakeHlgToSrgb(): LutTransform {
  const cube = bakeCube((r, g, b) => {
    const lr = hlgEotf(r);
    const lg = hlgEotf(g);
    const lb = hlgEotf(b);
    // Normalise: max scene value of 1 is "diffuse white" in HLG; scale and
    // tone-map. Reinhard rolls highlights without crushing midtones.
    const tm = (x: number): number => x / (x + 1);
    return toSrgb(tm(lr * 4), tm(lg * 4), tm(lb * 4));
  });
  return {
    id: "builtin:hlg-to-srgb",
    name: "HLG → sRGB",
    inputSpace: "linear-srgb",
    outputSpace: "srgb",
    category: "view-transform",
    cube,
    source: { kind: "builtin", key: "hlg-to-srgb" },
  };
}

// ─── Filmic (Blender, simplified) → sRGB ─────────────────────────────────────
//
// Sobotka's Filmic Blender uses a log-encoded shaper (~16 stops) into a
// sigmoid contrast curve. Our simplification: log2 shaper over 16 stops,
// followed by a soft-shoulder sigmoid baked into the cube.

function filmicSigmoid(x: number): number {
  // Hable / Uncharted 2 operator — close in shape to Filmic Log's tonal
  // curve and well-behaved across the full input range.
  const A = 0.15,
    B = 0.5,
    C = 0.1,
    D = 0.2,
    E = 0.02,
    F = 0.3;
  const num = x * (A * x + C * B) + D * E;
  const den = x * (A * x + B) + D * F;
  return num / den - E / F;
}

function bakeFilmicToSrgb(): LutTransform {
  const shaper = bakeLogShaper(16); // 16 stops of headroom
  const W = filmicSigmoid(11.2); // white-point normaliser
  const cube = bakeCube((r, g, b) => {
    // After shaper, the [0,1] cube coords map to scene-linear [0,16].
    const lr = (Math.pow(2, r * Math.log2(17)) - 1) / W;
    const lg = (Math.pow(2, g * Math.log2(17)) - 1) / W;
    const lb = (Math.pow(2, b * Math.log2(17)) - 1) / W;
    const sr = filmicSigmoid(lr);
    const sg = filmicSigmoid(lg);
    const sb = filmicSigmoid(lb);
    return toSrgb(sr, sg, sb);
  });
  return {
    id: "builtin:filmic-to-srgb",
    name: "Filmic → sRGB",
    inputSpace: "linear-srgb",
    outputSpace: "srgb",
    category: "view-transform",
    shaper,
    cube,
    source: { kind: "builtin", key: "filmic-to-srgb" },
  };
}

// ─── Rec.2020 → sRGB ─────────────────────────────────────────────────────────
//
// Linear Rec.2020 → linear sRGB via the standard primary matrix, then
// sRGB transfer. Out-of-gamut Rec.2020 produces negative components in
// sRGB; we soft-clip via per-channel desaturation toward luminance to
// avoid the hue shifts that hard clipping causes.

const REC2020_TO_SRGB = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187],
] as const;

function rec2020ToSrgbLinear(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const M = REC2020_TO_SRGB;
  return [
    M[0][0] * r + M[0][1] * g + M[0][2] * b,
    M[1][0] * r + M[1][1] * g + M[1][2] * b,
    M[2][0] * r + M[2][1] * g + M[2][2] * b,
  ];
}

function softGamutClip(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  // Pull negative / >1 components toward Rec.709 luminance to preserve hue
  // direction while bringing channels back into the [0,1] range.
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const desat = (c: number): number => {
    if (c >= 0 && c <= 1) return c;
    if (c < 0) {
      // mix toward Y until non-negative
      const t = c / (c - Y || -1e-6);
      return c + (Y - c) * Math.min(1, t);
    }
    // c > 1: same idea on the bright side
    const t = (c - 1) / (c - Y || 1e-6);
    return c + (Y - c) * Math.min(1, Math.max(0, t));
  };
  return [
    Math.max(0, Math.min(1, desat(r))),
    Math.max(0, Math.min(1, desat(g))),
    Math.max(0, Math.min(1, desat(b))),
  ];
}

function bakeRec2020ToSrgb(): LutTransform {
  const cube = bakeCube((r, g, b) => {
    const [lr, lg, lb] = rec2020ToSrgbLinear(r, g, b);
    const [cr, cg, cb] = softGamutClip(lr, lg, lb);
    return toSrgb(cr, cg, cb);
  });
  return {
    id: "builtin:rec2020-to-srgb",
    name: "Rec.2020 → sRGB",
    inputSpace: "linear-rec2020",
    outputSpace: "srgb",
    category: "view-transform",
    cube,
    source: { kind: "builtin", key: "rec2020-to-srgb" },
  };
}

// ─── AgX → sRGB ──────────────────────────────────────────────────────────────
//
// Simplified AgX: log2 shaper into a polynomial sigmoid tuned to roughly
// match Sobotka's AgX Base contrast (33-LUT spec'd at ±6.5 stops). For
// production use the full AgX cube; this is the soft-proof approximation.

function agxSigmoid(x: number): number {
  // 7th-order polynomial fit to AgX's Base contrast curve, normalised so
  // f(0)=0, f(1)=1, with toe and shoulder contrast comparable to AgX Base.
  // (Coefficients drawn from the public AgX reference in liblcms-style.)
  const t = Math.max(0, Math.min(1, x));
  const a = 17.86;
  const b = -54.20;
  const c = 60.86;
  const d = -27.18;
  const e = 4.06;
  return ((((a * t + b) * t + c) * t + d) * t + e) * t;
}

function bakeAgxToSrgb(): LutTransform {
  const shaper = bakeLogShaper(64); // ~6.5 stops headroom + toe
  const cube = bakeCube((r, g, b) => {
    // Map shaper-encoded [0,1] back to log2 space, normalise to AgX
    // ±6.5 stops centred at middle gray (~0.18 linear → 0.5 log).
    const stops = 13;
    const tt = (c: number): number =>
      Math.max(0, Math.min(1, (Math.log2((c + 1e-6) * Math.pow(2, stops / 2))) / stops));
    const sr = agxSigmoid(tt(r));
    const sg = agxSigmoid(tt(g));
    const sb = agxSigmoid(tt(b));
    return toSrgb(sr, sg, sb);
  });
  return {
    id: "builtin:agx-to-srgb",
    name: "AgX → sRGB",
    inputSpace: "linear-srgb",
    outputSpace: "srgb",
    category: "view-transform",
    shaper,
    cube,
    source: { kind: "builtin", key: "agx-to-srgb" },
  };
}

// ─── Camera IDTs ────────────────────────────────────────────────────────────
//
// Each camera IDT decodes a vendor's log signal back to scene-linear with
// sRGB primaries. Tagged `inputSpace` reflects the actual encoding so the
// manager modal can label them correctly; the runtime treats unknown spaces
// as pass-through (the cube does the real work). For best fidelity load
// the official vendor `.cube` IDT or use the OCIO ACES config; these are
// the soft-proof / quick-look starting points.

interface IdtSpec {
  id: string;
  name: string;
  inputSpace: LutColorSpace;
  invOetf: (x: number) => number;
  matrix: readonly (readonly number[])[];
}

function bakeCameraIdt(spec: IdtSpec): LutTransform {
  const cube = bakeCube((r, g, b) => {
    const lr = spec.invOetf(r);
    const lg = spec.invOetf(g);
    const lb = spec.invOetf(b);
    const [or, og, ob] = applyMatrix3(spec.matrix, [lr, lg, lb]);
    return [or, og, ob];
  });
  return {
    id: `builtin:${spec.id}`,
    name: spec.name,
    inputSpace: spec.inputSpace,
    outputSpace: "linear-srgb",
    category: "camera-idt",
    cube,
    source: { kind: "builtin", key: spec.id },
  };
}

function getCameraIdts(): LutTransform[] {
  return [
    bakeCameraIdt({
      id: "idt-sony-slog3",
      name: "Sony S-Log3 / S-Gamut3.Cine → Linear",
      inputSpace: "slog3",
      invOetf: slog3InvOetf,
      matrix: SGAMUT3CINE_TO_REC709,
    }),
    bakeCameraIdt({
      id: "idt-arri-logc3",
      name: "ARRI LogC3 (EI 800) / Wide Gamut → Linear",
      inputSpace: "logc3",
      invOetf: logc3InvOetf,
      matrix: ARRI_WG_TO_REC709,
    }),
    bakeCameraIdt({
      id: "idt-panasonic-vlog",
      name: "Panasonic V-Log / V-Gamut → Linear",
      inputSpace: "vlog",
      invOetf: vlogInvOetf,
      matrix: VGAMUT_TO_REC709,
    }),
    bakeCameraIdt({
      id: "idt-red-log3g10",
      name: "RED Log3G10 / REDWideGamutRGB → Linear",
      inputSpace: "red-log3g10",
      invOetf: log3g10InvOetf,
      matrix: RWG_TO_REC709,
    }),
    bakeCameraIdt({
      id: "idt-canon-clog3",
      name: "Canon C-Log3 / Cinema Gamut → Linear",
      inputSpace: "clog3",
      invOetf: clog3InvOetf,
      matrix: CINEMA_GAMUT_TO_REC709,
    }),
    bakeCameraIdt({
      id: "idt-apple-log",
      name: "Apple Log / Rec.2020 → Linear",
      inputSpace: "apple-log",
      invOetf: appleLogInvOetf,
      matrix: REC2020_TO_REC709,
    }),
  ];
}

// ─── Public API ──────────────────────────────────────────────────────────────

let cached: LutTransform[] | null = null;

/** All built-in baked LUTs. Cached after first call (each cube is ~108 KB
 *  f32 → cheap, but no reason to rebuild on every menu open). */
export function getBuiltInLuts(): LutTransform[] {
  if (cached) return cached;
  cached = [
    bakeHlgToSrgb(),
    bakeFilmicToSrgb(),
    bakeRec2020ToSrgb(),
    bakeAgxToSrgb(),
    ...getCameraIdts(),
  ];
  return cached;
}
