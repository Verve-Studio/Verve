// ─── lcms2 wrapper ───────────────────────────────────────────────────────────
//
// Async TypeScript surface over the lcms2 bindings compiled into the
// pixelops WASM module. Three public entry points, mirroring the C++ side:
//
//   * `convertPixels`            — one-shot or per-document conversion of
//                                  a pixel buffer from a source ICC profile
//                                  to the document's working space.
//   * `getWorkingSpaceProfile`   — fetch the canonical sRGB / linear-sRGB
//                                  profile bytes for tagging a document
//                                  after early-binding import conversion.
//   * `buildDisplayLut`          — Tier-2b: sample a 3D LUT mapping the
//                                  working space to a destination display
//                                  profile, for upload to the GPU.
//
// When the WASM module hasn't been rebuilt with lcms2 vendored, every entry
// point returns `null` and the caller falls back to the tier-1 passthrough
// behaviour. `isCmsAvailable()` lets callers decide proactively.
//
// Working-space convention (locked in tier-2 decision #1):
//   * `'rgba8'`   layer → sRGB (IEC 61966-2.1) — gamma-encoded
//   * `'rgba32f'` layer → linear-sRGB primaries — scene-linear floats

import { getPixelOps } from "@/wasm";

export type RenderingIntent =
  | "perceptual"
  | "relative-colorimetric"
  | "saturation"
  | "absolute-colorimetric";

const INTENT_CODES: Record<RenderingIntent, number> = {
  perceptual: 0,
  "relative-colorimetric": 1,
  saturation: 2,
  "absolute-colorimetric": 3,
};

export type PixelLayout = "rgba8" | "rgba32f";

const LAYOUT_CODES: Record<PixelLayout, number> = {
  rgba8: 0,
  rgba32f: 1,
};

// ─── Capability check ────────────────────────────────────────────────────────

/** True once the lcms2 bindings are linked into the WASM build. Cheap to
 *  call (the module load itself is cached by `getPixelOps`). */
export async function isCmsAvailable(): Promise<boolean> {
  const m = await getPixelOps();
  return typeof m._cms_create_transform === "function";
}

// ─── Working-space profile ───────────────────────────────────────────────────

const workingProfileCache = new Map<PixelLayout, Uint8Array>();

/** Return the canonical working-space profile bytes for the given layout.
 *  Cached after first call (the lcms2 generators are pure functions of
 *  layout, so the bytes never change). Returns `null` when lcms2 isn't
 *  linked into the WASM build. */
export async function getWorkingSpaceProfile(
  layout: PixelLayout,
): Promise<Uint8Array | null> {
  const cached = workingProfileCache.get(layout);
  if (cached) return cached;
  const m = await getPixelOps();
  if (typeof m._cms_get_working_profile !== "function") return null;

  const sizePtr = m._malloc(4);
  try {
    const bytesPtr = m._cms_get_working_profile(LAYOUT_CODES[layout], sizePtr);
    if (!bytesPtr) return null;
    try {
      const size = new DataView(
        m.HEAPU8.buffer,
        sizePtr,
        4,
      ).getUint32(0, true);
      const out = m.HEAPU8.slice(bytesPtr, bytesPtr + size);
      workingProfileCache.set(layout, out);
      return out;
    } finally {
      m._cms_free_buffer?.(bytesPtr);
    }
  } finally {
    m._free(sizePtr);
  }
}

// ─── Pixel conversion ────────────────────────────────────────────────────────

/** Convert a pixel buffer from `srcProfile` to the working-space profile
 *  for `layout`. Returns a new buffer of the same length/format. If lcms2
 *  isn't linked into the WASM build, returns `null` so the caller can
 *  passthrough.
 *
 *  Intent defaults follow tier-2 decision #2:
 *    * `'perceptual'` for wide-gamut camera / scanner imports (the default
 *      here, matching Photoshop's import path)
 *    * Use `'relative-colorimetric'` explicitly for the Convert to Profile
 *      dialog wiring later in Tier 2c.
 */
