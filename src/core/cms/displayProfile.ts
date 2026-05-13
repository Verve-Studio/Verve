// ─── Display profile LUT ─────────────────────────────────────────────────────
//
// Tier 2b: a user-assigned ICC profile representing the active display becomes
// a 3D LUT (working-space → display-encoded). The blit shader already knows
// how to sample a 3D LUT during the final composite — we wrap lcms2's output
// as a `LutTransform`, stash it on `displayStore.displayProfileLut`, and the
// renderer feeds it into the same hdr-blit binding it uses for OCIO view
// transforms.
//
// The display LUT lives on `displayStore` rather than `lutStore` because
// it's display-machinery, not a user-pickable look — the LUT manager UI
// should never list it. When both a view-transform LUT and a display
// profile are active, the view transform wins (it already bakes display
// encoding); composing the two is Tier 3 work (soft-proofing pipeline).

import { buildDisplayLut } from "@/core/cms/lcms2";
import type { PixelLayout } from "@/core/cms/lcms2";
import { parseProfileDescription } from "@/core/cms/iccProfile";
import type { LutTransform } from "@/core/lut/LUT";

export const DISPLAY_PROFILE_LUT_ID = "display-profile";

/** Default cube size for the display LUT. 33 is Photoshop's default and a
 *  good accuracy / upload-size trade-off. */
const DISPLAY_LUT_SIZE = 33;

/** Strip the alpha channel from the RGBA LUT lcms2 produces — `CubeLut.table`
 *  is RGB-interleaved. The indexing convention matches between the two:
 *  index (r, g, b) lives at offset `(r + g*N + b*N*N) * channels`. */
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

/** Build a `LutTransform` from raw ICC profile bytes. Returns `null` when
 *  lcms2 isn't linked into the WASM build — caller falls back to no display
 *  LUT. The returned transform is NOT registered in `lutStore`; the caller
 *  passes it to `displayStore.setDisplayProfileLut`. */
export async function buildDisplayProfileLut(
  profileBytes: Uint8Array,
  layout: PixelLayout,
): Promise<LutTransform | null> {
  const rgba = await buildDisplayLut(
    profileBytes,
    layout,
    DISPLAY_LUT_SIZE,
    "perceptual",
    true,
  );
  if (!rgba) return null;

  const name =
    parseProfileDescription(profileBytes) ?? "Custom Display Profile";

  // Working-space input is linear-sRGB for both rgba8 (after the shader's
  // sRGB decode) and rgba32f. Output is display-encoded byte values the
  // swapchain expects; we tag as "srgb" output because that's the encoding
  // the existing blit pipeline assumes downstream (the LUT body itself
  // carries any primary-space remapping).
  return {
    id: DISPLAY_PROFILE_LUT_ID,
    name,
    inputSpace: "linear-srgb",
    outputSpace: "srgb",
    cube: {
      size: DISPLAY_LUT_SIZE,
      table: rgbaToRgb(rgba, DISPLAY_LUT_SIZE),
      domain: { min: [0, 0, 0], max: [1, 1, 1] },
    },
    source: { kind: "builtin", key: DISPLAY_PROFILE_LUT_ID },
  };
}
