# HDR FP32 Editing Mode

## Overview

HDR FP32 Editing Mode enables Verve to store and process image data as 32-bit floating-point values per channel (`rgba32f`), where pixel values are no longer constrained to the `[0, 1]` normalized range. This unlocks three primary use cases:

1. **Compositing HDR renders** — EXR and Radiance HDR files carry scene-linear luminance values that can be dozens of times above the display range. Artists compositing environment maps, light probes, and CG renders need to adjust, grade, and merge this data without truncating the bright parts.
2. **Working with game-engine textures** — DDS BC6H textures (common in game pipelines) are HDR-compressed formats that expand to float values above `1.0`. Editing these round-trip without banding requires a float working space.
3. **Avoiding clipping on aggressive LDR adjustments** — even when the source material is standard dynamic range, aggressive curves, exposure adjustments, or tone-grading workflows benefit from intermediate float precision. Without it, highlight and shadow detail are lost irreversibly at the clamp boundaries of 8-bit arithmetic.

HDR FP32 mode is not a separate application mode; it is the `rgba32f` document-wide pixel format introduced by the [Pixel Format Abstraction](pixel-format-abstraction.md) spec. This document specifies all behavior that is specific to `rgba32f` documents: GPU pipeline changes, tone-mapped display preview, exposure control, tool color injection, adjustment and filter shader requirements, eyedropper semantics, the HDR-aware color picker, compositing precision, flatten/merge/export behavior, and file format I/O for EXR, Radiance HDR, and 32-bit TIFF. The pixel format activation workflow (**Image → Color Mode**) and the general conversion rules are defined in the Pixel Format Abstraction spec and are not repeated here.

---

## User Stories

- **As a VFX compositor**, I want to open a multi-layer EXR file in Verve and adjust exposure and color grade on individual layers without clipping highlights, so that I can deliver a correctly lit composite.
- **As a game artist**, I want to open a Radiance HDR panorama or a DDS BC6H light probe, make paint and grading adjustments, and re-export it as EXR or HDR with no banding, so that it integrates cleanly into the engine's PBR pipeline.
- **As a photographer**, I want to apply a strong curves adjustment to a 32-bit TIFF scan without blowing out whites or crushing blacks, so that I can recover detail that would be lost in an 8-bit workflow.
- **As any user**, I want a visual preview of HDR content on my standard monitor, with a simple exposure slider to lift or lower the preview brightness so I can inspect the full dynamic range without modifying the actual pixel data.
- **As any user**, I want the primary and secondary color pickers to let me enter colors with luminance above `1.0` (e.g., emissive surface colors in game art), so that brush and fill tools can paint spectrally bright values into an FP32 canvas.
- **As any user**, I want the eyedropper to accurately report when a sampled pixel is HDR (any channel above `1.0`), so I know I'm picking a value that cannot be represented in standard 8-bit.

---

## User Interaction

### Activating FP32 Mode

The user activates FP32 mode via **Image → Color Mode → RGB/32 Float**. A confirmation dialog is shown before any conversion occurs. See the [Pixel Format Abstraction](pixel-format-abstraction.md) spec for the full activation and conversion workflow.

An `rgba32f` document can also be created implicitly by opening a supported HDR file (`.exr`, `.hdr`, 32-bit TIFF) — the file importer sets the document's pixel format to `rgba32f` automatically. No confirmation is required in that path.

Once active, the status bar displays `RGB/32F`.

### Preview Exposure Control

Because the document may contain pixel values above `1.0`, the on-screen canvas preview applies a tone-mapping pass before display. The user controls the preview brightness through a per-session **exposure** value.

The exposure control is surfaced as a compact inline control in the **canvas toolbar** (the horizontal strip of controls above or below the canvas view, adjacent to other view-level controls such as zoom level). It consists of:

- A label: **EV**
- A numeric text field showing the current EV value to one decimal place (e.g., `+1.0`, `-2.5`).
- A horizontally draggable slider (or click-and-drag on the label) ranging from **−4 EV** to **+4 EV**, default **0 EV**.
- The field accepts direct keyboard input; Tab or Enter confirms; Escape reverts.

The EV control is **only shown** when the active document is in `rgba32f` mode. It is hidden (not greyed out) when the document is `rgba8` or `indexed8`.

The exposure value is:
- **Per-session, per-document-tab** — not saved to the `.verve` file. Closing the tab or opening a new document resets it to `0 EV`.
- **View-only** — it affects only the on-screen tone-mapped preview. Flatten, merge, and export operations always write raw float values regardless of the current EV setting.

### HDR-Aware Color Picker

The primary and secondary color swatches use an expanded color picker when the document is in `rgba32f` mode. The picker shows all standard controls (hue/saturation area, lightness slider, hex input, channel sliders), plus:

- An **Intensity** (or **Multiplier**) numeric field, defaulting to `1.0`.
- A **float readout** for each channel (R, G, B, A), displaying values to two decimal places.

