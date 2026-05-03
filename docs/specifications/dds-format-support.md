# DDS Format Support

## Overview

DirectDraw Surface (DDS) is the standard texture container format for real-time graphics pipelines. It is natively supported by DirectX, Vulkan, OpenGL, and all major game engines. Professional artists working on games, 3D applications, or content pipelines routinely need to author, inspect, and re-export DDS textures — tasks that currently require a separate tool because Verve does not read or write the format.

This feature adds first-class DDS support to Verve: DDS files can be opened via the regular **File → Open** dialog and loaded onto the canvas like any other image, and the existing **Export As** dialog gains a DDS option with controls for compression format, mip map generation, and header compatibility. BCx decompression and compression are both executed through the C++/WASM layer; there is no realtime GPU-side compression requirement.

DDS files that contain HDR float content — BC6H-compressed or uncompressed RGBA32F — open as **rgba32f documents**, preserving float values above 1.0. All other DDS formats open as standard **rgba8 documents**. On export, an rgba32f document defaults to BC6H compression; an rgba8 document defaults to BC3.

---

## User Stories

- **As a game artist**, I want to open a DDS texture directly in Verve so I can paint on it, apply adjustments, and re-export it as DDS without leaving the tool.
- **As a technical artist**, I want to choose a BCx compression format when exporting so the output is immediately usable by the engine's asset pipeline without a separate conversion step.
- **As a developer reviewing assets**, I want to open a DDS file and see its base mip level on the canvas so I can inspect its content without needing additional tooling.
- **As an artist targeting legacy platforms**, I want the option to emit a DX9-compatible DDS header so older loaders can read the file.
- **As an artist targeting modern engines**, I want to emit a DX10-extended header when using BC7, BC6H, or RGBA32F, since those formats require it.
- **As a VFX or environment artist working with HDR textures**, I want to open a BC6H or RGBA32F DDS texture and keep its full float range in a 32-bit document so I can edit it and re-export without clipping HDR detail.

---

## Functional Requirements

### Import

- DDS files **must** be openable via **File → Open** (and its associated OS file picker dialog) without any extra steps beyond selecting the file.
- The file picker **must** include `.dds` in its accepted extensions alongside the existing formats.
- On load, Verve **must** read the DDS header and decode only the **base mip level** (mip 0). Higher mip levels, if present, are ignored silently.
- The decoded base mip level **must** be converted to a standard RGBA8 (`Uint8Array`, top-left origin) buffer and loaded onto the canvas as a new raster layer, exactly as other image formats are handled.
- The new layer and the canvas dimensions **must** reflect the pixel dimensions of the base mip level.
- The following **uncompressed** pixel formats **must** be supported on load:
  - `RGBA8` (DXGI_FORMAT_R8G8B8A8_UNORM)
  - `BGRA8` / `A8R8G8B8` (legacy DX9 D3DFMT_A8R8G8B8 and DXGI_FORMAT_B8G8R8A8_UNORM)
- The following **BCx-compressed** pixel formats **must** be supported on load:
  - BC1 (DXT1), BC2 (DXT3), BC3 (DXT5), BC4 (ATI1 / BC4_UNORM), BC5 (ATI2 / BC4_SNORM pair / BC5_UNORM), BC6H (BC6H_UF16 and BC6H_SF16), BC7
