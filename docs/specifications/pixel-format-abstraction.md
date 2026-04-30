# Pixel Format Abstraction

## Overview

Verve currently treats every document as an implicit 8-bit-per-channel RGBA raster. This feature makes the pixel format a first-class, document-wide property with three possible values: **rgba8** (the current default, unchanged), **rgba32f** (32-bit floating-point per channel, for HDR and wide-gamut editing), and **indexed8** (palette-indexed, one byte per pixel, where each value is an index into the document's swatch palette). The format is stored in the `.verve` project file and is visible in the status bar. The user can change a document's pixel format at any time via **Image → Color Mode**, with a lossless or quantized conversion applied to all raster layer pixel data.

This abstraction is the shared foundation for two follow-on features — Indexed Color Mode and HDR FP32 Mode — which define the user-facing tools and import/export behaviors for their respective formats. This spec covers only the architectural foundation: what a pixel format is, how it changes the GPU and CPU data representations, how the compositor handles each format, how the file format evolves, and which features are gated per format.

---

## User Stories

- **As a photographer**, I want to edit in 32-bit float precision so that highlights and shadows retain detail beyond the 0–255 clamp, and so I can apply broad adjustments without banding.
- **As a pixel artist or retro-game developer**, I want a palette-indexed mode where every pixel is stored as a palette index, so layer data can later be exported as an indexed PNG or tileset with exact palette mapping.
- **As any user**, I want my existing rgba8 documents to work exactly as they do today, with no regressions.
- **As any user**, I want to see the document's current pixel format in the status bar at a glance.
- **As any user**, I want to convert a document from one format to another at any time, with a predictable conversion that is reversible through undo.

---

## Functional Requirements

### Pixel Format Discriminant

- A document **must** have exactly one pixel format at any time, expressed as a discriminant: `'rgba8'`, `'rgba32f'`, or `'indexed8'`.
- The pixel format **must** be a document-wide property, not a per-layer property. All raster layers in a document share the same pixel format.
- New documents **must** default to `'rgba8'`.
- Images opened from external files (PNG, JPEG, TIFF, etc.) **must** default to `'rgba8'` unless a follow-on feature (HDR import, indexed import) explicitly sets the format during loading.
- The pixel format **must** be stored in the `.verve` project file and round-trip without loss.

### Per-Format Data Representations

| Format | CPU layer buffer type | WebGPU texture format | Bytes per pixel |
|---|---|---|---|
| `rgba8` | `Uint8Array` (`layerW × layerH × 4`) | `rgba8unorm` | 4 |
| `rgba32f` | `Float32Array` (`layerW × layerH × 4`) | `rgba32float` | 16 |
| `indexed8` | `Uint8Array` (`layerW × layerH × 1`) | `rgba8unorm` (compositor expands) | 1 |

- In `rgba8` mode, `GpuLayer.data` **must** remain a `Uint8Array` of RGBA bytes, as today. No change to existing behavior.
- In `rgba32f` mode, `GpuLayer.data` **must** be a `Float32Array` where each R, G, B, A component is in the normalized range [0.0, 1.0] for standard content. Values outside [0, 1] are legal and represent HDR content; they are never clamped during editing.
- In `indexed8` mode, `GpuLayer.data` **must** be a `Uint8Array` where each byte is an index into the document's swatch palette (0 = first swatch color, 1 = second, etc.). The byte value `255` is reserved as the transparent/void index when fewer than 256 palette entries exist.

### Compositor Behavior for `indexed8`

- The compositor (WebGPU render plan) **must** expand indexed layer data to RGBA at display time by looking up each index in the document's swatch palette before compositing.
- This expansion **must** happen on the GPU, not in a CPU pre-pass. The compositor uploads the palette as a uniform buffer or small texture alongside the indexed layer texture.
- The source texture for an `indexed8` layer **must** be an `rgba8unorm` texture containing the expanded RGBA values. The CPU-side `GpuLayer.data` remains as raw indices; `flushLayer` is responsible for the expansion during upload.
- When the palette changes (swatches added, removed, reordered, or recolored), all `indexed8` layers **must** be re-uploaded to reflect the new palette mapping. The CPU-side index data is unchanged; only the GPU texture changes.
- Index values that exceed the palette length (e.g., a stale index after palette shrinkage) **must** render as fully transparent.

### Status Bar

- The status bar **must** display the document's current pixel format next to the document dimensions.
- The displayed label **must** be:
  - `RGB/8` for `rgba8` (matching today's hardcoded label, now driven dynamically)
  - `RGB/32F` for `rgba32f`
  - `Indexed/8` for `indexed8`

### Changing the Pixel Format (Image → Color Mode)

- The **Image** menu **must** contain a **Color Mode** submenu with three items:
  - **RGB/8** (checked when the document is `rgba8`)
  - **RGB/32 Float** (checked when the document is `rgba32f`)
  - **Indexed/8** (checked when the document is `indexed8`)
- Selecting the currently active mode **must** be a no-op with no conversion dialog and no undo entry.
- Selecting a different mode **must** present a modal confirmation dialog: *"Convert document to [new mode]? This will convert all raster layer data. This operation can be undone."* The dialog has **Convert** and **Cancel** buttons.
- On confirmation, the conversion **must** be applied to all raster layers in the document (pixel layers, layer mask data). Adjustment layers, shape layers, and text layers are not affected by the conversion at the data level (they hold parameters, not pixel buffers).
- The conversion **must** be recorded as a single undo history entry. Pressing Ctrl+Z after a mode conversion **must** restore all layers to their pre-conversion pixel data and revert the document's pixel format.
- After conversion, the status bar label **must** update to reflect the new format.

### Feature Availability per Pixel Format

#### Adjustment Layers

- All color-adjustment, real-time effect, and filter adjustment layers are **fully available** in `rgba8` and `rgba32f` modes.
- Adjustment layers are **disabled** in `indexed8` mode. The Adjustments and Effects top menus **must** be grayed out (non-interactive) when the document is `indexed8`. Filter adjustment layers are similarly disabled.
- Existing adjustment layers within a document converted to `indexed8` **must** be preserved in the layer stack but rendered as non-operational (their GPU passes are skipped). On conversion back to `rgba8` or `rgba32f`, they become active again.

#### Drawing Tools

- All drawing tools (brush, pencil, eraser, fill, gradient, clone stamp, dodge, burn, etc.) are **fully available** in `rgba8` and `rgba32f` modes.
- In `indexed8` mode, tools that paint continuous RGBA color values are **disabled**. The following tools are unavailable in `indexed8`:
  - Brush (multi-stop opacity, softness, flow, blending modes)
  - Gradient
  - Clone Stamp
  - Dodge
  - Burn
- The following drawing tools **remain available** in `indexed8` mode, operating on palette indices:
  - Pencil (paints the palette index of the primary swatch)
  - Eraser (writes the transparent/void index)
  - Fill (flood-fills with the palette index of the primary swatch)
  - Selection tools (all)
  - Move, Transform, Crop, Hand, Zoom, Eyedropper

#### Other Feature Interactions

- Free transform, resize, and crop operations are available in all three formats.
- Undo/redo works identically across all formats.
- Layer operations (new, delete, duplicate, merge, flatten, group) are available in all formats, subject to the data-representation rules for the active format.
- The eyedropper in `indexed8` mode **must** sample the palette index of the clicked pixel and set the primary swatch to the corresponding palette color.

---

## Conversion Behavior

When the user confirms a mode change, every raster pixel buffer in the document is converted in place according to the following rules.

| From | To | Conversion |
|---|---|---|
| `rgba8` | `rgba32f` | Each `Uint8` channel value `v` is normalized: `float = v / 255.0`. Full color fidelity is preserved; no data is lost. |
| `rgba32f` | `rgba8` | Each float channel `f` is clamped to [0.0, 1.0] then quantized: `byte = round(f × 255)`. Values outside [0, 1] (HDR content) are clamped and lost. |
| `rgba8` | `indexed8` | Each pixel's RGBA value is matched to the nearest entry in the current swatch palette (by Euclidean distance in RGBA space). The pixel is replaced by the index of the matched entry. Colors not present in the palette are approximated; precision depends on the palette. |
| `indexed8` | `rgba8` | Each index is expanded to its corresponding RGBA swatch color. If the index exceeds the current palette length, the pixel becomes fully transparent (`[0, 0, 0, 0]`). Full fidelity is guaranteed for valid indices. |
| `rgba32f` | `indexed8` | First clamps and quantizes to `rgba8` (as above), then maps to palette indices (as above). Two-step loss. |
| `indexed8` | `rgba32f` | Expands indices to RGBA8 (as above), then normalizes to float (as above). No additional loss beyond the expand step. |

Conversion is applied to:
- All `PixelLayer` CPU data buffers (`GpuLayer.data`)
- All layer mask CPU data buffers
- The `savedLayerData` serialization of backgrounded tabs

Conversion does **not** apply to:
- Adjustment layer parameter objects (they store logical values, not pixel buffers)
- Text layer or shape layer state
- The swatch palette itself

### Conversion Warnings

- When converting from `rgba32f` to `rgba8` or `indexed8`, the confirmation dialog **must** include an additional note: *"Out-of-range (HDR) pixel values will be clamped to the 0–255 range."*
- When converting from any format to `indexed8`, the confirmation dialog **must** include an additional note: *"All adjustment layers will be suspended in Indexed/8 mode."*

---

## `.verve` File Format Changes

The `.verve` format is a JSON document. This feature advances the format to **version 5**.

### New top-level field: `pixelFormat`

```json
{
  "version": 5,
  "pixelFormat": "rgba8",
  ...
}
```

- `pixelFormat` **must** be one of `"rgba8"`, `"rgba32f"`, or `"indexed8"`.
- If `pixelFormat` is absent, the document is treated as `"rgba8"` (backward compatibility with versions 1–4).

### Layer data encoding by format

| Format | Encoding in `.verve` |
|---|---|
| `rgba8` | Unchanged: base64-encoded PNG (lossless, 8-bit RGBA). |
| `rgba32f` | Base64-encoded binary blob of raw `Float32Array` bytes (little-endian IEEE 754), stored under a new `layerDataF32` sibling key instead of `pngData`. |
| `indexed8` | Base64-encoded raw `Uint8Array` of palette indices (1 byte/pixel), stored under a new `layerDataIndexed` sibling key. |

The existing `pngData` key continues to be used for `rgba8` layers. A layer record in a version 5 file will contain exactly one of `pngData`, `layerDataF32`, or `layerDataIndexed` depending on the document's pixel format.

### Version compatibility

| Reading a file | Behavior |
|---|---|
| Version 1–4 (no `pixelFormat` field) | Loaded as `rgba8`. No conversion. Full backward compatibility. |
| Version 5 with `pixelFormat: "rgba8"` | Loaded normally; `pngData` fields decoded as today. |
| Version 5 with `pixelFormat: "rgba32f"` | `layerDataF32` fields decoded as `Float32Array`. |
| Version 5 with `pixelFormat: "indexed8"` | `layerDataIndexed` fields decoded as `Uint8Array` of indices. |
| Version 5 with an unrecognized `pixelFormat` value | Open is aborted; error is shown to the user. The document is not loaded. |

A version 5 `.verve` file opened by an older version of Verve (which does not know about version 5) will fail gracefully: the older reader will reject the unknown version and display an error.

---

## Error Handling

- If the `pixelFormat` field in a `.verve` file is present but not one of the three known values, the open operation **must** be aborted with a user-visible error message: *"This document uses an unsupported pixel format and cannot be opened."*
- If `layerDataF32` or `layerDataIndexed` is missing or malformed for a layer in a format-5 document, the open operation **must** be aborted with a user-visible error. No partial layer loading.
- If a mode conversion fails mid-way (e.g., out-of-memory during a large `rgba32f` allocation), the document **must** be left in its pre-conversion state. The failed conversion **must not** be recorded in undo history.
- If the swatch palette is empty when converting to `indexed8`, the conversion **must** be blocked with a user-visible error: *"The swatch palette must contain at least one color before converting to Indexed/8 mode."*
- Tool and menu items that are disabled in the current pixel format **must** be visually grayed out and non-interactive. They **must not** silently no-op on invocation.

---

## Out of Scope

The following items are explicitly not covered by this specification and are deferred to follow-on feature specs:

- **HDR file I/O:** Opening or exporting `.exr`, `.hdr`, or 32-bit TIFF files is not addressed here. This spec only defines the internal `rgba32f` representation.
- **Indexed file I/O:** Opening or exporting indexed PNG or GIF files is not addressed here. This spec only defines the internal `indexed8` representation.
- **Per-layer pixel formats:** All layers in a document share one pixel format. Mixed-format layer stacks are not supported.
- **16-bit integer formats:** `rgba16` or `rgba16f` are not included in V1 of this abstraction.
- **Color management / ICC profiles:** Color space tagging and gamut mapping are out of scope. `rgba32f` is treated as untagged scene-linear data.
- **Print or CMYK output modes:** Not part of this feature.
- **Grayscale document mode:** The existing `grayscale` color mode in the New Image dialog is a separate, unrelated concept and is not unified with this system in V1.

---

## Related Features

- [unified-rasterization-pipeline.md](unified-rasterization-pipeline.md) — the compositing pipeline that must handle all three formats for flatten, export, and screen preview.
- [palette-verve-persistence.md](palette-verve-persistence.md) — the swatch palette that serves as the palette for `indexed8` index expansion.
- [generate-palette.md](generate-palette.md) — generates the swatch palette used by `indexed8` mode.
- [color-dithering.md](color-dithering.md) — dithering adjustment that operates with the swatch palette; unavailable in `indexed8` mode.
- HDR FP32 Mode *(spec pending)* — follow-on feature that adds HDR import/export and editing workflows on top of the `rgba32f` format defined here.
- Indexed Color Mode *(spec pending)* — follow-on feature that adds indexed PNG/GIF import/export and palette-aware drawing workflows on top of the `indexed8` format defined here.