The Intensity field acts as a multiplier on the picked normalized color. For example, if the artist picks RGB `(255, 180, 60)` and sets Intensity to `3.0`, the actual float color injected into the document is `(3.0, 2.12, 0.71, alpha)`. This lets artists specify emissive, bloom-source, or light-source-colored values whose luminance exceeds what a standard picker can express.

In `rgba8` mode the Intensity field is hidden and the picker behaves as today.

### Eyedropper in FP32 Mode

When the user samples a pixel with the eyedropper in `rgba32f` mode:

- The raw float channel values are read from the composited pixel.
- If any channel is above `1.0`, a small `HDR` label appears in the color picker panel to flag that the value was clipped for display. The indicator must be clearly associated with the picked color.
- The picked color is set as the primary swatch. The stored swatch value is clamped to `[0, 255]` (8-bit) for compatibility, as the swatch system is always 8-bit.
- The pixel info area in the status bar shows the raw float values at full precision (see §Status Bar below).

### Status Bar Display

When the active document is `rgba32f`:

- The color mode field shows **`RGB/32F`**, rendered with a **blue indicator** to visually distinguish it from `RGB/8` (no color accent) and `Indexed/8`.
- The pixel info section (displayed when the cursor hovers over the canvas) shows channel values as floats to **four decimal places**: e.g., `R: 1.8423  G: 0.2100  B: 0.0034  A: 1.0000`.
- In `rgba8` mode, pixel info continues to show integer values in the `[0, 255]` range, as today.

### File Import (EXR, HDR, 32-bit TIFF)

When the user opens a file via **File → Open** or drag-and-drop:

- If the file is a `.exr`, `.hdr`, or TIFF with 32-bit float channels, Verve imports it as a new `rgba32f` document.
- No confirmation dialog is required; the document opens directly in FP32 mode, with the tone-mapped preview active at 0 EV.
- The import preserves all float channel values without clamping or quantization.
- Multi-layer EXR files: each EXR layer/channel group is imported as a separate Verve layer where possible. Single-channel or luminance-only EXR files are imported as grayscale (R=G=B, A=1.0).

### File Export (EXR, HDR, 32-bit TIFF)

When the user exports via **File → Export As** and the document is `rgba32f`:

- **EXR**, **HDR**, and **TIFF 32-bit** appear as valid export format choices in the export dialog.
- The document is flattened to a `Float32Array` via the unified rasterization pipeline, then encoded by the appropriate WASM-backed encoder.
- Export always writes **raw float values** — no tone-mapping, no clamping.
- Exporting a `rgba32f` document to a standard LDR format (PNG, JPEG, WebP, TGA) triggers a warning dialog: *"This document contains HDR data. The exported file will be tone-mapped to 8-bit using Reinhard. Values above 1.0 will be compressed or clipped."* The user must confirm. The export then applies Reinhard tone-mapping at 0 EV before encoding.

---

## Functional Requirements

### 1. CPU Layer Data Representation

- In `rgba32f` mode, `GpuLayer.data` **must** be a `Float32Array` of length `layerWidth × layerHeight × 4` (one float per RGBA channel, row-major, no padding).
- Float channel values represent scene-linear color intensities. The nominal range for displayable content is `[0.0, 1.0]`, but values outside this range are legal and **must not** be clamped during any read, write, composite, or adjustment operation.
- Alpha is defined in `[0.0, 1.0]`. Alpha values outside this range are undefined behavior; the pipeline treats alpha as nominally in-range and clamps alpha to `[0.0, 1.0]` only at the final blend step.
- `WebGPURenderer.createLayer` in `rgba32f` mode **must** allocate a `Float32Array(lw * lh * 4)` instead of `Uint8Array`. All zeros is a valid initial state (fully transparent black at 0.0 intensity).

### 2. GPU Texture Representation

- In `rgba32f` mode, every `GpuLayer.texture` **must** use `GPUTextureFormat = 'rgba32float'`.
- All ping-pong compositing textures (the intermediate accumulation targets used during the `renderPlan` and `readFlattenedPlan` passes) **must** also use `rgba32float` when the document is in `rgba32f` mode.
- `WebGPURenderer.flushLayer` in `rgba32f` mode **must** call `device.queue.writeTexture` with the `Float32Array` data and `bytesPerRow: layerWidth * 16` (4 channels × 4 bytes per float).
- `WebGPURenderer.growLayerToFit` in `rgba32f` mode **must** allocate the new, larger buffer as `Float32Array` and copy rows of floats (stride = `layerWidth * 4` floats, not bytes).
- The `RENDER_ATTACHMENT` usage flag **must** be included on `rgba32float` textures. (WebGPU requires this for render-pass color attachments regardless of format.)

### 3. Pixel Read/Write Operations

The following `WebGPURenderer` methods operate on the CPU-side `GpuLayer.data` buffer. In `rgba32f` mode they work identically in structure; only the interpretation of values changes:

