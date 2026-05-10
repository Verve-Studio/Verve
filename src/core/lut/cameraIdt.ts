// ─── Camera Input Device Transforms (IDT) ────────────────────────────────────
//
// Each function below decodes a vendor's log-encoded signal in [0,1] back to
// scene-relative linear values, and ships the matching wide-gamut → linear
// sRGB primary matrix so the full transform is `log → linear-camera-gamut →
// linear-sRGB`.
//
// These are reference approximations for soft-proofing and quick previews —
// they're *not* a substitute for the official ACES IDTs published by each
// vendor. Production grading should use OCIO with the vendor-issued LUTs;
// Verve's OCIO importer handles those at full fidelity. The built-ins here
// give a calibrated starting point when an OCIO config isn't available.

// ─── Sony S-Log3 / S-Gamut3.Cine ─────────────────────────────────────────────

/** Sony S-Log3 inverse OETF — log [0,1] → relative linear (0.18 = mid grey).
 *  Reference: Sony S-Log3 Reference Manual (2016). */
export function slog3InvOetf(x: number): number {
  if (x >= 171.2102946929 / 1023) {
    return Math.pow(10, (x * 1023 - 420) / 261.5) * 0.19 - 0.01;
  }
  return ((x * 1023 - 95) * 0.01125) / (171.2102946929 - 95);
}

/** S-Gamut3.Cine → linear sRGB (Rec.709) primary matrix. */
export const SGAMUT3CINE_TO_REC709: readonly (readonly number[])[] = [
  [1.6269, -0.3922, -0.2347],
  [-0.1078, 1.4533, -0.3455],
  [-0.005, -0.0816, 1.0866],
];

// ─── ARRI LogC3 / Wide Gamut ─────────────────────────────────────────────────

/** ARRI LogC3 (EI 800) inverse OETF. Reference: ARRI ALEXA LogC Curve white
 *  paper. The five published constants are EI-specific; these are EI 800. */
export function logc3InvOetf(x: number): number {
  const cut = 0.149658;
  const a = 5.555556,
    b = 0.052272,
    c = 0.247190,
    d = 0.385537,
    e = 5.367655,
    f = 0.092809;
  if (x > cut) return (Math.pow(10, (x - d) / c) - b) / a;
  return (x - f) / e;
}

/** ARRI Wide Gamut → linear sRGB. */
export const ARRI_WG_TO_REC709: readonly (readonly number[])[] = [
  [1.485583, -0.421233, -0.06435],
  [-0.07818, 1.09705, -0.01887],
  [-0.005847, -0.061937, 1.067784],
];

// ─── Panasonic V-Log / V-Gamut ───────────────────────────────────────────────

/** Panasonic V-Log inverse OETF. Reference: V-Log/V-Gamut Reference Manual. */
export function vlogInvOetf(x: number): number {
  const cut = 0.181;
  const b = 0.00873,
    c = 0.241514,
    d = 0.598206;
  if (x < cut) return (x - 0.125) / 5.6;
  return Math.pow(10, (x - d) / c) - b;
}

/** V-Gamut → linear sRGB. */
export const VGAMUT_TO_REC709: readonly (readonly number[])[] = [
  [1.434521, -0.241046, -0.193476],
  [-0.087526, 1.13978, -0.052253],
  [0.005378, -0.097615, 1.092236],
];

// ─── RED Log3G10 / REDWideGamutRGB ───────────────────────────────────────────

/** RED Log3G10 inverse OETF (Image Processing Pipeline rev 5.7). Negative
 *  inputs use a linear extension to remain monotonic. */
export function log3g10InvOetf(x: number): number {
  if (x < 0) return x / 15.1927 - 0.01;
  return (Math.pow(10, x / 0.224282) - 1) / 155.975327 - 0.01;
}

/** REDWideGamutRGB → linear sRGB. */
export const RWG_TO_REC709: readonly (readonly number[])[] = [
  [1.412486, -0.177306, -0.23518],
  [-0.107939, 1.236996, -0.129057],
  [0.029841, -0.309879, 1.280038],
];

// ─── Canon C-Log3 / Cinema Gamut ─────────────────────────────────────────────

/** Canon C-Log3 inverse OETF. Reference: Canon Log Transfer Characteristics
 *  (white paper, 2015). Three-segment piecewise log/linear. */
export function clog3InvOetf(x: number): number {
  if (x < 0.097465)
    return -(Math.pow(10, (0.069886 - x) / 0.42889912) - 1) / 14.98325;
  if (x <= 0.15277891) return (x - 0.12783901) / 1.9754798;
  return (Math.pow(10, (x - 0.69886) / 0.42889912) - 1) / 14.98325;
}

/** Cinema Gamut → linear sRGB. */
export const CINEMA_GAMUT_TO_REC709: readonly (readonly number[])[] = [
  [1.625586, -0.396999, -0.228587],
  [-0.108546, 1.47029, -0.361743],
  [0.014154, -0.158876, 1.144722],
];

// ─── Apple Log / Rec.2020 ────────────────────────────────────────────────────

/** Apple Log inverse OETF. Reference: Apple Log Profile (2023, "Apple Log
 *  Profile White Paper"). Hybrid quadratic-toe + log-segment, normalised so
 *  signal 0.5 ≈ 18 % linear scene reference. */
export function appleLogInvOetf(x: number): number {
  // Constants from Apple's published spec.
  const R0 = -0.05641088;
  const Rt = 0.01;
  const c = 47.28711236;
  const beta = 0.00964052;
  const gamma = 0.08550479;
  const delta = 0.69336945;
  if (x < beta) {
    return ((x - beta) * (x - beta)) / -c + R0;
  }
  if (x < gamma) {
    return (x - gamma) / delta + Rt;
  }
  return Math.pow(2, (x - delta) / c) - Rt;
}

/** Rec.2020 → linear sRGB (downconvert; out-of-gamut values fall outside
 *  [0,1] and rely on the soft-clip in the LUT consumer). */
export const REC2020_TO_REC709: readonly (readonly number[])[] = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187],
];

// ─── Helpers ────────────────────────────────────────────────────────────────

export function applyMatrix3(
  m: readonly (readonly number[])[],
  rgb: readonly [number, number, number],
): [number, number, number] {
  return [
    m[0][0] * rgb[0] + m[0][1] * rgb[1] + m[0][2] * rgb[2],
    m[1][0] * rgb[0] + m[1][1] * rgb[1] + m[1][2] * rgb[2],
    m[2][0] * rgb[0] + m[2][1] * rgb[1] + m[2][2] * rgb[2],
  ];
}
