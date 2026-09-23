# 002 · EXR export writes empty files (wasm64 struct layout)

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P0 |
| Severity | High |
| Category | Correctness |
| Area | WASM / File I/O |
| Verified | Yes — confirmed in code during review |

## Problem
The WASM build is wasm64 (`-sMEMORY64=2`). `struct ExrBytes { unsigned char* data; int size; }` therefore has an 8-byte pointer and `size` at offset 8. The JS side reads the pointer with `getInt32(resultPtr)` and the size with `getInt32(resultPtr + 4)`, which is the high half of the pointer and is 0 on heaps < 4 GB. `outLen = 0`, so every EXR export (single, per-layer, multi-layer) writes 0 bytes.

## Where
- `wasm/src/exr.cpp:42-45`
- `src/wasm/index.ts:940-941` (`encodeExr`) and `:1084` (`encodeExrLayers`)

## Suggested fix
Use fixed-width fields: `struct ExrBytes { uint64_t data; int32_t size; int32_t _pad; }` with `static_assert(offsetof(ExrBytes, size) == 8)`. In JS read the pointer with `Number(view.getBigUint64(resultPtr, true))` and the size with `getInt32(resultPtr + 8, true)`. Rebuild with `npm run build:wasm`.

## Done when
- Exported EXR files are non-empty and re-open correctly in Verve and in an external viewer (single-layer, multi-layer, half-float).


## Resolution
All EXR result structs in `wasm/src/exr.cpp` now store pointers as explicit `uint64_t` with `static_assert` layouts (`ExrBytes` = 16 B, size at +8). `src/wasm/index.ts` reads pointers via a new `readPtr()` (`getBigUint64`). WASM rebuilt; verified with a Node round-trip (encode 7×5 → 520 bytes → decode, max error 0). Requires `npm run build:wasm` on other machines.
