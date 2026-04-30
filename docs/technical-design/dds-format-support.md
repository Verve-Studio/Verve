# Technical Design: DDS Format Support

## Overview

This feature adds first-class DirectDraw Surface (DDS) support to Verve. DDS files are opened
via the existing **File → Open** path, decoded from BCx-compressed or uncompressed formats to RGBA8
in the C++/WASM layer, and loaded onto the canvas as a new raster layer. The **Export As** dialog
gains a DDS option with three controls (compression format, mip maps, header variant). Export
flattens the document via the unified rasterization pipeline, then compresses the resulting RGBA8
buffer to DDS in a dedicated Web Worker (required to keep the UI responsive and support
cancellation during potentially multi-second BC7/BC6H compression). All BCx encode and decode work
happens exclusively in the WASM layer — no GPU-side BCx encoding is performed.

---

## Affected Areas

| File | Change |
|---|---|
| `wasm/src/vendor/bcdec.h` | New — vendored bcdec single-header BCx decoder |
| `wasm/src/vendor/rgbcx.h` | New — vendored rgbcx single-header BC1–BC5 encoder |
| `wasm/src/vendor/bc7enc.h` | New — vendored bc7enc_rdo header for BC6H/BC7 encoding |
| `wasm/src/vendor/bc7enc.cpp` | New — vendored bc7enc_rdo implementation |
| `wasm/src/dds.h` | New — C++ DDS encode/decode API header |
| `wasm/src/dds.cpp` | New — DDS encode/decode implementation |
| `wasm/src/pixelops.cpp` | Modify — add `extern "C"` wrappers for the four new DDS functions |
| `wasm/CMakeLists.txt` | Modify — add `dds.cpp` + `bc7enc.cpp`, vendor include dir, four new exported symbols |
| `src/wasm/types.ts` | Modify — add four DDS method signatures to `PixelOpsModule` |
| `src/wasm/index.ts` | Modify — add `DdsFormat`/`DdsHeaderMode` enums, `decodeDds()`, `getDdsInfo()` wrappers |
| `src/core/io/imageLoader.ts` | Modify — add `.dds` to `IMAGE_EXTENSIONS`/`EXT_TO_MIME`; add DDS decode branch |
| `src/core/io/ddsWorker.ts` | New — Vite Web Worker module; calls WASM `encodeDds` on behalf of the export service |
| `src/core/io/exportDds.ts` | New — main-thread helper; spawns/manages the DDS worker, returns `Promise<Uint8Array>` |
| `src/ux/modals/ExportDialog/ExportDialog.tsx` | Modify — add `'dds'` format, `DdsOptions` interface, in-progress state, cancel button |
| `src/core/services/useExportOps.ts` | Modify — handle `'dds'` format branch, thread `AbortSignal` to `exportDds` |
| `electron/main/ipc.ts` | Modify — add `.dds` to open-file filters; add `'dds'` case to `exportBrowse` handler |

---

## State Changes

No new fields are required in `AppState` or `AppContext`. DDS import produces a normal raster layer
via the existing `SWITCH_TAB` / `OPEN_FILE` path. The export options (format, compression, mip
maps, header) are local state inside `ExportDialog` — they are not persisted to the document or to
`AppState`.

Two interface changes are required:

1. **`ExportFormat`** (local type in `ExportDialog.tsx`) — add the `'dds'` literal.
2. **`ExportSettings`** (local type in `ExportDialog.tsx`) — add a `ddsOptions: DdsOptions` field.
3. **`ExportDialogProps.onConfirm`** — signature changes from
   `(settings: ExportSettings) => void`  
   to  
   `(settings: ExportSettings, signal: AbortSignal) => Promise<void>`  
   This allows the dialog to pass a cancellation signal for long-running DDS compression without
   coupling to a specific cancellation mechanism. Non-DDS formats ignore the signal.

---

## New Components / Hooks / Tools

### `src/core/io/exportDds.ts` — export helper

**Category:** IO utility (not a React component or hook).  
**Responsibility:** Spawn the DDS worker, transfer the RGBA buffer, resolve with the encoded DDS
bytes `Uint8Array`, and terminate the worker on cancellation.

```ts
export interface DdsExportOptions {
  format: DdsFormat          // see DdsFormat enum below
  mipmapLevels: number       // 1 = base only; computed mip count for full chain
  headerMode: DdsHeaderMode  // DX9 | DX10
}

export function exportDds(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: DdsExportOptions,
  signal?: AbortSignal
): Promise<Uint8Array>
```

Internally:
- Creates `new Worker(new URL('./ddsWorker', import.meta.url), { type: 'module' })`.
- Transfers `rgba.buffer` via `postMessage` (zero-copy).
- Listens for `{ type: 'done', ddsBytes: ArrayBuffer }` or `{ type: 'error', message: string }`.
- If `signal` fires, calls `worker.terminate()` and rejects with `DOMException('AbortError')`.

### `src/core/io/ddsWorker.ts` — Web Worker module

**Category:** Worker script.  
**Responsibility:** Import `encodeDds` from `@/wasm/index.ts`, process a single encode request,
post the result back.