export async function convertToWorkingSpace(
  pixels: Uint8Array | Float32Array,
  srcProfile: Uint8Array,
  layout: PixelLayout,
  intent: RenderingIntent = "perceptual",
  useBpc: boolean = true,
): Promise<Uint8Array | Float32Array | null> {
  const dst = await getWorkingSpaceProfile(layout);
  if (!dst) return null;
  return convertPixels(pixels, srcProfile, dst, layout, intent, useBpc);
}

/** Lower-level: convert pixels between two explicit profiles. Used by
 *  Tier-2c's Convert to Profile dialog. */
export async function convertPixels(
  pixels: Uint8Array | Float32Array,
  srcProfile: Uint8Array,
  dstProfile: Uint8Array,
  layout: PixelLayout,
  intent: RenderingIntent = "relative-colorimetric",
  useBpc: boolean = true,
): Promise<Uint8Array | Float32Array | null> {
  const m = await getPixelOps();
  if (
    typeof m._cms_create_transform !== "function" ||
    typeof m._cms_transform_apply !== "function" ||
    typeof m._cms_destroy_transform !== "function"
  ) {
    return null;
  }

  const bytesPerPixel = layout === "rgba32f" ? 16 : 4;
  const pixelCount =
    pixels instanceof Float32Array ? pixels.length / 4 : pixels.length / 4;
  const pixelBytes = pixelCount * bytesPerPixel;

  // Allocate src/dst profile buffers + input/output pixel buffers, then
  // create the transform, run it, free everything.
  const srcPtr = m._malloc(srcProfile.byteLength);
  const dstPtr = m._malloc(dstProfile.byteLength);
  const inPtr = m._malloc(pixelBytes);
  const outPtr = m._malloc(pixelBytes);
  let handle = 0;
  try {
    m.HEAPU8.set(srcProfile, srcPtr);
    m.HEAPU8.set(dstProfile, dstPtr);
    handle = m._cms_create_transform(
      srcPtr,
      srcProfile.byteLength,
      dstPtr,
      dstProfile.byteLength,
      LAYOUT_CODES[layout],
      INTENT_CODES[intent],
      useBpc ? 1 : 0,
    );
    if (!handle) return null;

    // Stage pixels into WASM.
    if (pixels instanceof Float32Array) {
      m.HEAPU8.set(
        new Uint8Array(pixels.buffer, pixels.byteOffset, pixelBytes),
        inPtr,
      );
    } else {
      m.HEAPU8.set(pixels, inPtr);
    }
    m._cms_transform_apply(handle, inPtr, outPtr, pixelCount);

    // Read back into a fresh JS-owned buffer.
    if (layout === "rgba32f") {
      const view = new Float32Array(pixelCount * 4);
      view.set(
        new Float32Array(
          m.HEAPU8.buffer,
          outPtr,
          pixelCount * 4,
        ),
      );
      return view;
    } else {
      return m.HEAPU8.slice(outPtr, outPtr + pixelBytes);
    }
  } finally {
    if (handle) m._cms_destroy_transform(handle);
    m._free(outPtr);
    m._free(inPtr);
    m._free(dstPtr);
    m._free(srcPtr);
  }
}

// ─── 3D LUT (Tier 2b) ────────────────────────────────────────────────────────

export interface ProofLutOptions {
  /** Output device being simulated. */
  proofProfile: Uint8Array;
  /** Active display profile. `null` falls back to the bundled sRGB. */
  displayProfile: Uint8Array | null;
  /** Intent for the working→proof transform. Photoshop's default for
   *  soft proofing is Relative Colorimetric. */
  intent?: RenderingIntent;
  /** Black-point compensation on both legs of the transform. */
  useBpc?: boolean;
  /** When true, the proof's white-point and black-point show through
   *  (Photoshop's "Simulate Paper Color"). */
  simulatePaperColor?: boolean;
  /** When true, pixels outside the proof gamut come out as `alarmColor`. */
  gamutCheck?: boolean;
  /** RGBA alarm colour for the gamut warning, 0-255 bytes. Alpha unused. */
  alarmColor?: { r: number; g: number; b: number };
  /** LUT axis size. 33 = Photoshop default. */
  size?: number;
}