| Method | rgba8 behavior | rgba32f behavior |
|---|---|---|
| `drawPixel(layer, x, y, r, g, b, a)` | Writes `Uint8` values 0–255 | Writes `float` values (callers pass pre-normalized floats) |
| `samplePixel(layer, x, y)` | Returns `[0–255, 0–255, 0–255, 0–255]` | Returns `[float, float, float, float]` in scene-linear space |
| `sampleCanvasPixel(layer, cx, cy)` | Returns `[0–255, …]` | Returns `[float, …]` |
| `erasePixel(layer, x, y)` | Writes `[0, 0, 0, 0]` | Writes `[0.0, 0.0, 0.0, 0.0]` — unchanged |

Callers of these methods **must** be aware of the document's pixel format and supply / interpret values appropriately. No automatic conversion is performed inside the renderer.

### 4. Tool Color Injection

Drawing tools (brush, pencil, fill, clone stamp, dodge, burn) read the **primary color** from the `ToolContext`, which is always an `RGBAColor` (`{ r, g, b, a }` in `[0, 255]`). The primary color swatch is an 8-bit RGBA value and remains so regardless of document format.

In `rgba32f` mode, tools **must** apply the HDR Intensity multiplier (see §5) before writing to layer data:

```
baseR = r / 255.0
baseG = g / 255.0
baseB = b / 255.0
baseA = a / 255.0

floatR = baseR * intensityMultiplier
floatG = baseG * intensityMultiplier
floatB = baseB * intensityMultiplier
floatA = baseA   // alpha is not scaled by intensity
```

`intensityMultiplier` defaults to `1.0` and is set by the Intensity field in the HDR-aware color picker. When Intensity is `1.0`, the injected values are in `[0.0, 1.0]` — standard SDR painting. Values above `1.0` in the layer data can also originate from file import (EXR, HDR, 32-bit TIFF).

Porter-Duff "over" blending and per-stroke coverage tracking (`Map<number, number>` keyed by packed pixel index) operate on float values in `rgba32f` mode. All intermediate blend computations remain in floating-point arithmetic regardless of document format.

### 5. HDR-Aware Color Picker

- The primary and secondary color pickers **must** expose an **Intensity** numeric field when the document is `rgba32f`.
- The Intensity field accepts positive float values. The valid range is `[0.0, 16.0]`, with `1.0` as the default. Values outside this range are clamped on input.
- The picker's hue/saturation selector and channel sliders always operate on the normalized `[0.0, 1.0]` base color. The Intensity field is a scalar multiplier applied on top of the base color for the RGB channels only; alpha is not multiplied.
- The displayed channel readout **must** show the **final float values** (base × intensity), not the normalized base. For example, base `(1.0, 0.7, 0.28)` with intensity `2.5` displays as `R: 2.50  G: 1.75  B: 0.70`.
- The Intensity field **must** be hidden (not just disabled) when the document is `rgba8` or `indexed8`.
- The Intensity value is stored alongside the swatch's RGBA data in the color picker state. It is **not** stored in the swatch palette itself (which remains 8-bit). When the user switches between swatches, the intensity field resets to `1.0` unless the swatch was previously set with a different intensity in the current session.

### 6. Tone-Mapping for Display

The on-screen canvas preview uses an LDR display surface (the `GPUCanvasContext` swap chain, typically `bgra8unorm`). A tone-mapping pass **must** be applied after the final compositing step, before the frame is presented, whenever the document is in `rgba32f` mode.

#### Tone-mapping formula

```
exposureLinear = pow(2.0, exposureEV)   // EV 0 → ×1.0, EV +1 → ×2.0, EV −1 → ×0.5

toneMapped.rgb = (hdrColor.rgb * exposureLinear) /
                 (hdrColor.rgb * exposureLinear + vec3f(1.0))
toneMapped.a   = hdrColor.a               // alpha passes through untouched
```

This is per-channel Reinhard tone-mapping with an exposure pre-scale. It maps `[0, ∞)` → `[0, 1)` with a smooth rolloff that preserves relative color ratios for moderately bright pixels while smoothly compressing extreme highlights.

- `exposureEV = 0` → `exposureLinear = 1.0` → no effective gain change; a pixel at `0.5` maps to `0.5 / 1.5 ≈ 0.333`.
- `exposureEV = +2` → `exposureLinear = 4.0` → a pixel at `0.25` maps to `1.0 / 2.0 = 0.5`.
- `exposureEV = −4` → `exposureLinear = 0.0625` → dims the display, making over-bright regions inspectable.

The tone-mapped result is then passed to the existing blit shader for display. No additional gamma correction step is specified here; if the canvas format requires it (sRGB transfer function), the blit shader handles that separately.

#### Architecture

The `exposureLinear` scalar **must** be passed to the blit/composite shader as a uniform (a single `f32` binding). An additional `isFp32` flag uniform (also `f32`, value `0.0` or `1.0`) controls whether the tone-mapping path is active. When `isFp32 = 0.0`, the blit shader bypasses tone-mapping and operates as it does today for `rgba8` documents.

Tone-mapping **must not** be applied during:
- Flatten (`rasterizeDocument` with `reason: 'flatten'`)
- Export (`reason: 'export'`)
- Merge (`reason: 'merge'`)
- Sample (`reason: 'sample'`)