Receives `{ rgba: ArrayBuffer, width, height, options }` and posts `{ type: 'done', ddsBytes }` or
`{ type: 'error', message }`. Loads its own isolated instance of the WASM module (does not share
the main-thread singleton).

---

## Implementation Steps

### Step 1 — Vendor third-party C libraries

Place the following libraries under `wasm/src/vendor/`. These are header-only or single-unit
libraries with permissive licenses (MIT or similar).

| Library | Source | Files |
|---|---|---|
| **bcdec** | https://github.com/iOrange/bcdec | `bcdec.h` (single header, define `BCDEC_IMPLEMENTATION` in one `.cpp`) |
| **rgbcx** | https://github.com/richgel999/bc7enc_rdo | `rgbcx.h` (part of bc7enc_rdo repo) |
| **bc7enc_rdo** | https://github.com/richgel999/bc7enc_rdo | `bc7enc.h`, `bc7enc.cpp` |

`bcdec.h` covers decode for BC1–BC7 (including BC6H). `rgbcx.h` covers fast encode for BC1–BC5.
`bc7enc` covers high-quality BC7 encode and BC6H_UF16 encode.

Define `BCDEC_IMPLEMENTATION` once, at the top of `wasm/src/dds.cpp`, before including `bcdec.h`.
Initialize `rgbcx::init()` once inside a C++ constructor or at the start of `pixelops_dds_encode`.

### Step 2 — Implement `wasm/src/dds.h` and `wasm/src/dds.cpp`

#### `wasm/src/dds.h`

```cpp
#pragma once
#include <cstdint>

// Error codes returned by DDS functions.
// 0 = success; negative = error (see constants below).
static constexpr int DDS_OK                     =  0;
static constexpr int DDS_ERR_INVALID_HEADER     = -1;
static constexpr int DDS_ERR_UNSUPPORTED_FORMAT = -2;
static constexpr int DDS_ERR_CUBEMAP            = -3;
static constexpr int DDS_ERR_VOLUME_TEXTURE     = -4;
static constexpr int DDS_ERR_ARRAY_TEXTURE      = -5;
static constexpr int DDS_ERR_DECODE_FAILED      = -6;
static constexpr int DDS_ERR_ENCODE_FAILED      = -7;

// Pixel format codes used by the TypeScript caller (match DdsFormat enum in index.ts).
static constexpr int DDS_FMT_RGBA8        = 0;
static constexpr int DDS_FMT_BC1_NOALPHA  = 1;
static constexpr int DDS_FMT_BC1_ALPHA    = 2;
static constexpr int DDS_FMT_BC2          = 3;
static constexpr int DDS_FMT_BC3          = 4;
static constexpr int DDS_FMT_BC4          = 5;
static constexpr int DDS_FMT_BC5          = 6;
static constexpr int DDS_FMT_BC6H_UF16   = 7;
static constexpr int DDS_FMT_BC7          = 8;

// Header mode codes.
static constexpr int DDS_HEADER_DX9  = 0;
static constexpr int DDS_HEADER_DX10 = 1;

/**
 * Parse a DDS file header and return image metadata.
 * Does NOT decode pixel data.
 * @param widthOut     Receives mip-0 width.
 * @param heightOut    Receives mip-0 height.
 * @param formatOut    Receives detected DDS_FMT_* code; -1 for unrecognised.
 * @return DDS_OK or a DDS_ERR_* code.
 */
int dds_get_info(
    const uint8_t* ddsBytes, int ddsByteLength,
    int* widthOut, int* heightOut, int* formatOut
);

/**
 * Decode mip-0 of a DDS file to a caller-allocated RGBA8 buffer.
 * Buffer must be at least width * height * 4 bytes.
 * @return DDS_OK or a DDS_ERR_* code.
 */
int dds_decode(
    const uint8_t* ddsBytes, int ddsByteLength,
    uint8_t* rgbaOut, int width, int height
);

/**
 * Return the total byte size needed for the full encoded DDS file,
 * including header(s) and all mip levels.
 */
int dds_get_encoded_size(
    int width, int height, int format, int mipmapLevels, int headerMode
);

/**
 * Encode an RGBA8 source to a DDS file.
 * @param ddsOut  Pre-allocated buffer of dds_get_encoded_size() bytes.
 * @return DDS_OK or a DDS_ERR_* code.
 */
int dds_encode(
    const uint8_t* rgbaIn, int width, int height,
    int format, int mipmapLevels, int headerMode,
    uint8_t* ddsOut
);
```

#### Key implementation notes for `wasm/src/dds.cpp`

**DDS header parsing:**

The DDS magic is `0x20534444` (`'DDS '`), at byte offset 0. The 124-byte `DDSURFACEDESC2`
header starts at byte 4. For DX10 files, the `ddspf.dwFourCC` field equals the four-byte code
`'DX10'`; a 20-byte `DDS_HEADER_DXT10` block immediately follows the 124-byte header (at byte 128).

