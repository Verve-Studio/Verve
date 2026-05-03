# Technical Design: DDS Format Support

## Overview

This feature adds first-class DirectDraw Surface (DDS) support to Verve. DDS files are opened via
the existing **File → Open** path, decoded from BCx-compressed or uncompressed formats in the
C++/WASM layer, and loaded onto the canvas as a new raster layer. The **Export As** dialog gains a
DDS option with three controls (compression format, mip maps, header variant). Export flattens the
document via the unified rasterization pipeline and compresses the resulting buffer to DDS in a
dedicated Web Worker (required to keep the UI responsive and support cancellation during potentially
multi-second BC7/BC6H compression). All BCx encode and decode work happens exclusively in the WASM
layer — no GPU-side BCx encoding is performed.

The design supports **both** of Verve's raster pixel formats:

| Document format | Import DDS | Export DDS |
|---|---|---|
| `rgba8` | Decode to `Uint8Array` (8-bit RGBA). BC6H is tone-mapped to 8-bit. | Encode from `Uint8Array`. All compression formats available. |
| `rgba32f` | BC6H / RGBA32F DDS → decode to `Float32Array` (native float range, HDR values preserved). Other formats → `Float32Array` in 0–1 range. | BC6H and RGBA32F → encode from `Float32Array`. LDR formats → tone-map to 8-bit first; ExportDialog warns the user that HDR detail will be clipped. |

`indexed8` documents are out of scope for DDS import/export. The export path already expands
indexed layers to RGBA8 via `rasterizeLayers`; the result is treated as an `rgba8` document for
DDS purposes.

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
| `wasm/src/pixelops.cpp` | Modify — add `extern "C"` wrappers for the six new DDS functions |
| `wasm/CMakeLists.txt` | Modify — add `dds.cpp` + `bc7enc.cpp`, vendor include dir, six new exported symbols |
| `src/wasm/types.ts` | Modify — add six DDS method signatures to `PixelOpsModule` |
| `src/wasm/index.ts` | Modify — add `DdsFormat`/`DdsHeaderMode` enums, `getDdsInfo()`, `decodeDds()`, `decodeDdsF32()`, `encodeDds()`, `encodeDdsF32()` wrappers |
| `src/core/io/imageLoader.ts` | Modify — add `.dds` to `IMAGE_EXTENSIONS`/`EXT_TO_MIME`; add DDS decode branch that routes to `decodeDds` or `decodeDdsF32` based on the detected format |
| `src/core/io/ddsWorker.ts` | New — Vite Web Worker module; calls WASM encode on behalf of the export service; handles both `Uint8Array` (rgba8) and `Float32Array` (rgba32f) input |
| `src/core/io/exportDds.ts` | New — main-thread helper; spawns/manages the DDS worker, returns `Promise<Uint8Array>` |
| `src/ux/modals/ExportDialog/ExportDialog.tsx` | Modify — add `'dds'` format, `DdsOptions` interface, in-progress/cancel state, HDR-clipping warning |
| `src/core/services/useExportOps.ts` | Modify — handle `'dds'` format branch; route `Float32Array` (rgba32f) or `Uint8Array` (rgba8) to the appropriate encode path |
| `electron/main/ipc.ts` | Modify — add `.dds` to open-file filters; add `'dds'` case to `exportBrowse` handler |

---

## State Changes

No new fields are required in `AppState` or `AppContext`. DDS import produces a normal raster layer
via the existing `SWITCH_TAB` / `OPEN_FILE` path. The pixel format of the new document is
determined by the decoded data type returned by `imageLoader`:

- If the DDS source is BC6H or RGBA32F, `imageLoader` returns `Float32Array` → the document opens
  in `rgba32f` mode.
- All other DDS formats return `Uint8Array` → the document opens in `rgba8` mode.

The export options (format, compression, mip maps, header) are local state inside `ExportDialog` —
they are not persisted to the document or to `AppState`.

Three interface changes are required in `ExportDialog.tsx`:

1. **`ExportFormat`** — add the `'dds'` literal.
2. **`ExportSettings`** — add a `ddsOptions: DdsOptions` field.
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
**Responsibility:** Spawn the DDS worker, transfer the pixel buffer, resolve with the encoded DDS
bytes `Uint8Array`, and terminate the worker on cancellation.

