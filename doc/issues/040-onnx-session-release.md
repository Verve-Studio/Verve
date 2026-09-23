# 040 · ONNX sessions are never released and can be created twice

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | Medium |
| Category | Stability / Memory |
| Area | Electron main / ML |
| Verified | No — reported by reviewer |

## Problem
"Invalidate" drops the JS reference without `session.release()`. Native ORT memory (DML/CoreML GPU buffers, 100–200 MB of weights each) stays allocated and competes with WebGPU for VRAM. All sessions otherwise live for the whole app lifetime. `loadSession` has no in-flight promise guard, so two concurrent calls each create a session and one leaks.

## Where
- `electron/main/isnet.ts:533, 704-706`
- `electron/main/inpaint.ts:438-440`
- `electron/main/matting.ts:343, 395-397`
- `electron/main/upscale.ts:117-163, 533-534`

## Suggested fix
`await session.release()` on invalidate. Cache the loading promise instead of the result. Evict idle sessions after N minutes or keep one at a time (LRU). Simpler once [037](037-ml-in-main-process.md) moves them into a worker.

## Done when
- Running each ML feature twice concurrently creates one session; idle sessions are released after the timeout.


## Resolution
Every model module caches the in-flight load promise, so concurrent runs share one session. Invalidation now calls `session.release()`. Upscale keeps only one model resident (loading another releases the previous one). The worker's idle shutdown (037) frees everything after 3 min of inactivity.
