# 035 · GrabCut's recursive max-flow DFS runs on a 64 KB stack

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | Medium |
| Category | Stability |
| Area | WASM / GrabCut |
| Verified | No — reported by reviewer |

## Problem
Dinic's `dfs_augment` recurses once per path hop; path length grows in later phases on large grid graphs. `CMakeLists.txt` doesn't set `-sSTACK_SIZE`, so the Emscripten default of 64 KB applies. Overflow corrupts memory silently in release builds.

## Where
- `wasm/src/grabcut.cpp:343`
- `wasm/CMakeLists.txt`

## Suggested fix
Make the DFS iterative with an explicit stack. As an immediate mitigation set `-sSTACK_SIZE=8MB` (and consider `-sSTACK_OVERFLOW_CHECK=1` in debug builds).

## Done when
- GrabCut on a large, complex image completes without memory corruption.


## Resolution
Replaced the recursive `dfs_augment` in `wasm/src/grabcut.cpp` with an iterative version that has the same Dinic semantics (explicit edge path, bottleneck push at T, retreat + advance of the parent's edge pointer on dead ends). Also added `-sSTACK_SIZE=1MB` in `wasm/CMakeLists.txt` as general headroom. WASM rebuilt; a Node test of `_pixelops_grabcut` on synthetic images (64², 800×600) segments 100% correctly.