```ts
export interface DdsExportOptions {
  format:       DdsFormat          // see DdsFormat enum below
  mipmapLevels: number             // 1 = base only; computed mip count for full chain
  headerMode:   DdsHeaderMode      // DX9 | DX10
  inputFormat:  'rgba8' | 'rgba32f' // tells the worker which encode path to use
}

export function exportDds(
  pixels: Uint8Array | Float32Array,
  width:  number,
  height: number,
  options: DdsExportOptions,
  signal?: AbortSignal
): Promise<Uint8Array>
```

Internally:
- Creates `new Worker(new URL('./ddsWorker', import.meta.url), { type: 'module' })`.
- Transfers `pixels.buffer` via `postMessage` (zero-copy).
- Listens for `{ type: 'done', ddsBytes: ArrayBuffer }` or `{ type: 'error', message: string }`.
- If `signal` fires, calls `worker.terminate()` and rejects with `DOMException('AbortError')`.

### `src/core/io/ddsWorker.ts` — Web Worker module

**Category:** Worker script.  
**Responsibility:** Import the appropriate encode function from `@/wasm/index.ts`, process a single
encode request, post the result back.

Receives `{ pixels: ArrayBuffer, width, height, options }` and posts `{ type: 'done', ddsBytes }`
or `{ type: 'error', message }`. Routes to `encodeDds` (RGBA8 input) or `encodeDdsF32` (float32
input) based on `options.inputFormat`. Loads its own isolated instance of the WASM module (does not
share the main-thread singleton).

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
static constexpr int DDS_FMT_RGBA32F      = 9;   // DXGI_FORMAT_R32G32B32A32_FLOAT — uncompressed HDR

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
 * BC6H is tone-mapped to 8-bit via simple clamp: out = clamp(f16_to_f32(x) * 255, 0, 255).
 * RGBA32F channels are clamped to [0, 1] and scaled to [0, 255].
 * @return DDS_OK or a DDS_ERR_* code.
 */
int dds_decode(
    const uint8_t* ddsBytes, int ddsByteLength,
    uint8_t* rgbaOut, int width, int height
);

/**
 * Decode mip-0 of a DDS file to a caller-allocated float32 RGBA buffer.
 * Buffer must be at least width * height * 4 * sizeof(float) bytes.
 * HDR formats (BC6H, RGBA32F) preserve full float range including values > 1.0.
 * LDR formats (BC1–BC5, RGBA8) output values normalised to [0.0, 1.0].
 * @return DDS_OK or a DDS_ERR_* code.
 */
int dds_decode_f32(
    const uint8_t* ddsBytes, int ddsByteLength,
    float* rgbaF32Out, int width, int height
);

/**
 * Return the total byte size needed for the full encoded DDS file,
 * including header(s) and all mip levels.
 * For DDS_FMT_RGBA32F, each pixel is 16 bytes (4 × float32).
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

/**
 * Encode a float32 RGBA source to a DDS file.
 * Caller must pass DDS_FMT_BC6H_UF16 or DDS_FMT_RGBA32F; other formats return
 * DDS_ERR_INVALID_HEADER. For BC6H, float values are encoded via bc7enc's BC6H encoder.
 * For RGBA32F, values are stored as-is (DXGI_FORMAT_R32G32B32A32_FLOAT).
 * Always writes a DX10 header (the headerMode parameter is ignored; BC6H and RGBA32F
 * require the DX10 extension block).
 * @param ddsOut  Pre-allocated buffer of dds_get_encoded_size() bytes.
 * @return DDS_OK or a DDS_ERR_* code.
 */