- Both **DX9 (legacy)** DDS files (identified by a `FOURCC` code in the header's `ddspf.dwFourCC` field) and **DX10 (extended)** DDS files (identified by the `DX10` FOURCC and a trailing `DDS_HEADER_DXT10` chunk) **must** be supported on load.
- BCx decompression **must** be performed via the C++/WASM layer.
- **BC6H** (BC6H_UF16 and BC6H_SF16) and **uncompressed RGBA32F** (`DXGI_FORMAT_R32G32B32A32_FLOAT`) DDS files **must** open as **rgba32f documents**, with float pixel values preserved as-is (values above 1.0 are retained for HDR content). The resulting layer's `format` field is `'rgba32f'` and the document's pixel format is set accordingly.
- All other supported DDS formats **must** be decoded to RGBA8 and opened as **rgba8 documents**. The result delivered to the canvas is a `Uint8Array` with values in the 0–255 range.
- If a DDS file is identified as a **cubemap** (i.e. the `DDSCAPS2_CUBEMAP` flag is set), loading **must** be refused with a user-visible, non-technical error message: *"This DDS file contains a cubemap texture, which is not supported. Only 2D textures can be opened."*
- If a DDS file is identified as a **volume texture** (i.e. the `DDSCAPS2_VOLUME` flag is set, or `resourceDimension == D3D10_RESOURCE_DIMENSION_TEXTURE3D` in a DX10 header), loading **must** be refused with the message: *"This DDS file contains a 3D volume texture, which is not supported. Only 2D textures can be opened."*
- If the DDS signature bytes (`DDS ` / `0x44445320`) are present but the header is malformed or the pixel data cannot be decoded, Verve **must** show an error dialog: *"Failed to open DDS file: the file is corrupt or uses an unsupported variant."* The canvas and layer stack **must** remain unchanged.
- Unrecognized or unsupported DXGI formats (e.g. RGBA16F, R32_FLOAT, array textures, etc.) **must** produce the error: *"This DDS file uses a pixel format that is not supported (format: <format name or DXGI code>)."*

### Export

- The **Export As** dialog **must** include `DDS` as a selectable format option alongside the existing PNG, JPEG, WebP, TGA, and TIFF entries.
- Selecting DDS as the format **must** apply a `.dds` extension to the output file path, consistent with how other format selections update the extension.
- When DDS is selected, the dialog **must** display a **DDS Options** section below the format selector. This section **must** contain exactly three controls:

#### Control 1 — Compression Format

A labeled dropdown titled **"Compression"** with the following options, listed in this order:

For **rgba32f documents**, the HDR-native formats appear first in the list under an **"HDR Formats (float precision preserved)"** group header:

| Display Label                    | Encoding Details                                   |
|----------------------------------|----------------------------------------------------|
| BC6H — HDR Float (compressed)    | BC6H_UF16; preserves float values, compressed      |
| RGBA32F — Uncompressed HDR       | DXGI_FORMAT_R32G32B32A32_FLOAT; 128 bits per pixel |

Followed by an **"LDR Formats (HDR values clipped)"** group header containing the LDR options:

| Display Label              | Encoding Details                          |
|----------------------------|-------------------------------------------|
| Uncompressed (RGBA8)       | No compression; 32 bits per pixel         |
| BC1 — No Alpha             | BC1 / DXT1, no alpha channel              |
| BC1 — 1-bit Alpha          | BC1 / DXT1, punch-through alpha           |
| BC2                        | BC2 / DXT3, explicit 4-bit alpha          |
| BC3 — Full Alpha           | BC3 / DXT5, interpolated alpha            |
| BC4 — Single Channel       | BC4, single luminance/red channel         |
| BC5 — Dual Channel         | BC5, dual-channel (e.g. normal map RG)    |
| BC7 — High Quality         | BC7; best quality, slowest to compress    |

For **rgba8 documents**, all options are presented in a single flat list in the same order as the LDR table above, with BC6H and RGBA32F appended at the bottom (not grouped):

| Display Label              | Encoding Details                          |
|----------------------------|-------------------------------------------|
| ...all LDR options above...| ...                                       |
| BC6H — HDR Float           | BC6H_UF16; HDR unsigned float             |
| RGBA32F — Uncompressed HDR | DXGI_FORMAT_R32G32B32A32_FLOAT            |

**Default selection:**
- rgba32f document → **BC6H — HDR Float (compressed)**
- rgba8 document → **BC3 — Full Alpha**

**HDR clipping warning:** When an **rgba32f document** has an LDR compression format selected, an inline warning **must** appear below the compression dropdown: *"HDR values above 1.0 will be clipped. Use BC6H or RGBA32F to preserve HDR detail."* The warning disappears when BC6H or RGBA32F is selected.

#### Control 2 — Mip Maps

A labeled dropdown or toggle titled **"Mip Maps"** with two options:

- **Base level only** (default) — only mip 0 is written to the file.
- **Generate full mip chain** — a complete power-of-two mip chain is generated down to 1×1 and written to the file. Verve generates all mip levels by downsampling from the base level (using a box or Lanczos filter; implementation detail).

The mip map option **should** be disabled (greyed out, defaulting to "Base level only") when the canvas dimensions are not both powers of two, with an inline note: *"Mip chains require power-of-two dimensions."* Non-power-of-two images can still be exported as DDS with base level only.

#### Control 3 — Header Format

A labeled dropdown or toggle titled **"Header"** with two options:

- **Modern (DX10 header)** — writes the `DX10` FOURCC extension and a `DDS_HEADER_DXT10` chunk. All DXGI format codes are expressed explicitly. Compatible with all current DX11/DX12 loaders.
- **Backward Compatible (DX9 header)** — writes a legacy DX9 header using FOURCC codes only. Compatible with older loaders that do not support the DX10 extension.

The following constraints on the header format **must** be enforced:

- **BC6H** and **BC7** always require DX10 header. If either is selected, the header format control **must** switch to "Modern (DX10 header)" automatically and the control **must** be disabled (greyed out) until a different compression format is chosen. An inline note **must** read: *"BC6H and BC7 require the DX10 header extension."*
- In **DX9 mode**, BC4 is encoded with FOURCC `ATI1` and BC5 is encoded with FOURCC `ATI2`.
- In **DX10 mode**, BC4 is encoded as `DXGI_FORMAT_BC4_UNORM` and BC5 as `DXGI_FORMAT_BC5_UNORM`.

- Clicking **Export** in the dialog **must** flatten the document using the unified rasterization pipeline. For **rgba32f documents** with an HDR-native format selected (BC6H or RGBA32F), the pipeline output is a `Float32Array` and is passed directly to the WASM compression layer. For **rgba32f documents** with an LDR format selected, the float buffer is first clamped to RGBA8 (`Uint8Array`, 0–255) before passing to WASM. For **rgba8 documents**, the flattened buffer is a `Uint8Array` regardless of format.
- Compression **must** run entirely in the C++/WASM layer (e.g. bc7enc_rdo, libsquish, or a compatible library). No GPU-side BCx encoding is required.
- During compression, a **non-blocking progress indicator** (e.g. a spinner or progress bar on the Export button) **must** be shown. The dialog **must** remain open until compression completes. The user **must** be able to cancel the operation via a **Cancel** button while compression is in progress. Cancelling **must** leave no partial file on disk.
- On completion, the output file is written to the path chosen in the dialog. The dialog **should** close automatically on success.
- If compression or file-write fails, the dialog **must** remain open and display an error message inline (e.g. *"Export failed: <reason>"*). The user **must** be able to retry or cancel.

---

## Format Support Table

| Format               | On Load | On Export | Opens as    | Alpha Support       | DX9 Header (FOURCC)       | DX10 Header (DXGI)                  |
|----------------------|---------|-----------|-------------|---------------------|---------------------------|-------------------------------------|
| Uncompressed RGBA8   | ✓       | ✓         | rgba8       | Full 8-bit alpha    | D3DFMT_A8R8G8B8            | DXGI_FORMAT_R8G8B8A8_UNORM          |
| Uncompressed BGRA8   | ✓       | —         | rgba8       | Full 8-bit alpha    | D3DFMT_A8R8G8B8            | DXGI_FORMAT_B8G8R8A8_UNORM          |
| Uncompressed RGBA32F | ✓       | ✓         | **rgba32f** | None (HDR)          | Not supported (DX10 only) | DXGI_FORMAT_R32G32B32A32_FLOAT      |
| BC1 (no alpha)       | ✓       | ✓         | rgba8       | None                | DXT1                       | DXGI_FORMAT_BC1_UNORM               |
| BC1 (1-bit alpha)    | ✓       | ✓         | rgba8       | Punch-through 1-bit | DXT1 (with alpha)          | DXGI_FORMAT_BC1_UNORM               |
| BC2                  | ✓       | ✓         | rgba8       | Explicit 4-bit      | DXT3                       | DXGI_FORMAT_BC2_UNORM               |
| BC3                  | ✓       | ✓         | rgba8       | Interpolated 8-bit  | DXT5                       | DXGI_FORMAT_BC3_UNORM               |
| BC4                  | ✓       | ✓         | rgba8       | None (single ch.)   | ATI1                       | DXGI_FORMAT_BC4_UNORM               |
| BC5                  | ✓       | ✓         | rgba8       | None (dual ch.)     | ATI2                       | DXGI_FORMAT_BC5_UNORM               |
| BC6H (UF16)          | ✓       | ✓         | **rgba32f** | None (HDR)          | Not supported (DX10 only) | DXGI_FORMAT_BC6H_UF16               |
| BC6H (SF16)          | ✓       | —         | **rgba32f** | None (HDR signed)   | Not supported (DX10 only) | DXGI_FORMAT_BC6H_SF16               |
| BC7                  | ✓       | ✓         | rgba8       | Full 8-bit alpha    | Not supported (DX10 only) | DXGI_FORMAT_BC7_UNORM               |

Notes:
- "On Load" includes both DX9 and DX10 variants unless noted.
- **"Opens as"** indicates the Verve document pixel format the file creates. `rgba32f` documents preserve float values including those above 1.0 (HDR).
- On export, only **unsigned** BC6H (UF16) is offered. BC6H (SF16) files can be loaded (producing an rgba32f document) but are not re-exported as SF16.
- BGRA8 is recognized on load (common in older DX9 game assets) but export always uses RGBA8 for the uncompressed option.
- RGBA32F requires the DX10 header on export; the header selector is locked automatically.

---

## Out of Scope

The following DDS features are explicitly **not** supported in this version:

- **Cubemap textures** — DDS files with the cubemap capability flag. Loading is refused with an error.
- **Volume (3D) textures** — DDS files where the resource is a 3D texture. Loading is refused with an error.
- **Array textures** — DDS files with `arraySize > 1` in the DX10 header. Loading is refused with an error: *"This DDS file contains a texture array, which is not supported."*
- **Mip-level inspection** — there is no UI for selecting and inspecting individual mip levels. Only mip 0 is loaded.
- **GPU-side BCx encoding** — all compression is WASM-only.
- **Signed BC4 / BC5** (`BC4_SNORM`, `BC5_SNORM`) on export. These are loadable but not exportable.
- **BC6H SF16 (signed) export** — files loaded as BC6H_SF16 open as rgba32f documents but are not re-exported as signed BC6H. Unsigned BC6H (UF16) is the only BC6H export target.
- **Premultiplied alpha DDS variants** — formats such as `DXGI_FORMAT_R8G8B8A8_UNORM_SRGB` with premultiplied alpha encoding are loaded as-is without alpha un-premultiplication.
- **sRGB format variants** — `_SRGB` DXGI suffixed formats (e.g. BC1_UNORM_SRGB) are treated as their linear equivalents. No gamma correction is applied during load or export.
- **DDS files embedded inside other containers** (e.g. `.ktx`, `.pkg`, or game archive formats).

---

## Error Handling

| Condition | User-Visible Message | Behavior |
|---|---|---|
| Cubemap DDS opened | "This DDS file contains a cubemap texture, which is not supported. Only 2D textures can be opened." | File open is aborted; canvas unchanged. |
| Volume/3D texture DDS opened | "This DDS file contains a 3D volume texture, which is not supported. Only 2D textures can be opened." | File open is aborted; canvas unchanged. |
| Texture array DDS opened | "This DDS file contains a texture array, which is not supported. Only 2D textures can be opened." | File open is aborted; canvas unchanged. |
| Malformed or corrupt DDS | "Failed to open DDS file: the file is corrupt or uses an unsupported variant." | File open is aborted; canvas unchanged. |
| Unrecognized DXGI format | "This DDS file uses a pixel format that is not supported (format: \<name/code\>)." | File open is aborted; canvas unchanged. |
| BCx decompression failure (WASM error) | "Failed to decompress DDS file: the pixel data could not be decoded." | File open is aborted; canvas unchanged. |
| DDS export compression failure | Inline dialog error: "Export failed: compression error. Please try a different format or check available memory." | Dialog stays open; no file written. |
| DDS export write failure (disk full, permission) | Inline dialog error: "Export failed: \<OS error message\>." | Dialog stays open; no partial file. |
| User cancels in-progress DDS export | No message; operation is silently aborted. | Dialog closes; no file written or partial file is cleaned up. |

All error messages must be friendly and non-technical in tone. Raw WASM/native error strings **must not** be surfaced directly; they should be logged to the developer console only.

---

## UX Notes

### Format Selector Placement

DDS is added to the **Format** dropdown in the **Export As** dialog immediately after TGA in the list order: PNG → JPEG → WebP → TGA → TIFF → **DDS**. The file extension in the path field updates to `.dds` when this option is selected.

### DDS Options Panel

The DDS options section appears immediately below the format/divider line, replacing the per-format options that appear for JPEG and WebP. The three controls appear in this order:
1. Compression (dropdown)
2. Mip Maps (dropdown or toggle)
3. Header (dropdown or toggle)

The controls should be laid out consistently with the JPEG quality row — labeled fields aligned to the existing grid.

### Forced DX10 Header

When **BC6H**, **BC7**, or **RGBA32F** is selected in the Compression dropdown, the Header control must lock to "Modern (DX10 header)" immediately. The control appears visually disabled and an inline note below it reads: *"BC6H, BC7, and RGBA32F require the DX10 header."* Switching to any other compression format restores the Header control to its previous selection.

### HDR Clipping Warning

When the active document is an **rgba32f document** and an LDR compression format is selected (any format other than BC6H or RGBA32F), a warning note appears below the compression dropdown:

> *"HDR values above 1.0 will be clipped. Use BC6H or RGBA32F to preserve HDR detail."*

The warning disappears as soon as an HDR-native format is selected. It is informational only — the user may proceed with an LDR format regardless.

### DX9 Mode and ATI Codes

When "Backward Compatible (DX9 header)" is selected alongside **BC4** or **BC5**, the export writes the legacy FOURCC `ATI1` (BC4) or `ATI2` (BC5) into the header. No special visual note is required for this; it is standard industry behavior that target loaders will handle.

### Mip Map Control Interaction

The **Generate full mip chain** option is only enabled if the canvas dimensions are both powers of two (e.g. 512×512, 1024×2048). For non-power-of-two canvases, the dropdown is locked to "Base level only" and a short note reads: *"Mip chains require power-of-two dimensions."* This constraint is evaluated against the current canvas size at the time the dialog opens; it does not update dynamically while the dialog is open.

### Import Behavior — No Extra Dialogs

Opening a DDS file must not produce any confirmation dialogs, format option prompts, or progress dialogs beyond the standard loading feedback already shown for large files. The format is detected automatically from the file header; the `.dds` extension is used only as a hint for the OS file picker. If Verve can decode the content, it opens silently.

### File Picker — Open Dialog

The OS file open dialog must include a DDS filter entry (`.dds`) in its extension filter list. The exact filter label is *"DirectDraw Surface (*.dds)"*. DDS should appear alongside, not replace, the existing per-format filters and the "All Supported Images" combined filter.

---

## Related Features

- [Unified Rasterization Pipeline](unified-rasterization-pipeline.md) — DDS export must use the same flatten/rasterize path as all other export formats.
- [Export As Dialog](../developerguides/project-structure.md) — DDS is a new option in the existing `ExportDialog`, extending `ExportFormat` and `ExportSettings`.
- WASM layer (`src/wasm/`) — BCx encode and decode are new operations added to the C++/WASM module following the standard WASM integration pattern.
