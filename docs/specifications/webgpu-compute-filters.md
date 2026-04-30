# WebGPU Compute Shader Filter Migration

## Overview

Several of Verve's image filters are currently executed by a C++/WASM module on the CPU. Because Verve mandates WebGPU as a hard runtime requirement, these filters are strong candidates for GPU execution via WebGPU compute shaders. This migration moves eleven filters — covering blur, sharpening, noise, dithering, and procedural rendering — entirely to compute shaders, deletes the corresponding C++ and WASM paths, and requires pixel-level output parity with the previous WASM implementations. No fallback to WASM is introduced: the WASM paths are removed outright. From the user's perspective, every migrated filter continues to behave exactly as before; the change is invisible.

## User Interaction

There is no new user interaction introduced by this migration. Users continue to apply each filter through the same Filters menu item, the same dialog controls, and the same Apply/Cancel workflow that the individual filter specifications describe. The only observable consequence of the migration, if it is successful, is faster filter execution — particularly for large canvases and high-radius blur operations.

## Migrated Filter Catalog

The following eleven filters are in scope for this migration. Each entry describes the filter's user-visible purpose and its input parameters as a reference for correctness validation.

### Gaussian Blur

Blurs the active layer by convolving it with a Gaussian function, producing a smooth, isotropic softening. Implemented as two separable passes: a horizontal convolution followed by a vertical convolution.

**Parameters:** Radius (1–250 px). A larger radius increases the degree of blur.

### Box Blur

Blurs the active layer by averaging each pixel with all pixels within a square neighbourhood of uniform weight. Produces a softer, slightly squarish blur compared to Gaussian.

**Parameters:** Radius (1–250 px). Kernel width = 2 × radius + 1.

### Motion Blur

Blurs each pixel by averaging samples taken along a straight line of configurable direction and length, simulating subject or camera motion during an exposure.

**Parameters:** Angle (0–360°), Distance (1–999 px). Samples are taken along the motion axis with clamp-to-edge handling at layer boundaries.

### Radial Blur

Blurs the active layer along either concentric arcs (Spin mode) or radial lines (Zoom mode) emanating from a user-defined centre point.

**Parameters:** Mode (Spin/Zoom), Amount (1–100), Quality (Draft/Good/Best), Centre X and Y (0–100%, defaults to canvas centre). In Spin mode Amount maps to a rotation angle; in Zoom mode it controls the number of radial sample steps.

### Lens Blur

Blurs the active layer using a polygonal aperture-shaped kernel, simulating out-of-focus bokeh produced by a camera lens. The kernel is large (O(n · k²) where k = 2 × radius + 1), making this a primary beneficiary of GPU parallelism.

**Parameters:** Radius (1–100 px), Blade Count (3–8), Blade Curvature (0–100), Rotation (0–360°). When Blade Curvature is 100 the aperture is a perfect circle and Blade Count has no visible effect.

### Sharpen

Applies a fixed 3 × 3 sharpening convolution to the active layer immediately, with no dialog. The kernel has a centre weight of 5, cardinal-neighbour weights of −1, and corner weights of 0, producing a moderate edge enhancement.

**Parameters:** None. Instant-apply.

### Sharpen More

Applies a stronger fixed 3 × 3 sharpening convolution immediately, with no dialog. The kernel has a centre weight of 9 and all eight surrounding neighbour weights of −1.

**Parameters:** None. Instant-apply.

### Unsharp Mask

Sharpens the active layer by computing the difference between the original pixels and a Gaussian-blurred version, amplifying that difference by a user-specified amount, and adding the result back to the original. Pixels whose original-to-blurred difference falls below the Threshold are not sharpened.

**Parameters:** Amount (1–500%), Radius (1–64 px), Threshold (0–255 levels).

### Smart Sharpen

A more precise sharpening filter that removes a specific type of blur (Gaussian or Lens Blur / Laplacian) rather than applying a generic unsharp mask. Includes an optional noise-reduction step that suppresses sharpening in areas of low-contrast noise before the sharpening pass runs.

**Parameters:** Amount (1–500%), Radius (1–64 px), Reduce Noise (0–100%), Remove (Gaussian Blur / Lens Blur).

### Add Noise

Applies independent random per-pixel colour or luminance variation to the active layer, drawn from a Uniform or Gaussian-approximated distribution. Monochromatic mode applies the same delta to all three RGB channels; colour mode applies independent deltas per channel.

**Parameters:** Amount (1–400%), Distribution (Uniform/Gaussian), Monochromatic (on/off). A fixed random seed is generated per invocation so that the previewed result matches the applied result.

### Film Grain

Overlays a spatially-correlated grain texture onto the active layer by generating a fractional Brownian motion (fBm) noise field, optionally blurring it (controlled by Grain Size), scaling it by Intensity, and applying luminance-weighted attenuation controlled by Roughness. Grain is heavier in shadow areas when Roughness is 0 and uniform at 50.

**Parameters:** Grain Size (1–100), Intensity (1–200%), Roughness (0–100). A fixed random seed is generated per invocation.

