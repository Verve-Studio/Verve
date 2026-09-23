# 122 · Eraser defaults to painting the background colour; indexed8 ignores strength

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness (UX) |
| Area | Tools / Eraser |
| Verified | Yes |

## Problem
`alphaMode` defaults to false, so the eraser blends toward the secondary colour instead of erasing to transparency; indexed8 always erases fully.

## Where
- `src/core/tools/Eraser/Eraser.tsx:25, 101-124`

## Suggested fix
Default to erasing alpha.

## Done when
- The eraser makes pixels transparent by default.

## Resolution
eraserOptions.alphaMode defaults to true (erase to transparency); painting the background colour remains available as an option. Indexed8 erasing stays binary by nature, since a palette index can't be partially erased.