These operations must produce raw, unclamped float output.

### 7. Adjustment Layers in FP32 Mode

All 11 color-adjustment types and 8 real-time effect types are **fully available** in `rgba32f` mode without feature gating. The WGSL compute shaders already operate in floating-point arithmetic (reading from `texture_2d<f32>` and computing in `f32`), so the mathematical operations are correct for HDR input without modification — except for the following required changes.

All 11 color-adjustment types and 8 real-time effect types remain fully available in `rgba32f` mode. The core WGSL compute shaders already operate in floating-point arithmetic (reading from `texture_2d<f32>` and computing in `f32`), so the mathematical operations are correct for HDR input without modification.

However, the following changes **must** be made to support FP32 mode:

#### 6a. Destination texture format

Every adjustment shader writes output to a `texture_storage_2d<rgba8unorm, write>`. In `rgba32f` mode this **must** change to `texture_storage_2d<rgba32float, write>`. Because WGSL storage texture formats are compile-time literals, two shader variants are required per adjustment type — one for each format — or the shader source must be constructed as a template string with the format substituted at pipeline-creation time. The per-adjustment pipeline **must** be recreated when the document changes pixel format.

#### 6b. Removing implicit and explicit clamps on color channels

The `rgba8unorm` storage format silently clamps written values to `[0.0, 1.0]`. Switching to `rgba32float` removes this implicit clamp. Existing explicit `clamp()` calls in shader code fall into two categories that must be treated differently:

| Clamp category | Example | Action in FP32 mode |
|---|---|---|
| **Color-channel value clamps** — prevent per-channel values from exceeding `[0, 1]` | `clamp(rgb + brightness, vec3f(0.0), vec3f(1.0))` in `brightness-contrast` | **Remove** — these clamps must not be applied in FP32 mode. The unclamped float value must reach the output texture. |
| **Coordinate / dimension clamps** — keep texture sample coordinates within valid bounds | `clamp(i32(id.x) + kx, 0, i32(dims.x) - 1)` | **Keep** — these are UV boundary guards, not color clamps. |
| **Saturation/lightness in HSL space** — HSL components are by definition bounded | `clamp(hsl.y + satDelta, 0.0, 1.0)` in `hue-saturation` | **Keep** — saturation in HSL is inherently `[0, 1]`; clamping here does not discard HDR data. |
| **Alpha** | any `clamp(alpha, 0.0, 1.0)` | **Keep** — alpha is always `[0, 1]`. |

Concretely, the following shaders have color-channel `clamp()` calls that **must** be conditionally bypassed in their `rgba32float` variants:
- `brightness-contrast` — both the brightness-add and the contrast-remap clamps
- `add-noise` — the per-channel noise addition clamps
- `film-grain` — the per-channel grain addition clamp
- `clouds` — the per-channel blend result clamps (the internal Perlin accumulation clamp is a generation parameter and may be kept)

All other adjustment shaders (`hue-saturation`, `color-balance`, `curves`, `color-temperature`, `color-vibrance`, `color-grading`, `selective-color`, `black-and-white`, `color-invert`) do not have color-value clamps that would suppress HDR content. Their intermediate computations already propagate float values through without range restriction.

### 8. Filter Layers in FP32 Mode

Filter adjustment layers (gaussian-blur, box-blur, radial-blur, motion-blur, lens-blur, sharpen variants, add-noise, film-grain, bilateral-filter, reduce-noise, median-filter, clouds, pixelate) are run through `filterCompute.ts`. The same destination-format requirement applies: all intermediate `rgba8unorm` textures within `filterCompute.ts` **must** be `rgba32float` when the document is in `rgba32f` mode.

Color-channel value clamps within filter shaders **must** be removed in their FP32 variants following the same rules as §7b. Coordinate-boundary clamps are unchanged.

### 9. Eyedropper (Color Sampling) in FP32 Mode

The eyedropper tool samples the composited pixel value at the cursor position by doing a CPU-side Porter-Duff composite through all visible layers. In `rgba8` mode this produces `[0–255, 0–255, 0–255, 0–255]` integer values. In `rgba32f` mode, `samplePixel` returns raw float values that may be above `1.0`.

The eyedropper sampling logic **must** be updated for FP32 mode:

1. **Alpha scaling**: In `rgba8` mode, the code computes `srcA = (sa / 255) * layer.opacity`. In `rgba32f` mode, `sa` is already a normalized float `[0.0, 1.0]`, so the `/255` division **must not** be applied. The expression becomes `srcA = sa * layer.opacity`.

2. **Swatch storage**: The sampled float values **must** be clamped to `[0.0, 1.0]` and multiplied by `255` before being set as the primary swatch color. This clamping is display-only; it does not alter layer pixel data.

3. **HDR overflow indicator**: When any sampled channel exceeds `1.0`, the color picker panel **must** display an `HDR` label (or equivalent indicator) clearly associated with the picked color, informing the user that the swatch was clipped for display.

4. **Numeric readout**: The color picker **must** display the raw float values (e.g., `R: 1.842`) for `rgba32f` documents, in addition to or in place of the clamped 0–255 values.