int dds_encode_f32(
    const float* rgbaF32In, int width, int height,
    int format, int mipmapLevels,
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
| `DXGI_FORMAT_BC6H_SF16 (96)` | `DDS_FMT_BC6H_UF16` (sign bit stripped on `dds_decode`; sign preserved on `dds_decode_f32`) |
| `DXGI_FORMAT_BC7_UNORM (98)` | `DDS_FMT_BC7` |
| `D3DFMT_A8R8G8B8` / `DXGI_FORMAT_B8G8R8A8_UNORM (87)` | uncompressed BGRA8 → swap to RGBA8 |
| `DXGI_FORMAT_R8G8B8A8_UNORM (28)` | uncompressed RGBA8 (passthrough) |
| `DXGI_FORMAT_R32G32B32A32_FLOAT (2)` | `DDS_FMT_RGBA32F` |

**BC6H decode (`dds_decode` — 8-bit output path):**

bcdec decodes each pixel to three `float16` values. Convert to 8-bit using a simple clamp:
`out = (uint8_t)clamp(f16_to_f32(x) * 255.0f, 0.0f, 255.0f)`. Alpha is set to 255 (BC6H has no
alpha channel). The spec permits any tone-mapping strategy as long as the result is in 0–255.

**BC6H decode (`dds_decode_f32` — float32 output path):**

bcdec decodes each pixel to three `float16` values. Convert to full-precision float32:
`out = f16_to_f32(x)`. Values may exceed 1.0 (HDR). Alpha is set to 1.0f. The caller (TypeScript
layer) is responsible for downstream tone-mapping or HDR display.

**RGBA32F decode (`dds_decode_f32`):**

Read pixel data directly as a `float` array. Byte-swap only if the platform is big-endian
(Emscripten targets little-endian x86/ARM, so no swap is needed in practice). Copy the float
values verbatim to `rgbaF32Out`.

**RGBA32F decode (`dds_decode` — 8-bit fallback):**

Clamp each channel to [0.0f, 1.0f] and scale to [0, 255]: `out = (uint8_t)clamp(f * 255.0f, 0.0f, 255.0f)`.

**Pixel data offset:**
`pixelDataOffset = 4 /* magic */ + 124 /* DX9 header */ + (isDX10 ? 20 : 0)`.

**Block sizes:**
- BC1, BC4: 8 bytes per 4×4 block.
- BC2, BC3, BC5, BC6H, BC7: 16 bytes per 4×4 block.
- Number of blocks per dimension: `ceil(width / 4)` × `ceil(height / 4)`.

**Mip chain generation in `dds_encode`:**

For `mipmapLevels > 1`, generate mip levels from the base RGBA using a box filter (average 2×2
pixel quads). Encode each mip level independently. Write all levels contiguously after the header,
mip 0 first. The same approach applies for `dds_encode_f32` with BC6H — box-filter in float32
before encoding each mip.

**`dds_get_encoded_size` formula:**

```
headerBytes = 4 + 124 + (headerMode == DX10 ? 20 : 0)
pixelBytes  = 0
for level in 0 ..< mipmapLevels:
    w = max(1, width  >> level)
    h = max(1, height >> level)
    if format == RGBA8:
        pixelBytes += w * h * 4
    elif format == RGBA32F:
        pixelBytes += w * h * 16       // 4 channels × 4 bytes per float
    else:
        bw = (w + 3) / 4
        bh = (h + 3) / 4
        pixelBytes += bw * bh * blockSize(format)
return headerBytes + pixelBytes
```

Note: `dds_encode_f32` always writes a DX10 header, so `headerMode` has no effect; the
`dds_get_encoded_size` call from the TypeScript side must pass `DDS_HEADER_DX10` for BC6H/RGBA32F
formats to get a correct size.

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

DX10 extension block (20 bytes at byte 128, written when `headerMode == DX10` or when called from
`dds_encode_f32`):
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
RGBA32F   → 2    (DXGI_FORMAT_R32G32B32A32_FLOAT)
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

BC6H, BC7, and RGBA32F cannot be written with a DX9 header; the TypeScript caller must always pass
`DDS_HEADER_DX10` for these formats (enforced by the UI; the C++ layer returns
`DDS_ERR_INVALID_HEADER` if DX9 is supplied with BC6H/BC7/RGBA32F).

### Step 3 — Update `wasm/src/pixelops.cpp`

Add `#include "dds.h"` at the top. Add six `extern "C" EMSCRIPTEN_KEEPALIVE` wrappers inside the
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
int pixelops_dds_decode_f32(
    const uint8_t* ddsBytes, int ddsByteLength,
    float* rgbaF32Out, int width, int height
) {
    return dds_decode_f32(ddsBytes, ddsByteLength, rgbaF32Out, width, height);
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

EMSCRIPTEN_KEEPALIVE
int pixelops_dds_encode_f32(
    const float* rgbaF32In, int width, int height,
    int format, int mipmapLevels,
    uint8_t* ddsOut
) {
    return dds_encode_f32(rgbaF32In, width, height, format, mipmapLevels, ddsOut);
}
```

The three int output-pointer parameters in `dds_get_info` (`widthOut`, `heightOut`, `formatOut`)
need caller-allocated slots. The TypeScript wrapper allocates three 4-byte WASM heap slots, passes
their pointers, then reads the values back with `DataView` (see Step 5).

### Step 4 — Update `wasm/CMakeLists.txt`

1. Add `src/dds.cpp` and `src/vendor/bc7enc.cpp` to `add_executable(pixelops ...)`.
2. Add `target_include_directories(pixelops PRIVATE src src/vendor)`.
3. Disable bc7enc_rdo's x86-specific SIMD paths. bc7enc_rdo conditionally includes `<immintrin.h>` SSE2/SSE4.1 code, which is not portable across host architectures (x86 vs. ARM). These paths must be disabled unconditionally so the scalar C++ fallback is used:
   ```cmake
   target_compile_definitions(pixelops PRIVATE
     BC7ENC_USE_SSE2=0
     BC7ENC_USE_SSE41=0
   )
   ```
   WASM SIMD (`-msimd128`) is a separate, portable ISA and may be enabled in the future if bc7enc_rdo gains portable WASM SIMD paths. For now it is not used.
4. Append the six new function names to `-sEXPORTED_FUNCTIONS`:
   `_pixelops_dds_get_info`, `_pixelops_dds_decode`, `_pixelops_dds_decode_f32`,
   `_pixelops_dds_get_encoded_size`, `_pixelops_dds_encode`, `_pixelops_dds_encode_f32`.

### Step 5 — Update `src/wasm/types.ts`

Add the six DDS method signatures to the `PixelOpsModule` interface:

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
 * BC6H and RGBA32F channels are clamped and scaled to 0–255.
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
 * Decode mip-0 to float32 RGBA into a pre-allocated output buffer (width * height * 16 bytes).
 * HDR formats preserve values > 1.0. LDR formats output values in [0.0, 1.0].
 * Returns 0 on success or a negative DDS_ERR_* code.
 */
_pixelops_dds_decode_f32(
  ddsBytesPtr: number,
  ddsByteLength: number,
  rgbaF32OutPtr: number,
  width: number,
  height: number
): number

/**
 * Returns the total byte size of the DDS file that encode will produce.
 * For RGBA32F/BC6H formats, pass DDS_HEADER_DX10 (1) as headerMode.
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

/**
 * Encode float32 RGBA to DDS (BC6H_UF16 or RGBA32F only).
 * Always writes a DX10 header. Returns 0 on success or a negative DDS_ERR_* code.
 */
_pixelops_dds_encode_f32(
  rgbaF32InPtr: number,
  width: number,
  height: number,
  format: number,
  mipmapLevels: number,
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
  UncompressedRGBA32F = 9,   // DXGI_FORMAT_R32G32B32A32_FLOAT — lossless HDR DDS
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

export interface DecodeDdsF32Result {
  data:   Float32Array
  width:  number
  height: number
  isHdr:  boolean    // true when source was BC6H or RGBA32F
}

export interface EncodeDdsOptions {
  format:       DdsFormat
  mipmapLevels: number        // 1 = base only
  headerMode:   DdsHeaderMode
}
```

Add the `getDdsInfo`, `decodeDds`, `decodeDdsF32`, `encodeDds`, and `encodeDdsF32` wrapper
functions:

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
 * BC6H and RGBA32F channels are tone-mapped (clamped + scaled) to 0–255.
 * Throws with a user-visible message on error.
 */
export async function decodeDds(ddsBytes: Uint8Array): Promise<DecodeDdsResult> {
  const { width, height, format } = await getDdsInfo(ddsBytes)
  if (format < 0) throw ddsErrorFromCode(-2, format)
  const m      = await getPixelOps()
  const ddsPtr = m._malloc(ddsBytes.byteLength)
  const rgbPtr = m._malloc(width * height * 4)
  try {
    m.HEAPU8.set(ddsBytes, ddsPtr)
    const rc = m._pixelops_dds_decode(ddsPtr, ddsBytes.byteLength, rgbPtr, width, height)
    if (rc !== 0) throw ddsErrorFromCode(rc, format)
    // Re-read HEAPU8 after decode in case WASM memory grew
    const data = m.HEAPU8.slice(rgbPtr, rgbPtr + width * height * 4)
    return { data, width, height }
  } finally {
    m._free(ddsPtr); m._free(rgbPtr)
  }
}

/**
 * Decode the base mip level of a DDS file to float32 RGBA.
 * HDR sources (BC6H, RGBA32F) preserve values > 1.0. LDR sources output [0.0, 1.0].
 * Throws with a user-visible message on error.
 */
export async function decodeDdsF32(ddsBytes: Uint8Array): Promise<DecodeDdsF32Result> {
  const { width, height, format } = await getDdsInfo(ddsBytes)
  if (format < 0) throw ddsErrorFromCode(-2, format)
  const isHdr = format === DdsFormat.BC6H_UF16 || format === DdsFormat.UncompressedRGBA32F
  const m      = await getPixelOps()
  const ddsPtr = m._malloc(ddsBytes.byteLength)
  const f32Ptr = m._malloc(width * height * 16)   // 4 floats × 4 bytes each
  try {
    m.HEAPU8.set(ddsBytes, ddsPtr)
    const rc = m._pixelops_dds_decode_f32(ddsPtr, ddsBytes.byteLength, f32Ptr, width, height)
    if (rc !== 0) throw ddsErrorFromCode(rc, format)
    // Re-read HEAPU8 after decode in case WASM memory grew
    const rawBytes = m.HEAPU8.slice(f32Ptr, f32Ptr + width * height * 16)
    const data = new Float32Array(rawBytes.buffer)
    return { data, width, height, isHdr }
  } finally {
    m._free(ddsPtr); m._free(f32Ptr)
  }
}

/**
 * Encode RGBA8 pixel data to a DDS file.
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

/**
 * Encode float32 RGBA pixel data to a DDS file (BC6H_UF16 or RGBA32F only).
 * Always writes a DX10 header.
 * NOTE: This is called from ddsWorker.ts on a worker thread, not the main thread.
 */
export async function encodeDdsF32(
  rgbaF32: Float32Array,
  width: number,
  height: number,
  options: Pick<EncodeDdsOptions, 'format' | 'mipmapLevels'>
): Promise<Uint8Array> {
  const m = await getPixelOps()
  const outSize = m._pixelops_dds_get_encoded_size(
    width, height, options.format, options.mipmapLevels, DdsHeaderMode.DX10
  )
  // withSrcDstBuffers works with any TypedArray whose buffer/byteOffset/byteLength are set;
  // treat the Float32Array backing bytes as a Uint8Array view for the copy.
  const rgbaBytes = new Uint8Array(rgbaF32.buffer, rgbaF32.byteOffset, rgbaF32.byteLength)
  return withSrcDstBuffers(m, rgbaBytes, outSize, (src, dst) =>
    m._pixelops_dds_encode_f32(
      src, width, height,
      options.format, options.mipmapLevels,
      dst
    )
  )
}
```

Add a private helper `ddsErrorFromCode(rc: number, formatCode: number): Error` that maps DDS_ERR_*
codes to user-visible error messages (cubemap, volume texture, array texture, corrupt file,
unsupported format, decode/encode failed). For `DDS_ERR_UNSUPPORTED_FORMAT`, include the format
code in the message text.

### Step 7 — Add `src/core/io/ddsWorker.ts`

```ts
import { encodeDds, encodeDdsF32, type EncodeDdsOptions } from '@/wasm/index'

interface WorkerRequest {
  pixels:  ArrayBuffer
  width:   number
  height:  number
  options: EncodeDdsOptions & { inputFormat: 'rgba8' | 'rgba32f' }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>): Promise<void> => {
  const { pixels, width, height, options } = e.data
  try {
    let ddsBytes: Uint8Array
    if (options.inputFormat === 'rgba32f') {
      ddsBytes = await encodeDdsF32(
        new Float32Array(pixels), width, height,
        { format: options.format, mipmapLevels: options.mipmapLevels }
      )
    } else {
      ddsBytes = await encodeDds(
        new Uint8Array(pixels), width, height, options
      )
    }
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
 * Encode pixel data to a DDS file in a Web Worker.
 * Accepts either RGBA8 (Uint8Array) or float32 RGBA (Float32Array) input.
 * The returned Promise resolves with the raw DDS bytes.
 * If `signal` fires before completion, the worker is terminated and the
 * Promise rejects with a DOMException named 'AbortError'.
 */
export function exportDds(
  pixels:  Uint8Array | Float32Array,
  width:   number,
  height:  number,
  options: DdsExportOptions & { inputFormat: 'rgba8' | 'rgba32f' },
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
    const buf = pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength) as ArrayBuffer
    worker.postMessage({ pixels: buf, width, height, options }, [buf])
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

3. Add a DDS decode branch at the top of `loadImagePixels`, before the TGA branch. Inspect the
   file header first (`getDdsInfo`) to choose the right decode path — HDR sources decode to
   `Float32Array` so the document opens in `rgba32f` mode; LDR sources decode to `Uint8Array`:

   ```ts
   if (dataUrl.startsWith('data:image/dds;base64,')) {
     const base64 = dataUrl.slice('data:image/dds;base64,'.length)
     const binary = atob(base64)
     const bytes  = new Uint8Array(binary.length)
     for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

     const { getDdsInfo, decodeDds, decodeDdsF32, DdsFormat } = await import('@/wasm/index')
     const info = await getDdsInfo(bytes)
     const isHdrSource =
       info.format === DdsFormat.BC6H_UF16 ||
       info.format === DdsFormat.UncompressedRGBA32F

     if (isHdrSource) {
       return decodeDdsF32(bytes)  // returns { data: Float32Array, width, height, isHdr: true }
     } else {
       return decodeDds(bytes)     // returns { data: Uint8Array, width, height }
     }
   }
   ```

   The dynamic import keeps `@/wasm` out of the initial bundle. The `loadImagePixels` function
   already returns `Promise<...>`, so the `await import()` is valid here.

   The return type of `loadImagePixels` must be updated to allow `Float32Array` for the `data`
   field (it already does so for EXR/HDR imports, so this is likely already `Uint8Array | Float32Array`).

The thrown errors from `decodeDds` / `decodeDdsF32` propagate up through `openFromPath` in
`useFileOps.ts` to the existing `showOperationError` error handler — no changes to `useFileOps.ts`
are required.

### Step 10 — Update `src/ux/modals/ExportDialog/ExportDialog.tsx`

**Type changes:**

```ts
export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'tga' | 'tiff' | 'exr' | 'hdr' | 'tiff32' | 'dds'

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
  | 'rgba32f'

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
const [ddsCompression, setDdsCompression] = useState<DdsCompression>(
  isHdrDocument ? 'bc6h' : 'bc3'    // default to a sensible format for the document type
)
const [ddsMipMaps, setDdsMipMaps]         = useState<'base-only' | 'full-chain'>('base-only')
const [ddsHeader, setDdsHeader]           = useState<'dx9' | 'dx10'>('dx10')
```

Reset these alongside other fields in the `useEffect` on `open`.

**`applyExtension` update:**

Add `format === 'dds' ? '.dds' :` to the extension chain.

**`onConfirm` signature change:**

```ts
export interface ExportDialogProps {
  open:            boolean
  isHdrDocument?:  boolean
  canvasWidth:     number    // needed to evaluate isPow2 for mip chain UI
  canvasHeight:    number    // needed to evaluate isPow2 for mip chain UI
  onConfirm:       (settings: ExportSettings, signal: AbortSignal) => Promise<void>
  onCancel:        () => void
}
```

`canvasWidth` and `canvasHeight` are read at dialog-open time to determine whether mip chain
generation is available. The `isHdrDocument` prop already exists in the current component and is
reused for DDS compression defaults and the LDR-clipping warning.

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
                if (v === 'bc6h' || v === 'bc7' || v === 'rgba32f') setDdsHeader('dx10')
              }}>
        {/* HDR-native formats — listed first when isHdrDocument */}
        {isHdrDocument && <optgroup label="HDR Formats (float precision preserved)">
          <option value="bc6h">BC6H — HDR Float (compressed)</option>
          <option value="rgba32f">RGBA32F — Uncompressed HDR</option>
        </optgroup>}
        <optgroup label={isHdrDocument ? 'LDR Formats (HDR values clipped)' : 'Compression'}>
          <option value="rgba8">Uncompressed RGBA8</option>
          <option value="bc1-no-alpha">BC1 — No Alpha</option>
          <option value="bc1-alpha">BC1 — 1-bit Alpha</option>
          <option value="bc2">BC2</option>
          <option value="bc3">BC3 — Full Alpha</option>
          <option value="bc4">BC4 — Single Channel</option>
          <option value="bc5">BC5 — Dual Channel</option>
          <option value="bc7">BC7 — High Quality</option>
        </optgroup>
        {!isHdrDocument && <>
          <option value="bc6h">BC6H — HDR Float</option>
          <option value="rgba32f">RGBA32F — Uncompressed HDR</option>
        </>}
      </select>
      {isHdrDocument && isLdrCompression && (
        <span className={styles.warningNote}>
          HDR values above 1.0 will be clipped. Use BC6H or RGBA32F to preserve HDR detail.
        </span>
      )}
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
        <span className={styles.inlineNote}>BC6H, BC7, and RGBA32F require the DX10 header.</span>
      )}
    </div>
  </>
)}
```

Local derived values used in the section above:

```ts
const isPow2         = Number.isInteger(Math.log2(canvasWidth)) && Number.isInteger(Math.log2(canvasHeight))
const forceDx10      = ddsCompression === 'bc6h' || ddsCompression === 'bc7' || ddsCompression === 'rgba32f'
const isLdrCompression = ddsCompression !== 'bc6h' && ddsCompression !== 'rgba32f'
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

