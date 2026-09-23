# 063 · Liquify allocates full-layer buffers at every stroke start

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance / Stability |
| Area | Tools / Liquify |
| Verified | No — reported by reviewer |

## Problem
Each pointer-down copies the whole layer and allocates a `Float32Array(2*W*H)` displacement map: ~200 MB per stroke at 4K rgba32f; on an A1 rgba8 layer the displacement map alone is ~550 MB (OOM risk). When the brush is outside the layer, `applyAt` returns before `markDirtyRect`, so `flushLayer` (`:294`) does a full upload on every move. Also creates a `fetch` closure per pixel in `sampleSource` (`:97`).

## Where
- `src/core/tools/Liquify/Liquify.tsx:97, 274-278, 294`

## Suggested fix
Use a sparse tiled displacement map and snapshot tiles lazily. Only flush when something was dirtied. Inline the sampler.

## Done when
- Liquify on an A1 document doesn't allocate hundreds of MB per stroke; moving outside the layer doesn't upload.


## Resolution
Liquify now keeps its per-stroke state in 64×64 tiles (`LiquifyStroke`). A snapshot tile is captured just before the brush first writes into it; reads from never-written tiles go to the live layer, which is still original there. Displacement tiles are allocated only where the brush has been. Nothing is allocated up front any more (it used to be a full layer copy plus a `2·W·H` Float32 map per stroke). The per-pixel `fetch` closure is gone, and the layer is flushed only when a stamp wrote pixels (brush outside the layer no longer uploads the full layer each move). Indexed8 flushes pass the palette. A Node test confirmed sampling is bit-identical to a full snapshot for rgba8, rgba32f and indexed8.
