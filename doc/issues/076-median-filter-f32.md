# 076 · Median filter uses 256-bin histograms on linear floats

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness / Performance |
| Area | Effects / MedianFilter |
| Verified | No — reported by reviewer |

## Problem
On rgba32f, HDR values > 1 index past bin 255 and are clamped, reading back as 1.0. Shadows are posterized because linear 1/255 steps are huge in the darks. The three 256-entry `u32` private arrays (3 KB per invocation) spill registers.

## Where
- `src/core/effects/MedianFilter/filter-median.wgsl:66-68`

## Suggested fix
sRGB-encode before binning and decode after; pass HDR pixels > 1 through (or handle separately). For small radii use a sorting network instead of histograms.

## Done when
- Median on rgba32f shows no shadow posterization and preserves HDR highlights.


## Resolution
filter-median.wgsl uses one 320-bin histogram reused per channel (was 3×256 live arrays). For linear targets (MedianParams.isLinear) values ≤ 1 are binned sRGB-encoded (8-bit-equivalent shadow precision) and values > 1 go into 64 log2 HDR bins (8 per stop), so highlights are preserved. Validated with naga.
