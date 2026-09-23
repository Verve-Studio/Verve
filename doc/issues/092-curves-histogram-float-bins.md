# 092 · Curves histogram bins saturate on large images

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Correctness |
| Area | WASM / Curves histogram |
| Verified | No — reported by reviewer |

## Problem
Bins accumulate in `float`; past 2^24, adding 1.0 no longer changes the value, so bins stall on large flat images.

## Where
- `wasm/src/curves_histogram.cpp:40-45`

## Suggested fix
Accumulate in `uint32_t`/`uint64_t` or `double` and convert at the end.

## Done when
- The histogram of a 50 MP flat-colour image shows the correct count.


## Resolution
computeCurvesHistogram accumulates bins in a local double[1024] and converts to float once at the end; exported signature and output layout unchanged.