Detect these error conditions before decoding:
- `DDSCAPS2_CUBEMAP` flag (`0x200`) set in `dwCaps2` → return `DDS_ERR_CUBEMAP`.
- `DDSCAPS2_VOLUME` flag (`0x200000`) set in `dwCaps2`, or `resourceDimension == 4`
  (D3D10_RESOURCE_DIMENSION_TEXTURE3D) in DX10 header → return `DDS_ERR_VOLUME_TEXTURE`.
- `arraySize > 1` in DX10 header → return `DDS_ERR_ARRAY_TEXTURE`.

**Format detection table:**

| DX9 FOURCC / DX10 DXGI | Detected as |
|---|---|
| `DXT1` / `DXGI_FORMAT_BC1_UNORM (71)` | `DDS_FMT_BC1_*` (check alpha flag) |
| `DXT3` / `DXGI_FORMAT_BC2_UNORM (74)` | `DDS_FMT_BC2` |
| `DXT5` / `DXGI_FORMAT_BC3_UNORM (77)` | `DDS_FMT_BC3` |
| `ATI1` / `DXGI_FORMAT_BC4_UNORM (80)` | `DDS_FMT_BC4` |
| `ATI2` / `DXGI_FORMAT_BC5_UNORM (83)` | `DDS_FMT_BC5` |
| `DXGI_FORMAT_BC6H_UF16 (95)` | `DDS_FMT_BC6H_UF16` |
| `DXGI_FORMAT_BC6H_SF16 (96)` | `DDS_FMT_BC6H_UF16` (decoded, clamped to 8-bit) |
| `DXGI_FORMAT_BC7_UNORM (98)` | `DDS_FMT_BC7` |
| `D3DFMT_A8R8G8B8` / `DXGI_FORMAT_B8G8R8A8_UNORM (87)` | uncompressed BGRA8 → swap to RGBA8 |
| `DXGI_FORMAT_R8G8B8A8_UNORM (28)` | uncompressed RGBA8 (passthrough) |

For BC6H (HDR float), bcdec decodes each pixel to three `float16` values. Tone-map to 8-bit using
a simple clamp: `out = clamp(f16_to_f32(x) * 255.0f, 0.0f, 255.0f)`. The spec permits any
tone-mapping strategy as long as the result is in 0–255.

**Pixel data offset:**
`pixelDataOffset = 4 /* magic */ + 124 /* DX9 header */ + (isDX10 ? 20 : 0)`.

**Block sizes:**
- BC1, BC4: 8 bytes per 4×4 block.
- BC2, BC3, BC5, BC6H, BC7: 16 bytes per 4×4 block.
- Number of blocks per dimension: `ceil(width / 4)` × `ceil(height / 4)`.

**Mip chain generation in `dds_encode`:**

For `mipmapLevels > 1`, generate mip levels from the base RGBA using a box filter (average 2×2
pixel quads). Encode each mip level independently. Write all levels contiguously after the header,
mip 0 first.

**`dds_get_encoded_size` formula:**

```
headerBytes = 4 + 124 + (headerMode == DX10 ? 20 : 0)
pixelBytes  = 0
for level in 0 ..< mipmapLevels:
    w = max(1, width  >> level)
    h = max(1, height >> level)
    if format == RGBA8:
        pixelBytes += w * h * 4
    else:
        bw = (w + 3) / 4
        bh = (h + 3) / 4
        pixelBytes += bw * bh * blockSize(format)
return headerBytes + pixelBytes
```

**DDS header fields written by `dds_encode`:**

DX9 header (128 bytes starting at offset 4):
```
dwSize             = 124
dwFlags            = 0x1 | 0x2 | 0x4 | 0x1000         // CAPS | HEIGHT | WIDTH | PIXELFORMAT
                   | (mipmapLevels > 1 ? 0x20000 : 0)  // MIPMAPCOUNT
                   | (isCompressed ? 0x80000 : 0x8)     // LINEARSIZE or PITCH
dwHeight           = height
dwWidth            = width
dwPitchOrLinearSize = (isCompressed ? compressedSize(mip0) : width * 4)
dwDepth            = 0
dwMipMapCount      = mipmapLevels
dwReserved1[11]    = {0}
```

`DDPIXELFORMAT` sub-structure (32 bytes):
```
dwSize    = 32
dwFlags   = (isCompressed ? 0x4 : 0x41)  // DDPF_FOURCC or DDPF_RGB | DDPF_ALPHAPIXELS
dwFourCC  = (DX10 ? "DX10" : fourccForFormat(format))
// Uncompressed-only fields (all 0 for compressed):
dwRGBBitCount = 32
dwRBitMask    = 0x000000FF
dwGBitMask    = 0x0000FF00
dwBBitMask    = 0x00FF0000
dwABitMask    = 0xFF000000
```

`DDCAPS2` sub-structure (16 bytes):
```
dwCaps  = 0x1000 | (mipmapLevels > 1 ? 0x400008 : 0)  // TEXTURE | (MIPMAP | COMPLEX)
dwCaps2 = 0; dwCaps3 = 0; dwCaps4 = 0
```

DX10 extension block (20 bytes at byte 128, only written when `headerMode == DX10`):
```
dxgiFormat        = dxgiFormatCode(format)
resourceDimension = 3   // D3D10_RESOURCE_DIMENSION_TEXTURE2D
miscFlag          = 0
arraySize         = 1
miscFlags2        = 0
```

