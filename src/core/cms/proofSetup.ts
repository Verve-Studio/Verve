// ─── Soft-proofing LUT builder ───────────────────────────────────────────────
//
// Tier 3a/3b: build a single composed LUT that simulates printing or another
// output device on screen. The composed transform is:
//
//   working space → proof profile → display profile
//
// optionally with a "gamut check" overlay that paints out-of-proof-gamut
// working-space pixels with an alarm colour (Tier 3b's gamut warning).
// All the heavy lifting lives in `buildProofLut` (lcms2 wrapper); this
// module's job is to assemble inputs from displayStore + parse the proof
// profile's description, and wrap the result as a `LutTransform` so the
// hdr-blit shader's existing LUT slot can consume it.
//
// When a view-transform LUT is active alongside soft-proofing, the view
// transform still wins (it bakes its own display encoding). Composing
// the three transforms would need another lcms2 binding; not in scope
// for this push.

import { buildProofLut } from "@/core/cms/lcms2";
import type { PixelLayout, RenderingIntent } from "@/core/cms/lcms2";
import { parseProfileDescription } from "@/core/cms/iccProfile";
import type { LutTransform } from "@/core/lut/LUT";

/** Shared id for the active proof-mode LUT. Re-registering under the same
 *  key invalidates the GPU cache via reference-comparison in
 *  `ensureLutOnGpu` (each rebuild produces a fresh object). */
export const PROOF_LUT_ID = "proof-lut";

const PROOF_LUT_SIZE = 33;

function rgbaToRgb(rgba: Float32Array, size: number): Float32Array {
  const count = size * size * size;
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3 + 0] = rgba[i * 4 + 0];
    out[i * 3 + 1] = rgba[i * 4 + 1];
    out[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return out;
}

export interface ProofSetupParams {
  proofProfile: Uint8Array;
  /** Active display profile, or null for the built-in sRGB fallback. */
  displayProfile: Uint8Array | null;
  /** Rendering intent for the working→proof leg. */
  intent: RenderingIntent;
  useBpc: boolean;
  /** Photoshop's "Simulate Paper Color": preserves the proof's white-point
   *  and black-point on screen by switching the display-leg intent to
   *  Absolute Colorimetric. */
  simulatePaperColor: boolean;
  /** Bake a gamut-warning overlay into the LUT. Pixels outside the proof's
   *  gamut come out as `alarmColor`. */
  gamutCheck: boolean;
  alarmColor: { r: number; g: number; b: number };
}

/** Build the composed proof LUT and wrap it as a `LutTransform`. Returns
 *  `null` when lcms2 isn't linked. */
export async function buildProofLutTransform(
  layout: PixelLayout,
  params: ProofSetupParams,
): Promise<LutTransform | null> {
  const rgba = await buildProofLut(layout, {
    proofProfile: params.proofProfile,
    displayProfile: params.displayProfile,
    intent: params.intent,
    useBpc: params.useBpc,
    simulatePaperColor: params.simulatePaperColor,
    gamutCheck: params.gamutCheck,
    alarmColor: params.alarmColor,
    size: PROOF_LUT_SIZE,
  });
  if (!rgba) return null;

  const proofName =
    parseProfileDescription(params.proofProfile) ?? "Proof Profile";

  return {
    id: PROOF_LUT_ID,
    name: params.gamutCheck
      ? `Proof: ${proofName} (gamut warning)`
      : `Proof: ${proofName}`,
    // The shader feeds linear-sRGB into the LUT (after gamma-decoding rgba8
    // inputs), and the LUT body carries the working→proof→display chain
    // through to display-encoded output. We tag the output as "srgb"
    // because that's the swapchain's expected encoding downstream.
    inputSpace: "linear-srgb",
    outputSpace: "srgb",
    cube: {
      size: PROOF_LUT_SIZE,
      table: rgbaToRgb(rgba, PROOF_LUT_SIZE),
      domain: { min: [0, 0, 0], max: [1, 1, 1] },
    },
    source: { kind: "builtin", key: PROOF_LUT_ID },
  };
}
