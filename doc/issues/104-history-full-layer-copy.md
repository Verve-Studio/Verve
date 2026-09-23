# 104 · Each stroke's undo entry is a full-layer copy

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | High |
| Category | Performance / Memory |
| Area | History |
| Verified | Yes |

## Problem
`useHistory` clones every changed layer in full on pointer-up (278 MB for an A1 rgba8 layer), a visible hitch, and the 4 GB cap holds only ~14 such steps. `enforceMemoryCap` also rebuilds ref-count maps over all entries on each push.

## Where
- `src/core/services/useHistory.ts:70-105`
- `src/core/store/historyStore.ts:289-345`

## Suggested fix
Tile-based copy-on-write snapshots: share unchanged tiles with the previous entry and copy only tiles touched since the last capture.

## Done when
- A small dab on a large layer stores only the touched tiles.

## Resolution
History entries store each layer as immutable 256×256 tiles (src/core/store/tiledSnapshot.ts). LayerTextureStore records per-layer history changes at the single point every visible pixel change passes through: flushed rects, plus pending dirty rects, plus 'all' after register/replaceTexture. captureHistory copies only the tiles touched since the previous capture and shares the rest with the previous entry. It falls back to a full snapshot for new layers, geometry/format changes and after restores (which flush the whole layer). Restore/jump paths materialize full buffers; memory accounting and the cap count unique tiles. Unit-tested round trips on odd sizes, indexed and float.