DXGI format codes:
```
RGBA8     → 28   (DXGI_FORMAT_R8G8B8A8_UNORM)
BC1       → 71   (DXGI_FORMAT_BC1_UNORM)
BC2       → 74   (DXGI_FORMAT_BC2_UNORM)
BC3       → 77   (DXGI_FORMAT_BC3_UNORM)
BC4       → 80   (DXGI_FORMAT_BC4_UNORM)
BC5       → 83   (DXGI_FORMAT_BC5_UNORM)
BC6H_UF16 → 95   (DXGI_FORMAT_BC6H_UF16)
BC7       → 98   (DXGI_FORMAT_BC7_UNORM)
```

DX9 FOURCC codes (used when `headerMode == DX9`):
```
BC1 (no alpha)  → 'DXT1'
BC1 (1-bit α)   → 'DXT1'
BC2             → 'DXT3'
BC3             → 'DXT5'
BC4             → 'ATI1'
BC5             → 'ATI2'
RGBA8           → 0 (no FOURCC; use RGB + alpha pixel flags)
```

BC6H and BC7 cannot be written with a DX9 header; the TypeScript caller must always pass
`DDS_HEADER_DX10` for these formats (enforced by the UI; the C++ layer may assert or return
`DDS_ERR_INVALID_HEADER` if DX9 is supplied with BC6H/BC7).

### Step 3 — Update `wasm/src/pixelops.cpp`

Add `#include "dds.h"` at the top. Add four `extern "C" EMSCRIPTEN_KEEPALIVE` wrappers inside the
existing `extern "C"` block:

```cpp
EMSCRIPTEN_KEEPALIVE
int pixelops_dds_get_info(
    const uint8_t* ddsBytes, int ddsByteLength,
    int* widthOut, int* heightOut, int* formatOut
) {
    return dds_get_info(ddsBytes, ddsByteLength, widthOut, heightOut, formatOut);
}

EMSCRIPTEN_KEEPALIVE
int pixelops_dds_decode(
    const uint8_t* ddsBytes, int ddsByteLength,
    uint8_t* rgbaOut, int width, int height
) {
    return dds_decode(ddsBytes, ddsByteLength, rgbaOut, width, height);
}

EMSCRIPTEN_KEEPALIVE
int pixelops_dds_get_encoded_size(
    int width, int height, int format, int mipmapLevels, int headerMode
) {
    return dds_get_encoded_size(width, height, format, mipmapLevels, headerMode);
}

EMSCRIPTEN_KEEPALIVE
int pixelops_dds_encode(
    const uint8_t* rgbaIn, int width, int height,
    int format, int mipmapLevels, int headerMode,
    uint8_t* ddsOut
) {
    return dds_encode(rgbaIn, width, height, format, mipmapLevels, headerMode, ddsOut);
}
```

The three int output-pointer parameters in `dds_get_info` (`widthOut`, `heightOut`, `formatOut`)
need caller-allocated slots. The TypeScript wrapper allocates three 4-byte WASM heap slots, passes
their pointers, then reads the values back with `DataView` (see Step 5).

### Step 4 — Update `wasm/CMakeLists.txt`

1. Add `src/dds.cpp` and `src/vendor/bc7enc.cpp` to `add_executable(pixelops ...)`.
2. Add `target_include_directories(pixelops PRIVATE src src/vendor)`.
3. Append the four new function names to `-sEXPORTED_FUNCTIONS`:
   `_pixelops_dds_get_info`, `_pixelops_dds_decode`, `_pixelops_dds_get_encoded_size`,
   `_pixelops_dds_encode`.

### Step 5 — Update `src/wasm/types.ts`

Add the four DDS method signatures to the `PixelOpsModule` interface:

```ts
/**
 * Parse a DDS file header. Output values are written to pre-allocated 4-byte slots.
 * Returns 0 on success or a negative DDS_ERR_* code.
 */
_pixelops_dds_get_info(
  ddsBytesPtr: number,
  ddsByteLength: number,
  widthOutPtr: number,
  heightOutPtr: number,
  formatOutPtr: number
): number

/**
 * Decode mip-0 to RGBA8 into a pre-allocated output buffer (width * height * 4 bytes).
 * Returns 0 on success or a negative DDS_ERR_* code.
 */
_pixelops_dds_decode(
  ddsBytesPtr: number,
  ddsByteLength: number,
  rgbaOutPtr: number,
  width: number,
  height: number
): number

/**
 * Returns the total byte size of the DDS file that encode will produce.
 */
_pixelops_dds_get_encoded_size(
  width: number,
  height: number,
  format: number,
  mipmapLevels: number,
  headerMode: number
): number

/**
 * Encode RGBA8 to DDS. ddsOutPtr must be pre-allocated with get_encoded_size() bytes.
 * Returns 0 on success or a negative DDS_ERR_* code.
 */
_pixelops_dds_encode(
  rgbaInPtr: number,
  width: number,
  height: number,
  format: number,
  mipmapLevels: number,
  headerMode: number,
  ddsOutPtr: number
): number
```