### Clouds

Generates a procedural 6-octave fBm value-noise cloud pattern and composites it onto the active layer at a configurable opacity. Operates without reading any existing image data for the noise generation step; the Opacity parameter blends the generated pattern over the existing layer pixels. The Seed parameter guarantees reproducible output.

**Parameters:** Scale (1–200), Opacity (1–100%), Color Mode (Grayscale / Color using active foreground and background colours), Seed (0–9999).

### Bayer Dithering

Applies ordered (Bayer matrix) dithering to the active layer, reducing each pixel's colour depth by quantising each channel against a threshold matrix. Operates per-pixel and per-channel without reading neighbouring pixels, making it fully parallel and an ideal compute workload.

**Parameters:** Matrix Size (2, 4, or 8), selecting the standard 2 × 2, 4 × 4, or 8 × 8 Bayer threshold matrix.

---

## Functional Requirements

### Scope of migration

- All eleven filters listed in the Migrated Filter Catalog **must** be re-implemented as WebGPU compute shaders in `src/webgpu/`.
- The corresponding C++ implementations in `wasm/src/filters.cpp`/`filters.h` and the Bayer dithering entry in `wasm/src/dither.cpp`/`dither.h` **must** be deleted once each migrated filter's compute shader passes parity validation.
- Any exported WASM symbols for the migrated operations **must** be removed from `wasm/src/pixelops.cpp` and from the `-sEXPORTED_FUNCTIONS` list in `wasm/CMakeLists.txt`.
- The TypeScript call sites that previously invoked the WASM wrappers for these operations **must** be updated to call the WebGPU compute dispatch path instead. No call site **must** retain a conditional branch that falls back to WASM.
- After the migration, `wasm/src/filters.cpp` and `wasm/src/filters.h` **must** contain no functions corresponding to the eleven migrated operations. These files **may** continue to exist if other non-migrated filter operations remain in them.

### No fallback

- WebGPU is a hard runtime requirement for Verve. No WASM fallback path **must** be introduced for any of the eleven migrated filters.
- If a WebGPU compute dispatch fails at runtime, the operation **must** surface an error to the user. It **must not** silently fall back to a CPU/WASM path or silently no-op.

### Parity

- Each migrated filter **must** produce output that is pixel-identical to the output the former WASM implementation produced for the same parameters and input pixels, within a maximum tolerance of 1 ULP per channel (0–1 integer difference per 8-bit channel) arising from floating-point rounding differences between GPU and CPU arithmetic.
- Parity **must** hold for the full parameter range of each filter (not only default values).
- Parity **must** hold when a selection mask is active (only masked pixels are modified) and when no selection is active (all pixels on the layer are processed).
- The Clouds, Add Noise, and Film Grain filters **must** produce the same output for any given Seed value and parameter set, regardless of whether the compute shader or the former WASM path generates it, within the 1 ULP tolerance.

### Filter pipeline integration

- Each migrated filter **must** be invocable from the same call sites as today: the filter dialog's Apply action and the instant-apply menu handler for Sharpen and Sharpen More.
- Each migrated filter **must** participate in the unified rasterization pipeline for flatten, export, and merge paths — its compute pass **must** be expressible as a render-plan entry so compositing parity is preserved.
- The debounced canvas preview path for each parametric filter **must** execute the WebGPU compute pass, not a separate preview-only code path.

### Selection masking

- All eleven migrated filters **must** respect the active selection mask. When a selection is present, only pixels within the selection boundary **must** be written to the output layer. Pixels outside the selection **must** remain byte-for-byte unchanged.
- When no selection is active, the compute pass **must** process the entire layer.

## Acceptance Criteria

### Migration completeness

- The eleven WASM entry points for the migrated operations no longer exist in the compiled WASM binary after a clean `npm run build:wasm`.
- Each filter dialog's Apply action dispatches a WebGPU compute pass and does not call any WASM function.
- No conditional branch in the TypeScript filter layer selects between a WASM path and a WebGPU path for any of the eleven migrated filters.

### Parity validation (per migrated filter)

- A parity test renders each filter at default parameters against a fixed reference image using both the legacy WASM output (captured before deletion) and the new compute shader output. The maximum per-pixel, per-channel difference **must** not exceed 1.
- Parity tests pass at the parameter extremes (minimum and maximum values for each control).
- Parity tests pass with an active rectangular selection occupying approximately 50% of the canvas.
- For Clouds, Add Noise, and Film Grain: parity tests confirm that seed 0 and seed 9999 each produce the same pixel output as the reference WASM capture.

### Correctness of individual filters