Add `.errorNote`, `.warningNote`, and `.inlineNote` to `ExportDialog.module.scss` (small, styled
text aligned with the field rows; `.warningNote` uses an amber/warning colour, `.errorNote` uses
red/danger).

**`handleConfirm` → `handleExport`:** Rename the existing `handleConfirm` to `handleExport` and
make it the async function described above. Update the `Enter` keyboard handler accordingly.

### Step 11 — Update `src/core/services/useExportOps.ts`

1. Import `exportDds` from `@/core/io/exportDds` and `DdsFormat`/`DdsHeaderMode` from `@/wasm`.
2. Change `handleExportConfirm` to accept an `AbortSignal`:
   ```ts
   handleExportConfirm: (settings: ExportSettings, signal: AbortSignal) => Promise<void>
   ```
3. The rasterization pipeline (`rasterizeLayers`) already returns `{ data: Uint8Array | Float32Array, width, height }`. The `isHdrDoc` flag (`stateRef.current.pixelFormat === 'rgba32f'`) is already used for other HDR export formats (EXR, HDR, TIFF32) and is reused here.

4. Add the DDS branch before the else-clause:

   ```ts
   if (settings.format === 'dds') {
     const { ddsOptions } = settings
     const isHdrDoc  = stateRef.current.pixelFormat === 'rgba32f'
     const formatCode = ddsCompressionToEnum(ddsOptions.compression)
     const mipmapLevels = ddsOptions.mipMaps === 'full-chain'
       ? computeMipLevels(width, height)
       : 1
     const headerMode = ddsOptions.header === 'dx10' ? DdsHeaderMode.DX10 : DdsHeaderMode.DX9

     // For HDR-native formats with an rgba32f document, pass Float32Array directly.
     // For LDR formats with an rgba32f document, clamp to 8-bit first.
     const isHdrFormat = formatCode === DdsFormat.BC6H_UF16 || formatCode === DdsFormat.UncompressedRGBA32F
     let pixels: Uint8Array | Float32Array
     let inputFormat: 'rgba8' | 'rgba32f'

     if (isHdrDoc && flat.data instanceof Float32Array) {
       if (isHdrFormat) {
         pixels = flat.data
         inputFormat = 'rgba32f'
       } else {
         // LDR format requested on HDR doc — tone-map (clamp) to RGBA8
         pixels = clampF32ToUint8(flat.data)
         inputFormat = 'rgba8'
       }
     } else {
       pixels = flat.data as Uint8Array
       inputFormat = 'rgba8'
     }

     const ddsBytes = await exportDds(pixels, width, height,
       { format: formatCode, mipmapLevels, headerMode, inputFormat }, signal)
     await window.api.exportImage(settings.filePath, bytesToBase64(ddsBytes))
     return
   }
   ```