### Step 6 — Update `src/wasm/index.ts`

Add the following exports after the existing enums/types:

```ts
// ─── DDS enums ────────────────────────────────────────────────────────────────

export const enum DdsFormat {
  UncompressedRGBA8 = 0,
  BC1_NoAlpha       = 1,
  BC1_Alpha1Bit     = 2,
  BC2               = 3,
  BC3               = 4,
  BC4               = 5,
  BC5               = 6,
  BC6H_UF16         = 7,
  BC7               = 8,
}

export const enum DdsHeaderMode {
  DX9  = 0,
  DX10 = 1,
}

export interface DecodeDdsResult {
  data:   Uint8Array
  width:  number
  height: number
}

export interface EncodeDdsOptions {
  format:       DdsFormat
  mipmapLevels: number        // 1 = base only
  headerMode:   DdsHeaderMode
}
```

Add the `getDdsInfo` and `decodeDds` wrapper functions:

```ts
/**
 * Parse a DDS file header without decoding pixel data.
 * Throws with a descriptive message on error.
 */
export async function getDdsInfo(
  ddsBytes: Uint8Array
): Promise<{ width: number; height: number; format: number }> {
  const m = await getPixelOps()
  const ddsPtr = m._malloc(ddsBytes.byteLength)
  const wPtr   = m._malloc(4)
  const hPtr   = m._malloc(4)
  const fPtr   = m._malloc(4)
  try {
    m.HEAPU8.set(ddsBytes, ddsPtr)
    const rc = m._pixelops_dds_get_info(ddsPtr, ddsBytes.byteLength, wPtr, hPtr, fPtr)
    if (rc !== 0) throw ddsErrorFromCode(rc, -1)
    const view = new DataView(m.HEAPU8.buffer)
    return {
      width:  view.getInt32(wPtr, true),
      height: view.getInt32(hPtr, true),
      format: view.getInt32(fPtr, true),
    }
  } finally {
    m._free(ddsPtr); m._free(wPtr); m._free(hPtr); m._free(fPtr)
  }
}

/**
 * Decode the base mip level of a DDS file to RGBA8.
 * Throws with a user-visible message on error.
 */
export async function decodeDds(ddsBytes: Uint8Array): Promise<DecodeDdsResult> {
  const { width, height, format } = await getDdsInfo(ddsBytes)
  if (format < 0) throw ddsErrorFromCode(-2, format)  // re-throws unsupported format
  const m      = await getPixelOps()
  const ddsPtr = m._malloc(ddsBytes.byteLength)
  const rgbPtr = m._malloc(width * height * 4)
  try {
    m.HEAPU8.set(ddsBytes, ddsPtr)
    const rc = m._pixelops_dds_decode(ddsPtr, ddsBytes.byteLength, rgbPtr, width, height)
    if (rc !== 0) throw ddsErrorFromCode(rc, format)
    // Re-read HEAPU8 in case WASM memory grew during decode
    const data = m.HEAPU8.slice(rgbPtr, rgbPtr + width * height * 4)
    return { data, width, height }
  } finally {
    m._free(ddsPtr); m._free(rgbPtr)
  }
}

/**
 * Encode RGBA8 to a DDS file.
 * NOTE: This is called from ddsWorker.ts on a worker thread, not the main thread.
 */
export async function encodeDds(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: EncodeDdsOptions
): Promise<Uint8Array> {
  const m = await getPixelOps()
  const outSize = m._pixelops_dds_get_encoded_size(
    width, height, options.format, options.mipmapLevels, options.headerMode
  )
  return withSrcDstBuffers(m, rgba, outSize, (src, dst) =>
    m._pixelops_dds_encode(
      src, width, height,
      options.format, options.mipmapLevels, options.headerMode,
      dst
    )
  )
}
```

Add a private helper `ddsErrorFromCode(rc: number, formatCode: number): Error` that maps DDS_ERR_*
codes to the user-visible error messages specified in the spec (cubemap, volume texture, array
texture, corrupt file, unsupported format, decode failed). For `DDS_ERR_UNSUPPORTED_FORMAT`,
include the format code in the message text.

### Step 7 — Add `src/core/io/ddsWorker.ts`

```ts
import { encodeDds, type EncodeDdsOptions } from '@/wasm/index'

self.onmessage = async (e: MessageEvent<{
  rgba:    ArrayBuffer
  width:   number
  height:  number
  options: EncodeDdsOptions
}>): Promise<void> => {
  const { rgba, width, height, options } = e.data
  try {
    const ddsBytes = await encodeDds(
      new Uint8Array(rgba), width, height, options
    )
    self.postMessage({ type: 'done', ddsBytes: ddsBytes.buffer }, [ddsBytes.buffer])
  } catch (err) {
    self.postMessage({ type: 'error', message: (err as Error).message })
  }
}
```

### Step 8 — Add `src/core/io/exportDds.ts`

