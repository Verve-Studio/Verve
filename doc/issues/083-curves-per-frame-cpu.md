# 083 · Curves rebuilds its LUTs and a signature string every frame

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Performance |
| Area | Effects / Curves |
| Verified | No — reported by reviewer |

## Problem
`buildPlanEntry` rebuilds all 4 LUTs on every plan build (`CurvesEffect.tsx:125`), and a ~4 KB signature string is built by joining 1,024 numbers every frame (`:81`).

## Where
- `src/core/effects/Curves/CurvesEffect.tsx:81, 125`

## Suggested fix
Memoize LUTs per params object with a `WeakMap`; compare `Uint8Array`s directly (or use a version counter) instead of joining.

## Done when
- No LUT rebuild or string join when Curves params are unchanged.


## Resolution
Done as part of 077: buildCurvesLuts memoizes per params object (WeakMap) and ensureLutTextures compares LUT-set identity instead of building a signature string.