5. Add a private `ddsCompressionToEnum` mapping from `DdsCompression` string literals to
   `DdsFormat` enum values.
6. Add a private `computeMipLevels(w, h)` that returns `Math.floor(Math.log2(Math.max(w, h))) + 1`.
7. Add a private `bytesToBase64(bytes: Uint8Array): string` that chunks the array with the same
   approach used in `exportTga.ts` to avoid call-stack overflows.
8. `clampF32ToUint8` is already imported from `@/utils/pixelFormatConvert` for the HDR export
   formats — reuse it here.

The existing `onConfirm` caller in `App.tsx` (or wherever `useExportOps` is wired) must be updated
to match the new async signature. The call site changes from:

```ts
onConfirm={handleExportConfirm}
```

to the same expression — no change to the prop name. The dialog now manages the `AbortController`
and passes the signal internally, so the call site is transparent to the signature change.

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
  `_pixelops_dds_decode` or `_pixelops_dds_decode_f32` on large BC6H/BC7 inputs).
  `withSrcDstBuffers` already handles this for the encode path. For the decode path, call
  `m.HEAPU8.slice(...)` **after** the decode call, not before (see Step 6).
- **Float32Array sizing.** The f32 decode output buffer must be `width * height * 16` bytes
  (4 channels × 4 bytes per float), not `width * height * 4`. Similarly for `dds_get_encoded_size`
  with `DDS_FMT_RGBA32F`.