```ts
import type { DdsExportOptions } from '@/wasm/index'

export type { DdsExportOptions }

/**
 * Encode RGBA8 pixel data to a DDS file in a Web Worker.
 * The returned Promise resolves with the raw DDS bytes.
 * If `signal` fires before completion, the worker is terminated and the
 * Promise rejects with a DOMException named 'AbortError'.
 */
export function exportDds(
  rgba:    Uint8Array,
  width:   number,
  height:  number,
  options: DdsExportOptions,
  signal?: AbortSignal
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./ddsWorker', import.meta.url),
      { type: 'module' }
    )

    const cleanup = (): void => {
      worker.terminate()
      signal?.removeEventListener('abort', onAbort)
    }

    const onAbort = (): void => {
      cleanup()
      reject(new DOMException('DDS compression cancelled.', 'AbortError'))
    }

    worker.onmessage = (e: MessageEvent<{ type: string; ddsBytes?: ArrayBuffer; message?: string }>) => {
      cleanup()
      if (e.data.type === 'done' && e.data.ddsBytes) {
        resolve(new Uint8Array(e.data.ddsBytes))
      } else {
        reject(new Error(e.data.message ?? 'DDS encode failed'))
      }
    }

    worker.onerror = (err) => {
      cleanup()
      reject(new Error(err.message))
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    // Transfer the ArrayBuffer into the worker — zero-copy.
    const buf = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength) as ArrayBuffer
    worker.postMessage({ rgba: buf, width, height, options }, [buf])
  })
}
```

### Step 9 — Update `src/core/io/imageLoader.ts`

1. Add `.dds` to `IMAGE_EXTENSIONS`:
   ```ts
   export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tga', '.tif', '.tiff', '.dds'])
   ```

2. Add `.dds` to `EXT_TO_MIME`:
   ```ts
   '.dds': 'image/dds',
   ```
   (`image/dds` is used only as an internal identifier; no browser API interprets it.)

3. Add a DDS decode branch at the top of `loadImagePixels`, before the TGA branch:
   ```ts
   if (dataUrl.startsWith('data:image/dds;base64,')) {
     const base64 = dataUrl.slice('data:image/dds;base64,'.length)
     const binary = atob(base64)
     const bytes  = new Uint8Array(binary.length)
     for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
     const { decodeDds } = await import('@/wasm/index')
     return decodeDds(bytes)  // throws with user-visible message on error
   }
   ```
   The dynamic import keeps `@/wasm` out of the initial bundle. The `loadImagePixels` function
   already returns `Promise<...>`, so the `await import()` is valid here.

The thrown errors from `decodeDds` propagate up through `openFromPath` in `useFileOps.ts` to the
existing `showOperationError` error handler — no changes to `useFileOps.ts` are required.

### Step 10 — Update `src/ux/modals/ExportDialog/ExportDialog.tsx`

**Type changes:**

```ts
export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'tga' | 'tiff' | 'dds'

export interface DdsOptions {
  compression: DdsCompression         // see enum below
  mipMaps:     'base-only' | 'full-chain'
  header:      'dx9' | 'dx10'
}

// Maps directly to DdsFormat in src/wasm/index.ts; defined here to avoid
// importing WASM types into the UI layer.
export type DdsCompression =
  | 'rgba8'
  | 'bc1-no-alpha'
  | 'bc1-alpha'
  | 'bc2'
  | 'bc3'
  | 'bc4'
  | 'bc5'
  | 'bc6h'
  | 'bc7'

export interface ExportSettings {
  filePath:        string
  format:          ExportFormat
  jpegQuality:     number
  jpegBackground:  string
  webpQuality:     number
  ddsOptions:      DdsOptions
}
```

**Default DDS options state:**

```ts
const [ddsCompression, setDdsCompression] = useState<DdsCompression>('bc3')
const [ddsMipMaps, setDdsMipMaps]         = useState<'base-only' | 'full-chain'>('base-only')
const [ddsHeader, setDdsHeader]           = useState<'dx9' | 'dx10'>('dx10')
```

Reset these alongside other fields in the `useEffect` on `open`.

**`applyExtension` update:**

Add `format === 'dds' ? '.dds' :` to the extension chain.

**`onConfirm` signature change:**

```ts
export interface ExportDialogProps {
  open:      boolean
  canvasWidth:  number    // new — needed to evaluate isPow2 for mip UI
  canvasHeight: number    // new — needed to evaluate isPow2 for mip UI
  onConfirm: (settings: ExportSettings, signal: AbortSignal) => Promise<void>
  onCancel:  () => void
}
```

`canvasWidth` and `canvasHeight` are read at dialog-open time to determine whether mip chain
generation is available. Passing them as props keeps the dialog stateless with respect to canvas
dimensions.

**In-progress state:**

```ts
const [isExporting, setIsExporting]     = useState(false)
const [exportError, setExportError]     = useState<string | null>(null)
const abortControllerRef                = useRef<AbortController | null>(null)
```

**Async `handleExport`:**

```ts
const handleExport = useCallback(async (): Promise<void> => {
  if (!filePath.trim() || isExporting) return
  const controller = new AbortController()
  abortControllerRef.current = controller
  setIsExporting(true)
  setExportError(null)
  try {
    await onConfirm(buildSettings(), controller.signal)
    // onConfirm closes the dialog on success by calling onCancel/onClose from the parent.
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') {
      setIsExporting(false)
      return
    }
    setExportError((err as Error).message ?? 'Export failed.')
    setIsExporting(false)
  }
}, [filePath, isExporting, onConfirm, /* dds fields */])

const handleCancelExport = useCallback((): void => {
  abortControllerRef.current?.abort()
}, [])
```