/** Build a composed soft-proofing LUT: working space → proof profile →
 *  display profile, in one transform chain. Optionally bakes a gamut
 *  warning where out-of-proof-gamut working-space pixels come out as a
 *  configurable alarm colour.
 *
 *  Returns `null` when lcms2 isn't linked or the WASM build is missing
 *  the proof binding. */
export async function buildProofLut(
  layout: PixelLayout,
  opts: ProofLutOptions,
): Promise<Float32Array | null> {
  const m = await getPixelOps();
  if (typeof m._cms_build_proof_lut !== "function") return null;
  const size = opts.size ?? 33;
  const proofBytes = opts.proofProfile;
  const dispBytes = opts.displayProfile;
  const intentCode = INTENT_CODES[opts.intent ?? "relative-colorimetric"];
  const useBpc = opts.useBpc ?? true;
  const simulatePaper = !!opts.simulatePaperColor;
  const gamutCheck = !!opts.gamutCheck;
  const alarm = opts.alarmColor ?? { r: 128, g: 128, b: 128 };

  const proofPtr = m._malloc(proofBytes.byteLength);
  const dispPtr = dispBytes ? m._malloc(dispBytes.byteLength) : 0;
  const outBytes = size * size * size * 4 * 4;
  const outPtr = m._malloc(outBytes);
  try {
    m.HEAPU8.set(proofBytes, proofPtr);
    if (dispBytes && dispPtr) m.HEAPU8.set(dispBytes, dispPtr);
    const rc = m._cms_build_proof_lut(
      proofPtr,
      proofBytes.byteLength,
      dispPtr,
      dispBytes ? dispBytes.byteLength : 0,
      LAYOUT_CODES[layout],
      intentCode,
      useBpc ? 1 : 0,
      simulatePaper ? 1 : 0,
      gamutCheck ? 1 : 0,
      alarm.r & 0xff,
      alarm.g & 0xff,
      alarm.b & 0xff,
      size,
      outPtr,
    );
    if (rc !== 0) return null;
    const out = new Float32Array(size * size * size * 4);
    out.set(
      new Float32Array(m.HEAPU8.buffer, outPtr, size * size * size * 4),
    );
    return out;
  } finally {
    m._free(outPtr);
    if (dispPtr) m._free(dispPtr);
    m._free(proofPtr);
  }
}

/** Build a `size × size × size` RGBA float LUT mapping the working space
 *  for `layout` to `dstProfile`. Suitable for upload to a WebGPU 3D
 *  texture and sampling in the display-correction shader.
 *
 *  Returns `null` when lcms2 isn't linked. `size` should typically be 33
 *  (Photoshop's default) — large enough for smooth gradients, small enough
 *  to upload quickly. */
export async function buildDisplayLut(
  dstProfile: Uint8Array,
  layout: PixelLayout,
  size: number = 33,
  intent: RenderingIntent = "perceptual",
  useBpc: boolean = true,
): Promise<Float32Array | null> {
  const m = await getPixelOps();
  if (typeof m._cms_build_3d_lut !== "function") return null;
  const dstPtr = m._malloc(dstProfile.byteLength);
  const outBytes = size * size * size * 4 * 4; // size^3 RGBA × 4 bytes/float
  const outPtr = m._malloc(outBytes);
  try {
    m.HEAPU8.set(dstProfile, dstPtr);
    const rc = m._cms_build_3d_lut(
      dstPtr,
      dstProfile.byteLength,
      LAYOUT_CODES[layout],
      INTENT_CODES[intent],
      useBpc ? 1 : 0,
      size,
      outPtr,
    );
    if (rc !== 0) return null;
    // Copy out as a fresh Float32Array (WASM heap may be reused).
    const out = new Float32Array(size * size * size * 4);
    out.set(
      new Float32Array(m.HEAPU8.buffer, outPtr, size * size * size * 4),
    );
    return out;
  } finally {
    m._free(outPtr);
    m._free(dstPtr);
  }
}