- **Generated files are gitignored.** `src/wasm/generated/` is not committed. After any change to
  `wasm/`, run `npm run build:wasm` before testing.
- **No direct import from `src/wasm/generated/`.** All WASM access must go through
  `src/wasm/index.ts`.
- **CSS Modules.** All new style rules go in `.module.scss` files. The `exportError`,
  `warningNote`, and `inlineNote` classes are added to the existing `ExportDialog.module.scss`.
- **Unified rasterization pipeline.** The DDS export uses `rasterizeLayers(...)` from
  `useExportOps` — the same flatten path as all other formats. No separate compositing path is
  introduced.
- **`clampF32ToUint8` is already available.** `useExportOps.ts` already imports
  `clampF32ToUint8` from `@/utils/pixelFormatConvert` for EXR/HDR/TIFF32. Reuse it for DDS
  LDR exports of rgba32f documents.
- **No raw DOM listeners.** The Cancel button in `ExportDialog` calls `handleCancelExport` via a
  React `onClick` handler, not a raw DOM listener.
- **No business logic in `App.tsx`.** The DDS export logic (format mapping, mip level computation,
  HDR/LDR routing, base64 encoding) lives in `useExportOps.ts`, not in `App.tsx`.
- **Component folder convention.** The DDS options section is rendered inline within
  `ExportDialog.tsx`, consistent with how JPEG, WebP, and HDR options are rendered. No new
  component folder is created.