`buildSettings()` collects all current state into an `ExportSettings` object.

**DDS options section** (rendered when `format === 'dds'`):

```tsx
{format === 'dds' && (
  <>
    <p className={styles.sectionTitle}>DDS OPTIONS</p>

    {/* Compression */}
    <div className={styles.fieldRow}>
      <label className={styles.fieldLabel} htmlFor="ex-dds-compression">Compression</label>
      <select id="ex-dds-compression" className={styles.select}
              value={ddsCompression}
              onChange={(e) => {
                const v = e.target.value as DdsCompression
                setDdsCompression(v)
                if (v === 'bc6h' || v === 'bc7') setDdsHeader('dx10')
              }}>
        <option value="rgba8">Uncompressed (RGBA8)</option>
        <option value="bc1-no-alpha">BC1 — No Alpha</option>
        <option value="bc1-alpha">BC1 — 1-bit Alpha</option>
        <option value="bc2">BC2</option>
        <option value="bc3">BC3 — Full Alpha</option>
        <option value="bc4">BC4 — Single Channel</option>
        <option value="bc5">BC5 — Dual Channel</option>
        <option value="bc6h">BC6H — HDR Float</option>
        <option value="bc7">BC7 — High Quality</option>
      </select>
    </div>

    {/* Mip Maps */}
    <div className={styles.fieldRow}>
      <label className={styles.fieldLabel} htmlFor="ex-dds-mipmaps">Mip Maps</label>
      <select id="ex-dds-mipmaps" className={styles.select}
              value={ddsMipMaps}
              disabled={!isPow2}
              onChange={(e) => setDdsMipMaps(e.target.value as 'base-only' | 'full-chain')}>
        <option value="base-only">Base level only</option>
        <option value="full-chain" disabled={!isPow2}>Generate full mip chain</option>
      </select>
      {!isPow2 && (
        <span className={styles.inlineNote}>Mip chains require power-of-two dimensions.</span>
      )}
    </div>

    {/* Header */}
    <div className={styles.fieldRow}>
      <label className={styles.fieldLabel} htmlFor="ex-dds-header">Header</label>
      <select id="ex-dds-header" className={styles.select}
              value={ddsHeader}
              disabled={forceDx10}
              onChange={(e) => setDdsHeader(e.target.value as 'dx9' | 'dx10')}>
        <option value="dx10">Modern (DX10 header)</option>
        <option value="dx9">Backward Compatible (DX9 header)</option>
      </select>
      {forceDx10 && (
        <span className={styles.inlineNote}>BC6H and BC7 require the DX10 header extension.</span>
      )}
    </div>
  </>
)}
```

Local derived values used in the section above:

```ts
const isPow2    = Number.isInteger(Math.log2(canvasWidth))  && Number.isInteger(Math.log2(canvasHeight))
const forceDx10 = ddsCompression === 'bc6h' || ddsCompression === 'bc7'
```

**Format selector** — add `<option value="dds">DDS</option>` after `<option value="tiff">`.

**Footer** — when `isExporting`, replace the Export button with a spinner/disabled state and show
a Cancel button:

```tsx
<div className={styles.footer}>
  {isExporting ? (
    <>
      <DialogButton onClick={handleCancelExport}>Cancel</DialogButton>
      <DialogButton primary disabled>Exporting…</DialogButton>
    </>
  ) : (
    <>
      <DialogButton onClick={onCancel}>Cancel</DialogButton>
      <DialogButton onClick={handleExport} primary disabled={!canExport}>Export</DialogButton>
    </>
  )}
  {exportError && <p className={styles.errorNote}>{exportError}</p>}
</div>
```

Add `.errorNote` and `.inlineNote` to `ExportDialog.module.scss` (small, danger-coloured / muted
text aligned with the field rows).

**`handleConfirm` → `handleExport`:** Rename the existing `handleConfirm` to `handleExport` and
make it the async function described above. Update the `Enter` keyboard handler accordingly.

### Step 11 — Update `src/core/services/useExportOps.ts`

1. Import `exportDds` from `@/core/io/exportDds` and `DdsFormat`/`DdsHeaderMode` from `@/wasm`.
2. Change `handleExportConfirm` to accept an `AbortSignal`:
   ```ts
   handleExportConfirm: (settings: ExportSettings, signal: AbortSignal) => Promise<void>
   ```
3. Add the DDS branch before the else-clause:
   ```ts
   if (settings.format === 'dds') {
     const { ddsOptions } = settings
     const formatCode    = ddsCompressionToEnum(ddsOptions.compression)
     const mipmapLevels  = ddsOptions.mipMaps === 'full-chain'
       ? computeMipLevels(width, height)
       : 1
     const headerMode    = ddsOptions.header === 'dx10' ? DdsHeaderMode.DX10 : DdsHeaderMode.DX9
     const ddsBytes = await exportDds(data, width, height,
       { format: formatCode, mipmapLevels, headerMode }, signal)
     await window.api.exportImage(
       settings.filePath,
       bytesToBase64(ddsBytes)
     )
     return
   }
   ```