### 10. Status Bar in FP32 Mode

- The color mode indicator **must** show `RGB/32F` with a **blue accent color** when the document is `rgba32f`. This visually distinguishes it from `RGB/8` (no color accent) and `Indexed/8`.
- The pixel info section (shown while hovering the canvas) **must** display channel values as floats to **four decimal places** in `rgba32f` mode: e.g., `R: 1.8423  G: 0.2100  B: 0.0034  A: 1.0000`.
- In `rgba8` mode, pixel info continues to display integer values as today.

### 11. Compositing Pipeline in FP32 Mode

The render plan compositor (`WebGPURenderer.renderPlan` and `readFlattenedPlan`) uses internal ping-pong textures to accumulate the composited result layer by layer.

- All internal ping-pong textures (the accumulation surfaces) **must** use `rgba32float` when the document is in `rgba32f` mode.
- The composite WGSL shader reads from `texture_2d<f32>` (the layer source) and writes to the ping-pong target. The WGSL sampler reads `rgba32float` textures as raw float values. The composite shader code does not need to change for HDR compositing, since it already does normalized blending in `f32` arithmetic — the blend factors remain in `[0, 1]` (opacity, alpha), and unclamped color values propagate through Porter-Duff compositing correctly.
- The `compositePipeline` creation call currently hardcodes `'rgba8unorm'` as the render attachment format. In `rgba32f` mode, this **must** be `'rgba32float'`. A second `GPURenderPipeline` variant targeting `rgba32float` must be created (at renderer initialization or lazily on first use) and selected based on the document's pixel format.

### 12. Flatten, Merge, and Export in FP32 Mode

`rasterizeDocument` is the single entry point for all flatten, merge, and export operations. In `rgba32f` mode:

- The GPU rasterization pass uses `rgba32float` intermediate textures (same requirement as §11).
- The final readback from GPU to CPU (`GPUBuffer → mapAsync → Float32Array`) **must** return a `Float32Array`, not a `Uint8Array`. The `readFlattenedPlan` method **must** support returning either `Uint8Array` (for `rgba8`) or `Float32Array` (for `rgba32f`) depending on the document's pixel format. The caller receives the raw, unclamped float data.
- When the caller requires an LDR representation for downstream use (e.g., PNG/JPEG export), it is the caller's responsibility to apply tone-mapping and quantization before encoding. The rasterization pipeline itself does not apply tone-mapping for `reason: 'export'`.
- The tone-mapping exposure value from the display preview **must not** be applied during flatten/export unless the user has explicitly requested a "bake preview tone-mapping" option (which is not part of this spec). Export operations always produce the raw float document.
- Until HDR file format writers (EXR, 32-bit TIFF) are implemented, exporting a `rgba32f` document via the standard export dialog (PNG, JPEG, WebP, TGA) **must** apply a default tone-map (Reinhard at 0 EV exposure) during the export pass to produce a valid LDR image. The user **must** be warned that the export is tone-mapped and that HDR precision is not preserved.

### 13. `.verve` File Format

The `rgba32f` layer serialization format is defined by the [Pixel Format Abstraction](pixel-format-abstraction.md) spec (version 5). This section restates the rules that directly affect the `rgba32f` implementation path.

- Layer pixel data for `rgba32f` documents **must** be stored under the key `layerDataF32` (not `imageData`).
- The `layerDataF32` value is a base64-encoded binary blob of the raw `Float32Array` bytes: little-endian IEEE 754 single-precision floats, RGBA interleaved, row-major, no padding, total byte length = `layerWidth × layerHeight × 4 × 4`.
- On save, the encoder reads `GpuLayer.data` (a `Float32Array`) directly, converts to a `Uint8Array` view of the same `ArrayBuffer`, base64-encodes, and writes the result. No compression or quantization is applied.
- On open, the decoder decodes base64 to bytes, reinterprets as `Float32Array` via a `DataView` or typed array buffer view (preserving host byte order, which is always little-endian on supported platforms), and stores the result in `GpuLayer.data`.
- Layer mask data for `rgba32f` documents uses the same float encoding. Mask values are in `[0.0, 1.0]` (the mask is always a coverage map, not HDR content), but the format is `Float32Array` for consistency.
- The document-level `pixelFormat` field **must** be `"rgba32f"`. Files without this field are treated as `"rgba8"` (backward compatibility).

### 14. Format Conversion Rules

When the user converts between pixel formats via Image → Color Mode, the following numeric transformations are applied to every pixel in every raster layer:

| Direction | Per-channel conversion |
|---|---|
| `rgba8` → `rgba32f` | `float = uint8 / 255.0` — exact, lossless within float32 precision (the 255 distinct values of Uint8 are all exactly representable as float32). |
| `rgba32f` → `rgba8` | `uint8 = round(clamp(float, 0.0, 1.0) × 255)` — HDR values above `1.0` are clamped to `255`; values below `0.0` are clamped to `0`. This is a destructive, irreversible operation. The confirmation dialog must warn the user that out-of-range HDR values will be clipped. |

