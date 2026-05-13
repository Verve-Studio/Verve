// ─── lcms2 bindings for the pixelops WASM module ─────────────────────────────
//
// Thin extern-"C" wrapper exposing the Little-CMS 2 functions Verve needs
// across the WASM↔JS boundary. The bindings are kept deliberately small —
// they cover three workflows:
//
//   1. Import-time conversion: src profile → working-space profile
//      (create_transform / transform_apply / destroy_transform)
//   2. Working-space profile retrieval (get_working_profile) — returns the
//      canonical sRGB or linear-sRGB profile bytes lcms2 generates on the fly.
//      Used to tag a document after early-binding conversion on import.
//   3. Display 3D-LUT generation (build_3d_lut) — for Tier 2b's GPU
//      display-correction shader. One LUT per display profile change.
//
// All pointer parameters are wasm64 i64 internally; Emscripten's MEMORY64=2
// compat layer converts at the boundary so the TS wrappers can keep treating
// them as plain Numbers (matches the pixelops convention).
//
// VENDOR NOTE: this file expects lcms2 sources at wasm/src/vendor/lcms2/.
// The TU compiles to a no-op when LCMS2_AVAILABLE isn't defined (set by
// CMakeLists when the vendor directory is present), so the build still
// succeeds before lcms2 is dropped in — the TS side feature-detects via
// `typeof module.cms_create_transform === "function"`.

#include <emscripten.h>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <vector>

#if __has_include("vendor/lcms2/include/lcms2.h")
#define LCMS2_AVAILABLE 1
#include "vendor/lcms2/include/lcms2.h"
#endif

#ifdef LCMS2_AVAILABLE

// ─── Helpers ─────────────────────────────────────────────────────────────────

namespace {

// Working-space layout codes shared with the TS side.
constexpr int VERVE_LAYOUT_RGBA8 = 0;
constexpr int VERVE_LAYOUT_RGBA32F = 1;

// Intent codes shared with the TS side. We can't reuse `INTENT_*` names —
// lcms2.h defines those as preprocessor macros (`#define INTENT_PERCEPTUAL 0`
// etc.), which would mangle `constexpr int INTENT_PERCEPTUAL = 0` into
// `constexpr int 0 = 0` before the compiler sees it. Our codes happen to
// match lcms2's numbering, so mapIntent is a no-op range-check.
constexpr int VERVE_INTENT_PERCEPTUAL = 0;
constexpr int VERVE_INTENT_RELATIVE_COLORIMETRIC = 1;
constexpr int VERVE_INTENT_SATURATION = 2;
constexpr int VERVE_INTENT_ABSOLUTE_COLORIMETRIC = 3;

cmsUInt32Number mapIntent(int intent) {
  switch (intent) {
    case VERVE_INTENT_RELATIVE_COLORIMETRIC: return INTENT_RELATIVE_COLORIMETRIC;
    case VERVE_INTENT_SATURATION: return INTENT_SATURATION;
    case VERVE_INTENT_ABSOLUTE_COLORIMETRIC: return INTENT_ABSOLUTE_COLORIMETRIC;
    case VERVE_INTENT_PERCEPTUAL:
    default: return INTENT_PERCEPTUAL;
  }
}

// Build a linear-sRGB profile (sRGB primaries + identity tone curve). lcms2
// has cmsCreate_sRGBProfile() for sRGB itself but no equivalent for linear-
// sRGB, so we synthesise one with cmsCreateRGBProfile() + linear curves.
cmsHPROFILE createLinearSrgbProfile() {
  cmsCIExyYTRIPLE primaries = {
    /* Red   */ {0.6400, 0.3300, 1.0},
    /* Green */ {0.3000, 0.6000, 1.0},
    /* Blue  */ {0.1500, 0.0600, 1.0},
  };
  cmsCIExyY d65 = {0.3127, 0.3290, 1.0};
  cmsToneCurve* linear = cmsBuildGamma(nullptr, 1.0);
  cmsToneCurve* curves[3] = {linear, linear, linear};
  cmsHPROFILE p = cmsCreateRGBProfile(&d65, &primaries, curves);
  cmsFreeToneCurve(linear);
  if (p) cmsSetProfileVersion(p, 4.3);
  return p;
}

cmsHPROFILE workingProfile(int layout) {
  return layout == VERVE_LAYOUT_RGBA32F ? createLinearSrgbProfile()
                                        : cmsCreate_sRGBProfile();
}

cmsUInt32Number pixelFormatFor(int layout) {
  // lcms2 TYPE_* macros encode channel layout + bytes-per-channel + extra.
  return layout == VERVE_LAYOUT_RGBA32F
             ? TYPE_RGBA_FLT      // 4 channels, float, R first, alpha
             : TYPE_RGBA_8;       // 4 channels, 8-bit, R first, alpha
}

// Opaque handle handed back to JS. We store the lcms2 transform plus the
// layout so transform_apply doesn't need it as an arg.
struct TransformHandle {
  cmsHTRANSFORM xform;
  int layout;
};

}  // namespace

