# 091 · Integer overflow in C++ index math for very large images

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Correctness |
| Area | WASM / C++ |
| Verified | No — reported by reviewer |

## Problem
`(y*width+x)*4` computed as `int` overflows past ~536M pixels (~23170²), which the 16 GB memory cap makes reachable.

## Where
- `wasm/src/fill.cpp:27, 42, 63, …`
- `wasm/src/resize.cpp:28-35`
- `wasm/src/curves_histogram.cpp:17` (`uint32 i*4`)

## Suggested fix
Use `size_t` / `ptrdiff_t` for index math, as `transform.cpp` already does. Grep all of `wasm/src` for `*4` / `* 4` index expressions on `int`.

## Done when
- Flood fill and resize work correctly on a 24000² document.


## Resolution
Pixel index/offset arithmetic across 13 first-party wasm/src files promoted to size_t/ptrdiff_t before multiplying (fill, resize, curves_histogram, dither, quantize, transform, filters, inpaint, grabcut, brush_stamp, pixelops floodFillIndexed, dds, exr). DDS decode size checks are now 64-bit (a hostile header could previously wrap w*h*4 past the outSize check) and negative header dimensions are rejected. Deliberately unchanged: vendored code, lcms2 uint32 counts, GrabCut graph node ids and per-pixel int storage in inpaint/grabcut (can't reach 2^31 within the 16 GB cap). Exported int32 size params still cap DDS/EXR files at 2 GB (clean error). WASM rebuilt, no warnings.