- Gaussian Blur at radius 0 **must** be rejected or clamped to radius 1. Radius 250 on a 4000 × 3000 px canvas completes without error or timeout.
- Box Blur produces a uniformly weighted average across the kernel area, distinguishable from Gaussian Blur in that it has a flat (non-bell-curve) profile.
- Motion Blur at Angle 0°, Distance 20 produces a horizontal streak. At Angle 90°, Distance 20 produces a vertical streak.
- Radial Blur in Spin mode, Amount 50 produces visible arc-shaped smearing away from the centre; pixels at the exact centre are unblurred.
- Lens Blur at Blade Count 6, Blade Curvature 0 produces hexagonal bokeh discs. At Blade Curvature 100 the discs are circular regardless of Blade Count.
- Sharpen and Sharpen More produce immediately visible edge enhancement on a layer with fine detail; no dialog is shown.
- Unsharp Mask at Threshold 255 produces no sharpening (all pixels are below the threshold). At Threshold 0 and Amount 200, sharpening is clearly stronger than at Amount 100.
- Smart Sharpen in Gaussian mode at Reduce Noise 0 produces output equivalent to Unsharp Mask for the same Amount and Radius.
- Add Noise at Monochromatic on produces grayscale noise (R = G = B delta); at Monochromatic off, the three channels differ.
- Film Grain at Grain Size 1 produces per-pixel noise; at Grain Size 50 the grain is visibly clustered and soft.
- Clouds at Seed 42 produces the same image regardless of how many times the filter is applied with identical parameters.
- Bayer Dithering at Matrix Size 8 produces a finer, less visually regular pattern than at Matrix Size 2.

### No regressions

- Flatten Image, export to PNG/JPEG/WebP, and merge-down operations produce pixel-identical output before and after the migration for documents that include layers with these filters applied.
- Undo records one entry per filter application; pressing Cmd+Z / Ctrl+Z once restores the layer to its exact pre-filter state.

## Out of Scope

The following WASM operations **must not** be migrated in this effort and **must** remain in C++/WASM:

- **Floyd-Steinberg dithering** (`dither_floyd_steinberg`) — error diffusion has sequential data dependencies between pixels that make it unsuitable for a GPU compute pass without significant algorithmic restructuring.
- **Flood Fill** (`fill.cpp`) — scanline flood fill has branching data-dependent memory access patterns that do not map efficiently to GPU compute.
- **Colour Quantization** (`quantize.cpp`) — palette generation and nearest-neighbour palette mapping require iterative CPU-friendly algorithms (e.g. median cut, k-means).
- **Resize** (`resize.cpp`) — image resampling during canvas resize operations is handled separately from the filter pipeline and is not in scope.
- **Curves / Histogram** (`curves_histogram.cpp`) — curves evaluation is already handled by the WebGPU adjustment compute pass introduced in the WebGPU Migration; no second migration is needed.

The following items are also out of scope:

- **Non-destructive filter layers** — all eleven migrated filters remain destructive (baked into layer pixels). A non-destructive parametric filter system is a separate future feature.
- **Remove Motion Blur** — this filter (`filters_remove_motion_blur`) uses iterative Richardson-Lucy deconvolution, which has different parallelisation characteristics. It is not included in this migration.
- **New filter parameters or UI changes** — this migration must not change any filter's parameter ranges, defaults, or dialog layout. The user-visible contract of each filter is frozen.
- **Performance benchmarking or optimization** — compute shader correctness and parity are the primary deliverables; throughput improvements are a welcome side effect, not a requirement.

## Edge Cases & Constraints

- **Large kernels**: Lens Blur at radius 100 produces a 201 × 201 kernel. The compute shader dispatch strategy (tile size, shared memory usage) must handle this without exceeding WebGPU storage buffer or workgroup size limits.
- **Gaussian / Box Blur ping-pong**: Separable blur passes require an intermediate texture or buffer. The compute shader implementation must not read and write the same texture in the same pass.
- **Noise seeds**: Add Noise, Film Grain, and Clouds must lock in a seed at the moment the preview is computed and reuse that same seed for the Apply pass. A different seed must produce visually different output.
- **Bayer Dithering on non-opaque layers**: The Bayer threshold is applied per channel; the alpha channel is not dithered or otherwise modified.
- **Selection boundary precision**: Selection mask evaluation at Apply time must be consistent between the WASM path and the compute path. The same selection mask data is passed to both paths.
- **Clouds with Color mode**: The foreground and background colours sampled at Apply time must be the same colours used during the most recent preview. If the user changes colours while the Clouds panel is open, the preview must update.

## Related Features

- [gaussian-blur.md](gaussian-blur.md) — full specification for the Gaussian Blur filter UX and requirements
- [radial-blur.md](radial-blur.md) — full specification for the Radial Blur filter
- [motion-blur.md](motion-blur.md) — full specification for the Motion Blur filter
- [noise-filmgrain-lensbur-clouds.md](noise-filmgrain-lensbur-clouds.md) — full specifications for Add Noise, Film Grain, Lens Blur, and Clouds
- [sharpening-filters.md](sharpening-filters.md) — full specifications for Sharpen, Sharpen More, Unsharp Mask, and Smart Sharpen
- [unified-rasterization-pipeline.md](unified-rasterization-pipeline.md) — the compositing pipeline that migrated filters must integrate with for flatten and export
- [webgpu-migration.md](webgpu-migration.md) — the renderer migration from WebGL2 to WebGPU that this migration builds on