- **DX10 is mandatory for BC6H, BC7, and RGBA32F.** The UI enforces this by locking the header
  selector when one of these formats is chosen. The C++ layer additionally returns
  `DDS_ERR_INVALID_HEADER` as a safety guard.

---

## Open Questions

1. **bcdec BC6H decode output format.** Confirm whether bcdec's `bcdec_bc6h_half` function returns
   values as packed `uint16_t` (half-float) or as `float`. The half-to-float conversion in
   `dds.cpp` must handle whichever format bcdec uses at the version vendored. Check the bcdec
   README at the time of vendoring.

2. **bc7enc_rdo BC6H encoder input type.** Confirm whether bc7enc_rdo's BC6H encoder expects
   `float` or `uint16_t` (half-float) per channel. The `dds_encode_f32` implementation in
   `dds.cpp` must perform the necessary conversion. If `uint16_t` is required, a fast float-to-half
   helper (e.g. using the `__fp16` intrinsic under Emscripten, or a portable bit-manipulation
   version) must be included in `dds.cpp`.

3. ~~**bc7enc_rdo SIMD flags** — resolved.~~ bc7enc_rdo's x86 intrinsics (`BC7ENC_USE_SSE2`,
   `BC7ENC_USE_SSE41`) are disabled unconditionally via `target_compile_definitions` in
   `CMakeLists.txt` (see Step 4). The scalar C++ fallback is used. WASM SIMD (`-msimd128`) is a
   portable ISA distinct from x86 SSE/AVX or ARM NEON; it can be evaluated separately in the
   future if performance profiling shows it is worthwhile.