The conversion is applied to all `GpuLayer.data` buffers and to `savedLayerData` for backgrounded tabs. Adjustment layer parameter objects are not affected.

---

## File Format I/O

File format I/O is the mechanism by which `rgba32f` documents enter and leave Verve in HDR-native encodings. All three formats below produce and consume `Float32Array` data that feeds directly into the GPU pipeline; no intermediate 8-bit quantization occurs at import or export.

### OpenEXR (`.exr`)

**Technology:** A WASM-compiled library — either [tinyexr](https://github.com/syoyo/tinyexr) (header-only C++) or the OpenEXR reference SDK — compiled via Emscripten and exposed through `src/wasm/index.ts`. tinyexr is preferred for build simplicity.

**Import:**

1. The main process reads the `.exr` file from disk and passes the raw bytes to the renderer process via IPC.
2. The WASM decoder is called: `wasm.decodeExr(bytes)` → `{ width, height, channelData: Float32Array, channels: string[] }`.
3. The importer maps channel data (typically RGBA or RGB from named channels) into a `Float32Array` of length `width × height × 4`, placing `1.0` for missing alpha.
4. A new `rgba32f` document is created with a single pixel layer containing the decoded float data.
5. Multi-layer EXR (multiple named layer groups, e.g. `beauty.R/G/B`, `diffuse.R/G/B`): each group is imported as a separate Verve layer within the same document. The layer name is set to the EXR layer group name, truncated to 64 characters.

**Export:**

1. The rasterization pipeline flattens the document to a `Float32Array` (unclamped, no tone-mapping).
2. The WASM encoder is called: `wasm.encodeExr(floatData, width, height, options)` → `Uint8Array` of EXR bytes.
3. The encoded bytes are sent to the main process via IPC for file system write.
4. Supported export options (exposed in the export dialog): compression type (none, zip, zips, piz); half-float channels (writes 16-bit float channels for smaller files, with a user-acknowledged precision trade-off).

**Constraints:**

- Import supports EXR scanline format only. Deep EXR (deep compositing) and tiled EXR are out of scope for V1.
- If an EXR file uses a codec not supported by the chosen library (e.g., B44, DWAA), the import **must** fail with a user-visible error: *“This EXR file uses an unsupported compression type and cannot be opened.”*
- Alpha handling: EXR files with pre-multiplied alpha are imported as-is. Verve does not un-premultiply on import.
- Multi-layer EXR name collisions after truncation are resolved by appending a numeric suffix (`_2`, `_3`, etc.).

### Radiance HDR (`.hdr`)

**Technology:** The Radiance HDR RGBE encoding is straightforward and **may be implemented entirely in TypeScript** (no WASM required), or in a small C++ helper under `wasm/src/`. RGBE is a shared-exponent format: each pixel stores R, G, B mantissa bytes and a shared exponent byte.

**RGBE decode formula (per pixel):**

```
if (E == 0) {
  r = g = b = 0.0
} else {
  scale = pow(2.0, E - 128.0 - 8.0)
  r = (R + 0.5) * scale
  g = (G + 0.5) * scale
  b = (B + 0.5) * scale
}
```

**RGBE encode formula (per pixel):**

```
maxc = max(r, g, b)
if (maxc < 1e-32) {
  R = G = B = E = 0
} else {
  [m, e] = frexp(maxc)      // m in [0.5, 1.0); m * 2^e = maxc
  scale = m / maxc * 256.0
  R = floor(r * scale)
  G = floor(g * scale)
  B = floor(b * scale)
  E = e + 128
}
```

**Import:**

1. Parse the Radiance HDR header (ASCII text, terminated by a blank line). Extract `WIDTH` and `HEIGHT` from the `FORMAT=32-bit_rle_rgbe` section.
2. Read scanlines; each scanline may use run-length encoding (RLE). Decode to RGBE quads.
3. Apply the RGBE decode formula to produce a `Float32Array` (R, G, B, A=1.0) of length `width × height × 4`.
4. Create a new `rgba32f` document.

**Export:**

1. Flatten to `Float32Array`. Negative values are clamped to `0.0` (RGBE cannot represent negatives); a console warning is emitted if any negatives were found.
2. Encode each pixel using the RGBE formula above.
3. Write the Radiance HDR header followed by RLE-compressed scanlines.

**Constraints:**

- Radiance HDR conventionally stores data in Rec. 709 primaries / linear light. Verve imports and exports it as untagged scene-linear, matching the EXR behavior.

### 32-Bit Float TIFF (`.tif`, `.tiff`)

**Technology:** Verve already uses the `utif` JavaScript library for TIFF I/O. The TIFF I/O path **must** be extended or replaced to handle 32-bit float TIFF files (`SAMPLEFORMAT = 3`, `BITSPERSAMPLE = 32`). Two approaches in order of preference:

1. **Extend `utif`**: Add float32 decode/encode support if the library structure permits.
2. **WASM libtiff**: Compile a minimal `libtiff` via Emscripten for robust multi-compression TIFF support.

**Import:**

1. Detect `SAMPLEFORMAT = 3` (IEEE floating point) and `BITSPERSAMPLE = 32` in the TIFF IFD.
2. Read strip or tile data as raw bytes; reinterpret each 4-byte group per channel as an IEEE 754 single-precision float, respecting the TIFF byte order field (`II` = little-endian, `MM` = big-endian).
3. If the TIFF is RGB (3 samples per pixel), set alpha to `1.0`. If RGBA (4 samples), use the fourth channel as alpha.
4. Create a new `rgba32f` document.

**Export:**

1. Flatten to `Float32Array`.
2. Write a TIFF IFD with `SAMPLEFORMAT = 3`, `BITSPERSAMPLE = 32`, `SAMPLESPERPIXEL = 4`, `PLANARCONFIG = Contig`. Use `COMPRESSION = 1` (none) as a spec-compliant baseline; optionally expose LZW or Deflate as export options.
3. Write strip data as raw float bytes in little-endian order.

**Constraints:**

- Multi-page (multi-layer) TIFF: out of scope for V1. Only the first IFD is imported; export writes a single IFD.
- 16-bit TIFF files (`BITSPERSAMPLE = 16`) continue to import as `rgba8` (quantized), as today.
- Color profile tags (`ICCProfile`, `ColorSpace`): read and silently ignored on import; not written on export.

---

## Acceptance Criteria

- When a document is converted to `rgba32f` mode, `GpuLayer.data` for every raster layer is a `Float32Array` and every layer's GPU texture format is `rgba32float`. Inspecting the texture description via the WebGPU API confirms `format: 'rgba32float'`.
- Opening a `.verve` file saved with `pixelFormat: "rgba32f"` correctly restores all layer `Float32Array` buffers. Each channel value round-trips without modification (no quantization or clamping is applied on load).
- A solid white layer at full HDR intensity (all channels = `2.0`) displays visibly on screen without producing a black or corrupt image. The Reinhard tone-map at 0 EV produces `2.0 / (2.0 + 1.0) ≈ 0.667` per channel, rendering as a visible light grey/white.
- Setting the preview exposure to +2 EV causes a pixel with raw value `0.25` to display as approximately `0.5` (Reinhard: `(0.25 × 4) / (0.25 × 4 + 1) = 0.5`). Adjusting the EV slider updates the canvas preview without modifying pixel data. After reset to 0 EV, the canvas returns to the baseline tone-mapped display.
- The EV slider is visible in the canvas toolbar when the document is `rgba32f`, and is hidden (not greyed out) when the document is `rgba8`.
- The brush tool paints float values in `[0.0, 1.0]` (normalized from the primary swatch at Intensity `1.0`). Sampling the painted pixel via `samplePixel` returns floats, not raw `[0, 255]` integers.
- Setting the color picker Intensity to `3.0` and painting with an RGB `(255, 0, 0)` swatch produces a pixel with `R ≈ 3.0` in `samplePixel`.
- Applying a Brightness/Contrast adjustment layer with extreme settings to a `rgba32f` document does not clamp intermediate values to `[0, 1]`. Pixel values outside `[0, 1]` survive through the adjustment compute pass.
- An eyedropper sample on a pixel with channel values `(1.5, 0.5, 0.2, 1.0)` sets the primary swatch to approximately `(255, 128, 51, 255)` (clamped and scaled), and the `HDR` overflow indicator is visible in the color picker.
- Flatten (`Merge Visible` → new layer) on a `rgba32f` document produces a `Float32Array` buffer. Channel values above `1.0` are preserved in the flattened result.
- After converting a `rgba32f` document to `rgba8`, a pixel that was `(1.8, 0.3, 0.0, 1.0)` becomes `(255, 77, 0, 255)`. Pressing Ctrl+Z restores the original float data.
- The status bar shows `RGB/32F` with a blue indicator in `rgba32f` mode. Pixel info hovering over the canvas shows four-decimal-place float values.
- Exporting an EXR from a `rgba32f` document produces a file that a third-party EXR viewer (e.g., Blender) reads without errors, with pixel values matching the Verve canvas to float32 precision.
- Importing the exported EXR back into Verve produces a pixel-identical `rgba32f` document (no clamping, no precision loss beyond float32 representation).
- Importing a Radiance `.hdr` file produces a `rgba32f` document whose decoded pixel values match a reference decode by another tool (e.g., Blender's HDR importer) within floating-point rounding tolerance.
- Importing a 32-bit float TIFF produces a `rgba32f` document with channel values matching the source TIFF to float32 precision.
- Exporting a `rgba32f` document to PNG triggers the HDR tone-mapping warning dialog. Confirming produces a valid PNG with Reinhard-at-0-EV applied.
- Saving a `rgba32f` document to `.verve` and reopening it produces a pixel-identical result: no clamping, no precision loss beyond float32 representation.

---

## Edge Cases & Constraints

### Negative Values

Values below `0.0` are legal in scene-linear data (e.g., from spectral reconstruction or certain EXR conventions). The pipeline **must not** clamp negative values during adjustments or compositing. However, Reinhard tone-mapping and Radiance HDR encoding are undefined for negatives; negative-channel pixels display as black in the tone-mapped preview and are clamped to `0.0` on Radiance HDR export (with a console warning). No special UI treatment is specified.

### Alpha Out of Range

Alpha values outside `[0.0, 1.0]` produce undefined behavior in the compositor. Tools **must** always write alpha in `[0.0, 1.0]`. File import code **must** clamp alpha to `[0.0, 1.0]` on load.

### Memory Usage

`rgba32f` layers use 4× the memory of `rgba8` layers (16 bytes/pixel vs. 4 bytes/pixel). A 4096×4096 canvas with 10 layers requires approximately 2.5 GB of GPU texture memory in `rgba32f` mode. If GPU texture allocation fails, the operation **must** be aborted with a user-visible error. Silent out-of-memory is not acceptable.

### Adjustment Layer Ping-Pong Textures

`AdjustmentEncoder` allocates private ping-pong textures for certain multi-pass effects (e.g., bloom, drop-shadow, halation). These internal textures must also use `rgba32float` in `rgba32f` mode. Failing to upgrade these textures causes precision truncation mid-pipeline.

### `rgba32float` Filtering Support

WebGPU requires the `'float32-filterable'` device feature to use bilinear sampling on `rgba32float` textures. If the device does not advertise this feature, point sampling (`nearest`) **must** be used for `rgba32float` textures in the composite pass. The renderer **must** check for this feature at initialization and select the appropriate sampler filter mode.

### Export to LDR Formats

When the user exports a `rgba32f` document to PNG, JPEG, WebP, or TGA, the export dialog **must** display a warning: *“This document contains HDR data. The exported image will be tone-mapped to 8-bit using Reinhard. Values above 1.0 will be compressed or clipped.”* The user must confirm. The tone-mapping applied at export time uses Reinhard at 0 EV (not the display preview’s current EV).

### Curves LUT Textures

The Curves adjustment uses a 256×1 `r8unorm` LUT texture to remap channel values. In `rgba32f` mode, a standard 8-bit LUT cannot address values outside `[0, 1]` with sufficient precision. The curves adjustment in `rgba32f` mode **should** interpolate the curve directly in float space rather than using the LUT, or use a higher-precision LUT (e.g., `r32float` with 1024+ entries). The functional requirement is that the curves adjustment must not introduce visible banding on values in the standard `[0, 1]` range and must not clamp HDR values to the LUT input domain.

### TIFF Byte Order

TIFF files may be big-endian (`MM` magic) or little-endian (`II` magic). The float channel decoder **must** respect the TIFF byte order field when reinterpreting bytes as `Float32` values, even though all target platforms are little-endian.

---

## Out of Scope

- **HDR monitor output / display-referred HDR** — outputting HDR10, HLG, or Dolby Vision signals to an HDR-capable display. The display preview is always LDR via tone-mapping.
- **Per-layer pixel formats** — all layers in a document share one pixel format. Mixed-format layer stacks are not supported.
- **16-bit integer or 16-bit float formats** (`rgba16`, `rgba16f`) — not included in this version.
- **Color management and ICC profiles** — `rgba32f` data is treated as untagged scene-linear values. Color space conversion and gamut mapping are out of scope.
- **CMYK document mode** — not applicable to this feature.
- **DDS BC6H decode** — importing GPU-compressed HDR textures. The BC6H decoder is a prerequisite handled by the [DDS Format Support](dds-format-support.md) spec; once decoded, the float data feeds into `rgba32f` via the standard import path.
- **Deep EXR / tiled EXR** — only scanline EXR format is supported in V1.
- **Multi-layer TIFF** — only the first TIFF IFD is imported; multi-page export is not supported.
- **ACES or other advanced tone-mapping operators** — Reinhard is the only display tone-map. ACES filmic or other operators are deferred to a later version.
- **Histogram overflow display** — showing out-of-range values in a histogram panel is a follow-on improvement.
- **Baking display tone-mapping into export** — the user cannot export a tone-mapped (EV-adjusted) version of the document. Export always writes raw float values.

---

## Related Features

- [Pixel Format Abstraction](pixel-format-abstraction.md) — defines the `pixelFormat` document property, Image → Color Mode menu, status bar labeling, and the conversion workflow this spec builds on.
- [DDS Format Support](dds-format-support.md) — DDS BC6H import decodes to float data that feeds into `rgba32f` documents.
- [WebGPU Compute Filters](webgpu-compute-filters.md) — filter compute pipeline that must be updated for `rgba32float` intermediate textures.
- [Unified Rasterization Pipeline](unified-rasterization-pipeline.md) — the flatten/merge/export pipeline that must return `Float32Array` in `rgba32f` mode.
- [Brightness/Contrast](brightness-contrast.md) — adjustment layer whose shader is directly affected by the color-channel clamp removal requirement.
- [Color Grading](color-grading.md) — adjustment that benefits from unclamped float arithmetic.
- [Curves](curves.md) — requires LUT precision upgrade in `rgba32f` mode.
