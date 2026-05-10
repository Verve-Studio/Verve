// ─── LUT data model ──────────────────────────────────────────────────────────
//
// A LUT entry in Verve is a colour-space transform packaged as a 1D shaper
// (optional) + 3D LUT (the body of the transform). At runtime each LUT is
// uploaded once to a GPU texture; effects + the display-path blit sample it
// during rendering.
//
// Authored LUTs (`.cube` files, OCIO transforms) and analytically-baked ones
// (HLG→sRGB, Filmic→sRGB, AgX→sRGB) all flatten into the same shape so
// downstream code never branches on origin.

/** Working colour space a LUT expects on its input — and the space its
 *  output lives in. Used at the *runtime entry point* to know whether to
 *  gamma-decode/encode around the LUT sample. */
export type LutColorSpace =
  | "srgb" // sRGB-encoded display values, [0,1]
  | "linear-srgb" // linear-light, sRGB primaries, [0, ∞)
  | "linear-rec709" // alias of linear-srgb (same primaries)
  | "linear-rec2020" // linear-light, Rec.2020 primaries
  | "log" // generic log-encoded (for shaper-LUT input)
  | "aces-cct" // ACEScct log
  | "aces-cg" // ACEScg linear
  | "slog3" // Sony S-Log3 (typically with S-Gamut3.Cine primaries)
  | "logc3" // ARRI LogC3 (EI 800, with ARRI Wide Gamut)
  | "logc4" // ARRI LogC4 (with ARRI Wide Gamut 4)
  | "vlog" // Panasonic V-Log (with V-Gamut)
  | "red-log3g10" // RED Log3G10 (with REDWideGamutRGB)
  | "clog3" // Canon C-Log3 (with Cinema Gamut)
  | "apple-log"; // Apple Log (with Rec.2020 primaries)

/** An optional 1D shaper that pre-conditions input before the 3D lookup.
 *  Used to bring HDR / log-encoded data into the [0,1] range that the 3D
 *  cube can address. `domain` is the input range in scene values. The 1D
 *  table is `size` evenly-spaced entries × {r,g,b}. */
export interface ShaperLut {
  size: number; // entries per channel (typ. 1024)
  table: Float32Array; // length = size*3, RGB-interleaved
  domain: readonly [number, number]; // input min, max (e.g. [0, 65504])
}

/** A 3D RGB LUT. `size` is per-axis (e.g. 33 → 35,937 entries). The table
 *  is stored XYZ-major: index = ((b * size + g) * size + r) * 3. Output is
 *  always RGB; alpha pass-through is handled by the sampler. */
export interface CubeLut {
  size: number; // per-axis (typ. 33 or 65)
  table: Float32Array; // length = size*size*size*3
  domain: {
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  };
}

/** Coarse role tag used by the picker UIs to group LUTs into sections. */
export type LutCategory =
  | "view-transform" // display-side colour transform (HLG/Filmic/AgX → sRGB)
  | "camera-idt" // input device transform (camera log → linear working space)
  | "creative" // user-loaded `.cube` look LUT
  | "ocio"; // OCIO config-imported colour space / look / display·view

/** A complete LUT transform: optional shaper + required 3D cube. */
export interface LutTransform {
  /** Stable id used by stored references (effects, display store). */
  id: string;
  /** User-facing name (filename stem, OCIO colorspace name, etc.). */
  name: string;
  /** Colour space the LUT *expects* its input in — the runtime converts
   *  pixels to this space before sampling. */
  inputSpace: LutColorSpace;
  /** Colour space the LUT *produces*. */
  outputSpace: LutColorSpace;
  /** UI grouping hint. Defaults applied at registration time:
   *   - builtin keys starting with `view-` → `view-transform`
   *   - builtin keys starting with `idt-`  → `camera-idt`
   *   - `cube-file` source                  → `creative`
   *   - `ocio` source                       → `ocio` */
  category?: LutCategory;
  /** Optional 1D shaper applied before the 3D cube lookup. */
  shaper?: ShaperLut;
  /** The 3D cube. */
  cube: CubeLut;
  /** Provenance — used for the manager UI and OCIO round-trips. */
  source:
    | { kind: "cube-file"; path: string }
    | { kind: "ocio"; configPath: string; colorspace: string }
    | { kind: "builtin"; key: string };
}

/** Snapshot for persistence (everything but the Float32Array tables, which
 *  are restored from the original source on next load — except for builtins
 *  which can be regenerated, and OCIO which reads the original config). */
export interface LutPersisted {
  id: string;
  name: string;
  inputSpace: LutColorSpace;
  outputSpace: LutColorSpace;
  source: LutTransform["source"];
}