4. **Worker WASM asset resolution in Electron.** Vite resolves `./generated/pixelops.wasm?url` to
   a `file://` path in the Electron renderer. Verify that this same path resolves correctly inside
   the spawned Worker. If not, pass the resolved WASM URL from the main thread to the worker as
   part of the initial `postMessage` payload, and expose it via the `locateFile` callback in
   `getPixelOps()`.

5. **Export dialog `canvasWidth`/`canvasHeight` props.** These are not currently threaded to
   `ExportDialog`. The cleanest path is to add them as props passed from `App.tsx` →
   `MainWindow.tsx` → `ExportDialog`. An alternative is to read the current canvas dimensions from
   the tab record in a context, but props are preferred for explicitness.

6. **BC7 encode quality vs. speed trade-off.** bc7enc_rdo exposes quality mode settings.
   Decide on a default quality level for the initial implementation. The spec does not prescribe a
   specific quality setting; a reasonable default is bc7enc's mode 6 with `uber_level = 2`
   (good quality, moderate speed). This decision can be deferred to the implementation phase.

7. **Mip-chain box filter for RGBA32F.** Box-filter averaging in `dds_encode_f32` must operate
   in linear-light float space (which `rgba32f` already is) — no gamma correction needed. Confirm
   that the LDR mip-chain path in `dds_encode` (RGBA8 box filter) does not introduce banding for
   images that were converted from HDR; if it does, consider performing the box-filter in float
   and rounding at the end.