extern "C" {

// ─── Working-space profile retrieval ─────────────────────────────────────────
//
// Returns a malloc'd buffer of profile bytes representing the canonical
// working-space profile for the given layout. Writes the byte length to
// *out_size_ptr. Caller frees via cms_free_buffer (or plain _free).
//
// Returns 0 on failure.

EMSCRIPTEN_KEEPALIVE
uint8_t* cms_get_working_profile(int layout, uint32_t* out_size) {
  cmsHPROFILE p = workingProfile(layout);
  if (!p) return nullptr;
  cmsUInt32Number sz = 0;
  if (!cmsSaveProfileToMem(p, nullptr, &sz) || sz == 0) {
    cmsCloseProfile(p);
    return nullptr;
  }
  uint8_t* buf = static_cast<uint8_t*>(std::malloc(sz));
  if (!buf) {
    cmsCloseProfile(p);
    return nullptr;
  }
  if (!cmsSaveProfileToMem(p, buf, &sz)) {
    std::free(buf);
    cmsCloseProfile(p);
    return nullptr;
  }
  cmsCloseProfile(p);
  if (out_size) *out_size = sz;
  return buf;
}

EMSCRIPTEN_KEEPALIVE
void cms_free_buffer(void* ptr) {
  std::free(ptr);
}

// ─── Cached transform: create / apply / destroy ──────────────────────────────
//
// Build once (parses both profiles, builds the optimised pipeline), reuse
// across layers of the same document. Returns 0 on failure.

EMSCRIPTEN_KEEPALIVE
uintptr_t cms_create_transform(
    const uint8_t* src_profile, uint32_t src_len,
    const uint8_t* dst_profile, uint32_t dst_len,
    int layout, int intent, int use_bpc) {
  cmsHPROFILE hSrc = cmsOpenProfileFromMem(src_profile, src_len);
  if (!hSrc) return 0;
  cmsHPROFILE hDst = cmsOpenProfileFromMem(dst_profile, dst_len);
  if (!hDst) {
    cmsCloseProfile(hSrc);
    return 0;
  }
  cmsUInt32Number fmt = pixelFormatFor(layout);
  cmsUInt32Number flags = use_bpc ? cmsFLAGS_BLACKPOINTCOMPENSATION : 0;
  // COPY_ALPHA preserves the alpha channel unchanged through the transform —
  // alpha isn't subject to colour management, only the RGB triple is.
  flags |= cmsFLAGS_COPY_ALPHA;
  cmsHTRANSFORM x = cmsCreateTransform(
      hSrc, fmt, hDst, fmt, mapIntent(intent), flags);
  cmsCloseProfile(hSrc);
  cmsCloseProfile(hDst);
  if (!x) return 0;
  TransformHandle* h = new TransformHandle{x, layout};
  return reinterpret_cast<uintptr_t>(h);
}

EMSCRIPTEN_KEEPALIVE
void cms_transform_apply(
    uintptr_t handle, const void* in_ptr, void* out_ptr, uint32_t pixel_count) {
  auto* h = reinterpret_cast<TransformHandle*>(handle);
  if (!h || !h->xform) return;
  cmsDoTransform(h->xform, in_ptr, out_ptr, pixel_count);
}

EMSCRIPTEN_KEEPALIVE
void cms_destroy_transform(uintptr_t handle) {
  auto* h = reinterpret_cast<TransformHandle*>(handle);
  if (!h) return;
  if (h->xform) cmsDeleteTransform(h->xform);
  delete h;
}

// ─── 3D LUT generation (Tier 2b) ─────────────────────────────────────────────
//
// Sample a `size × size × size` 3D LUT from working-space → destination
// profile. The LUT is written into out_ptr as `size^3 * 4` floats (RGBA,
// alpha=1). Coordinate convention: index [r, g, b] is at offset
// (r + g*size + b*size*size) * 4 with r/g/b varying from 0 to (size-1)
// over the [0, 1] working-space range. Suitable for direct upload as a
// WebGPU `r16float`/`rgba16f` 3D texture in Tier 2b.
//
// `layout` selects the source format the LUT is intended for (rgba8 → sRGB
// working space, rgba32f → linear-sRGB working space). Returns 0 on success,
// non-zero on failure.

EMSCRIPTEN_KEEPALIVE
int cms_build_3d_lut(
    const uint8_t* dst_profile, uint32_t dst_len,
    int layout, int intent, int use_bpc,
    int size, float* out) {
  if (size < 2 || !out) return 1;
  cmsHPROFILE hSrc = workingProfile(layout);
  if (!hSrc) return 2;
  cmsHPROFILE hDst = cmsOpenProfileFromMem(dst_profile, dst_len);
  if (!hDst) {
    cmsCloseProfile(hSrc);
    return 3;
  }
  cmsUInt32Number flags = use_bpc ? cmsFLAGS_BLACKPOINTCOMPENSATION : 0;
  // The LUT samples linear-light floats regardless of layout — the renderer
  // applies it in linear-light space after any sRGB decode of the source.
  cmsHTRANSFORM x = cmsCreateTransform(
      hSrc, TYPE_RGB_FLT, hDst, TYPE_RGB_FLT, mapIntent(intent), flags);
  cmsCloseProfile(hSrc);
  cmsCloseProfile(hDst);
  if (!x) return 4;

  const int N = size;
  const float denom = 1.0f / static_cast<float>(N - 1);
  // Sample one z-slice at a time to keep stack/scratch small.
  std::vector<float> inSlice(N * N * 3);
  std::vector<float> outSlice(N * N * 3);
  for (int b = 0; b < N; b++) {
    for (int g = 0; g < N; g++) {
      for (int r = 0; r < N; r++) {
        const int i = (g * N + r) * 3;
        inSlice[i + 0] = r * denom;
        inSlice[i + 1] = g * denom;
        inSlice[i + 2] = b * denom;
      }
    }
    cmsDoTransform(x, inSlice.data(), outSlice.data(), N * N);
    for (int g = 0; g < N; g++) {
      for (int r = 0; r < N; r++) {
        const int srcI = (g * N + r) * 3;
        const int dstI = (r + g * N + b * N * N) * 4;
        out[dstI + 0] = outSlice[srcI + 0];
        out[dstI + 1] = outSlice[srcI + 1];
        out[dstI + 2] = outSlice[srcI + 2];
        out[dstI + 3] = 1.0f;
      }
    }
  }
  cmsDeleteTransform(x);
  return 0;
}

}  // extern "C"

#endif  // LCMS2_AVAILABLE
