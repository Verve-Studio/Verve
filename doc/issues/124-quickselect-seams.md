# 124 · Quick Select leaves seams and drops stamps

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / Quick Select |
| Verified | Yes |

## Problem
Neighbours are marked `seen` when pushed even if rejected against that stamp's seed, so later stamps with a different seed can never select them.

## Where
- `src/core/tools/QuickSelect/QuickSelect.tsx:128-192`

## Suggested fix
Mark `seen` only for accepted pixels.

## Done when
- No unselected seams between regions painted in one stroke.

## Resolution
floodFillFromSeed marks `seen` only for pixels accepted and expanded (d ≤ tolerance); queueing within one call uses a per-call generation stamp (Uint32 visit buffer), so pixels rejected against one stamp's seed stay available to later stamps with a different seed. No more seams or dropped stamps; strokes stay linear because accepted regions are never re-walked.