4. Add a private `ddsCompressionToEnum` mapping from `DdsCompression` string literals to
   `DdsFormat` enum values.
5. Add a private `computeMipLevels(w, h)` that returns `Math.floor(Math.log2(Math.max(w, h))) + 1`.
6. Add a private `bytesToBase64(bytes: Uint8Array): string` that chunks the array with the same
   approach used in `exportTga.ts` to avoid call-stack overflows.

The existing `onConfirm` caller in `App.tsx` (or wherever `useExportOps` is wired) must be updated
to match the new async signature. The call site changes from:

```ts
onConfirm={handleExportConfirm}
```

to:

```ts
onConfirm={handleExportConfirm}
```

No change to the prop name — the signature change is transparent to the call site because the
dialog now manages the `AbortController` and passes the signal internally.

### Step 12 — Update `electron/main/ipc.ts`

1. Add `'dds'` to the `dialog:openFile` and `dialog:openverve` extension lists:
   ```ts
   // dialog:openFile:
   { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tga', 'tif', 'tiff', 'dds'] }
   
   // dialog:openverve — add 'dds' to both the 'All Supported' and 'Images' filter entries
   ```

2. Add `'dds'` to `dialog:openverve`'s "All Supported" and "Images" filter entries. Also add a
   dedicated DDS entry per the spec:
   ```ts
   { name: 'DirectDraw Surface (*.dds)', extensions: ['dds'] }
   ```

3. Handle the `'dds'` case in `dialog:exportBrowse`:
   ```ts
   ext === 'dds'  ? [{ name: 'DirectDraw Surface', extensions: ['dds'] }] :
   ```

---

## Architectural Constraints

- **WASM memory rules.** Re-read `m.HEAPU8` after any call that may grow memory (i.e. after
  `_pixelops_dds_decode` on large BC6H/BC7 inputs). `withSrcDstBuffers` already does this for the
  encode path. For the decode path, call `m.HEAPU8.slice(...)` **after** the decode call, not
  before (see Step 6).
- **Generated files are gitignored.** `src/wasm/generated/` is not committed. After any change to
  `wasm/`, run `npm run build:wasm` before testing.
- **No direct import from `src/wasm/generated/`.** All WASM access must go through
  `src/wasm/index.ts`.
- **CSS Modules.** All new style rules go in `.module.scss` files. The `exportError` and
  `inlineNote` classes are added to the existing `ExportDialog.module.scss`.
- **Unified rasterization pipeline.** The DDS export uses `handle.rasterizeLayers(...)` from
  `useExportOps` — the same flatten path as all other formats. No separate compositing path is
  introduced.
- **No raw DOM listeners.** The Cancel button in `ExportDialog` calls `handleCancelExport` via a
  React `onClick` handler, not a raw DOM listener.
- **No business logic in `App.tsx`.** The DDS export logic (format mapping, mip level computation,
  base64 encoding) lives in `useExportOps.ts`, not in `App.tsx`.
- **Component folder convention.** The DDS options section is rendered inline within
  `ExportDialog.tsx`, consistent with how JPEG and WebP options are rendered. No new component
  folder is created.

---

## Open Questions

1. **bcdec BC6H decode output format.** Confirm whether bcdec's `bcdec_bc6h_half` function returns
   values as packed `uint16_t` (half-float) or as `float`. The half-to-float conversion in
   `dds.cpp` must handle whichever format bcdec uses at the version vendored. Check the bcdec
   README at the time of vendoring.

2. **bc7enc_rdo build flags under Emscripten.** bc7enc_rdo uses SIMD intrinsics for performance on
   native. Under Emscripten with WASM SIMD (`-msimd128`) these may compile, but need to be
   validated. If SIMD compilation fails, bc7enc_rdo must be built with `BC7ENC_USE_SSE2=0` and
   `BC7ENC_USE_SSE41=0` preprocessor flags. Document the required flags in a comment at the top of
   `wasm/src/dds.cpp`.

3. **Worker WASM asset resolution in Electron.** Vite resolves `./generated/pixelops.wasm?url` to
   a `file://` path in the Electron renderer. Verify that this same path resolves correctly inside
   the spawned Worker. If not, pass the resolved WASM URL from the main thread to the worker as
   part of the initial `postMessage` payload, and expose it via the `locateFile` callback in
   `getPixelOps()`.

4. **Export dialog `canvasWidth`/`canvasHeight` props.** The dialog currently receives no canvas
   dimension information. Decide whether to thread these through `App.tsx` → `ExportDialog` as
   props (straightforward) or read them from a context. The design above chooses props for
   explicitness.

5. **BC7 encode quality vs. speed trade-off.** bc7enc_rdo exposes quality mode settings.
   Decide on a default quality level for the initial implementation. The spec does not prescribe a
   specific quality setting; a reasonable default is bc7enc's mode 6 with `uber_level = 2`
   (good quality, moderate speed). This decision can be deferred to the implementation phase.
