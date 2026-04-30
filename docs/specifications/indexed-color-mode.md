# Indexed Color Mode

## Overview

Indexed Color Mode is the user-facing layer built on top of the `indexed8` pixel format defined in the [Pixel Format Abstraction](pixel-format-abstraction.md) spec. When a document is in `indexed8` mode, every raster pixel is stored as a single byte — an index into the document's swatch palette — rather than as four RGBA channels. Drawing tools write palette indices instead of blended color values, the eyedropper resolves pixels to their palette entry, and export expands indices back to RGBA at output time.

The primary use cases are **pixel art**, **retro game asset production**, and **any palette-constrained workflow** where color discipline is enforced at the data level rather than by convention. Because pixels store indices rather than raw colors, editing a swatch immediately relinks every pixel that uses it across all layers — no repainting required. The mode enforces the palette constraint by restricting drawing tools to index writes, disabling adjustment layers and effects, and replacing the free-form color picker with a palette-only grid.

This spec covers the user-facing behavior of Indexed Color Mode: how users draw, erase, sample, and export in this mode; how the palette relationship works over time; and how the mode interacts with layer operations. It does not re-specify the pixel format architecture, compositor behavior, conversion pipeline, or `.verve` file format — those are fully defined in the [Pixel Format Abstraction](pixel-format-abstraction.md) spec.

---

## User Stories

- **As a pixel artist**, I want every pencil stroke to write an exact palette index so that my image is never contaminated with off-palette colors I did not intend.
- **As a pixel artist**, I want to click a pixel on the canvas with the eyedropper and immediately draw with the same palette color, with no color-matching guesswork.
- **As a pixel artist**, I want to swap a palette color in the Swatches panel and see every pixel that uses that index update on screen immediately, without having to repaint anything.
- **As a retro game developer**, I want to build a sprite sheet against a strictly limited palette so I can later map the swatch list to hardware palette registers with a known index-to-color correspondence.
- **As any user**, I want to export a palette-indexed document as a standard PNG I can use anywhere, with all colors expanded to their full RGBA values.
- **As any user**, I want the color picker to show only palette entries in indexed mode so I cannot accidentally draw with a color that is not in the palette.

---

## Functional Requirements

### Entering and Leaving Indexed Mode

The pixel format is a document-wide property. To enter Indexed Color Mode, the user opens **Image → Color Mode → Indexed/8**. To leave, they select **Image → Color Mode → RGB/8** (or RGB/32 Float). The confirmation dialog, conversion behavior, undo history entry, and all architectural rules for these transitions are defined in [Pixel Format Abstraction](pixel-format-abstraction.md).

- Entering `indexed8` **must** be blocked with an error if the swatch palette is empty: *"The swatch palette must contain at least one color before converting to Indexed/8 mode."*
- On entering `indexed8`, the status bar label **must** update to `Indexed/8`.

---

### The Palette

In `indexed8` mode, the document palette is exactly the **swatch palette** — the ordered list of colors displayed in the Swatches panel. Palette index 0 refers to the first swatch, index 1 to the second, and so on. The palette is document-scoped and shared by all pixel layers in the document.

- The palette **must** be the same ordered list that drives the Swatches panel. There is no separate indexed-mode palette; the swatches are the palette.
- A valid indexed document **must** have at least 1 swatch. Deleting all swatches while in `indexed8` mode **must** be blocked, and an error must be shown: *"Cannot remove all swatches while in Indexed/8 mode. At least one palette entry is required."*
- Removing a swatch that is not the last one **shifts all subsequent indices** by −1. This means existing layer pixel data may no longer refer to the same colors after a removal. The application **must** warn the user before any swatch deletion that would shift existing indices: *"Removing this swatch will shift palette indices in all pixel layers. This operation can be undone."* The user confirms or cancels.
- Adding a swatch appends it to the end of the palette. Existing indices are unaffected.
- Reordering swatches (drag-and-drop in the Swatches panel) **must** be blocked in `indexed8` mode because it would invalidate all layer index data without a conversion step. The drag-and-drop reorder handle in the Swatches panel **must** be non-interactive (visually disabled) while the document is `indexed8`.
- Modifying a swatch color (changing its RGB or alpha value) **must** take effect immediately: all indexed layers referencing that palette entry **must** re-render with the new color within the same frame. The CPU-side index data is unchanged; only the GPU texture is re-uploaded.

---

### The Transparent/Void Index (255)

Index value **255** is reserved as the transparent/void sentinel for all `indexed8` documents. It is not a regular palette entry and cannot be assigned a color.

- When rendered, index 255 **must** always produce a fully transparent pixel (`{r:0, g:0, b:0, a:0}`), regardless of the palette size or contents.
- The eraser writes index 255 to every pixel it covers. There is no user-configurable "eraser color" in indexed mode — the eraser always writes the void sentinel.
- When a new pixel layer is created in `indexed8` mode, **all pixels must be initialized to 255**. A blank layer is entirely void/transparent.
- Index 255 can appear in layer data from three sources: direct eraser use, new layer initialization, or conversion from `rgba8` where a source pixel was fully transparent (`a === 0`).
- Index values in the range [palette length, 254] inclusive (stale indices from a palette that has shrunk) also render as fully transparent but represent an abnormal state. Normal swatch removal remapping prevents this from arising in well-formed documents.

---

### Color Resolution: Active Color → Palette Index

Drawing tools in `indexed8` mode do not write RGBA values. They write palette indices. Before any drawing operation begins, the tool resolves the active color (primary or secondary swatch) to a palette index using the following algorithm:

1. Take the active color as `{r, g, b, a}` (the current primary or secondary color, as integers 0–255).
2. Search all entries in the current swatch palette.
3. Compute the squared Euclidean distance in RGBA space for each entry: `Δ = (r2−r1)² + (g2−g1)² + (b2−b1)² + (a2−a1)²`.
4. Write the index of the entry with the smallest distance. On a tie, use the lower index.

This resolution **must** happen once at the start of a stroke (on `pointerdown`), not per pixel. The resolved index is cached for the duration of the stroke. If the user lifts the pen and begins a new stroke, the color is resolved again.

- If the active primary (or secondary) color is an exact member of the current swatch palette, its exact index **must** be used — no snapping occurs. Exact matching is defined as all four `r, g, b, a` channels being byte-for-byte equal.
- If the active color is not an exact palette member, the tool **must** snap to the nearest palette entry and write that index. The tool **must not** auto-add the color to the palette. The user is not notified of the snap during drawing (it would be too noisy), but the color indicator in the top-left of the canvas area should reflect the snapped palette color rather than the raw primary color after the first stroke begins.
- This nearest-index resolution applies to the **primary** color (left mouse / pen tip) and the **secondary** color (right mouse / barrel button) equally. Drawing with the secondary color writes the secondary color's nearest palette index.

---

### Color Picker in Indexed Mode

When the document is in `indexed8` mode, the primary and secondary color pickers **must not** show the standard RGBA wheel, slider, or hex-entry UI. Instead, they show a **palette-only picker**: a grid of swatches drawn from the current document palette.

- The palette picker **must** replace the standard color picker UI for both primary and secondary color slots whenever the document pixel format is `indexed8`.
- Each cell in the grid corresponds to one palette entry (one swatch), displayed in palette index order (index 0 first).
- Clicking a cell sets the corresponding color as the active primary (or secondary) color and dismisses the picker.
- The picker **must not** include any free-form color entry control (hex field, hue ring, saturation/brightness gradient, RGBA sliders). The user cannot express a color that is not in the palette through this picker.
- If the user opens the color picker while in `indexed8` mode (via the toolbar swatch squares or any other affordance), the palette-only grid **must** appear in place of the normal picker.
- The active color indicator in the toolbar (primary/secondary swatch squares) **must** always display the actual palette RGBA for the currently resolved index, not the raw primary color if it happens to be off-palette.
- After completing a stroke that snapped the active color to the nearest palette entry, the active color indicator **must** update to reflect the snapped palette color. The off-palette value is discarded.

---

### Pencil Tool in Indexed Mode

The pencil (tool ID `'pencil'`) is the primary drawing tool in `indexed8` mode.

- The pencil **must** write a single palette index per pixel. Each pixel in a stroke is set to the resolved primary palette index.
- The pencil **must** operate with a **hard edge** only. Anti-aliasing is forced off in `indexed8` mode regardless of the `pencilOptions.antiAlias` flag. Fractional coverage values are not meaningful when each pixel stores a single discrete index.
- Opacity is forced to 100% in indexed mode. The pencil `opacity` option has no effect; partial-transparency blending is undefined for index values. The opacity control **must** be grayed out in the tool options bar when the document is `indexed8`.
- The pencil `smoothing` (stroke stabilizer) option **remains active** in indexed mode. Stabilization affects the input coordinates fed to the stroke algorithm, not the per-pixel color blending, so it is meaningful and desirable.
- Pixel-perfect mode (`pencilOptions.pixelPerfect`) **remains active** in indexed mode. It removes L-corner artifacts by erasing corner pixels at diagonal direction changes — corner pixels receive index 255 (the void sentinel) rather than the drawing color.
- Pixel brush stamps (`pencilOptions.pixelBrush`) **are supported** in indexed mode. Each RGBA pixel in the brush template is resolved to its nearest palette index (using the same RGBA Euclidean algorithm above) at stamp time. Transparent pixels in the brush template (`a === 0`) are skipped, leaving the existing index at that position unchanged. The per-pixel palette resolution is computed once per stamp instance and is not cached between distinct pointer events.
- The pencil size option **must** remain active in indexed mode. Size 1 draws single pixels; larger sizes stamp the configured shape, with each covered pixel receiving the resolved index.
- Within a single stroke, each pixel is written exactly once — the first time the stamp covers it. Re-covering the same pixel within the same stroke does **not** overwrite it a second time. This matches the stroke coverage behavior used in rgba8 mode to prevent re-application of the same index value.

---

### Eraser Tool in Indexed Mode

The eraser writes the transparent/void sentinel (index **255**) to every pixel it covers.

- The eraser **must** write index **255** to all pixels within its brush footprint.
- The eraser **must** operate with a hard edge in `indexed8` mode (no anti-aliasing, no partial coverage).
- Eraser opacity and hardness controls **must** be grayed out in the tool options bar in indexed mode. These options have no meaning when writing a fixed index.
- Eraser size **must** remain active.
- The eraser is the only tool that unconditionally writes index 255. Drawing with a secondary color that happens to be off-palette does not produce index 255 — the nearest-palette-index algorithm is still applied to secondary color strokes.

---

### Fill Tool in Indexed Mode

The flood-fill tool fills a contiguous region with the resolved primary palette index.

- The fill **must** perform a standard flood-fill starting from the clicked pixel, comparing neighbor pixel indices (not RGBA values, since the layer stores indices).
- Two pixels are considered contiguous if they share the same index value and are 4-connected (not 8-connected, unless a "contiguous" tolerance option is added in a later spec).
- The fill tolerance setting (if exposed) operates on palette index identity: pixels with the same index are in the same region. Tolerance-based color distance fills are not applicable in indexed mode.
- Fill with the secondary color (right-click) writes the secondary color's resolved palette index.

---

### Eyedropper in Indexed Mode

The eyedropper samples the palette index of the clicked pixel, then activates the corresponding palette entry.

- On a click, the eyedropper **must** read the raw index value stored at the clicked canvas position. It does not read the expanded RGBA composite; it reads the index directly from the CPU-side `GpuLayer.data` of the topmost visible pixel layer at that position.
- After reading the index, the eyedropper **must**:
  1. Look up the RGBA color for that index in the current swatch palette.
  2. Set the primary color (foreground) to that RGBA value.
  3. Select (activate) the corresponding swatch in the Swatches panel, so the user can see which palette entry they sampled.
- If the sampled index value is 255 (the void sentinel) or is out of range (exceeds the current palette length), the eyedropper **must** set the primary color to fully transparent (`{r:0, g:0, b:0, a:0}`) and deactivate the swatch selection.
- Alt+eyedropper (sampling the secondary color) follows the same logic but sets the secondary color and does not change the active swatch highlight.
- In `indexed8` mode, the eyedropper always samples the topmost visible indexed layer at the clicked position. It does **not** sample the composited RGBA display image — it reads the raw index to guarantee lossless round-tripping.

---

### Selection Tools

All selection tools are **fully available** in `indexed8` mode without behavioral changes.

- Rectangular Select, Elliptical Select, Lasso, Polygonal Selection, Magic Wand, and Object Selection function identically to `rgba8` mode.
- Selection masks store grayscale binary alpha data at canvas resolution, separate from the indexed pixel layers. They are unaffected by the pixel format.
- Magic Wand contiguous selection in `indexed8` mode: the application **should** compare neighbor pixels by index value (same index = same region) rather than by RGBA distance. This produces semantically accurate behavior for indexed documents. Tolerance-based RGBA distance is not applicable.
- Tools that respect the active selection (pencil, eraser, fill) continue to do so in indexed mode. Selection masks gate which pixels receive the drawn index value.

---

### Move, Free Transform, and Crop

- **Move**: moves the pixel layer by offset. The index data moves with the layer unchanged.
- **Free Transform**: scales, rotates, and skews the layer. Destination pixel indices are determined by **nearest-neighbor sampling only**. Bilinear or bicubic interpolation of index values is not defined — intermediate values would be meaningless indices. Nearest-neighbor must be forced regardless of any global resampling quality setting while in `indexed8` mode.
- **Crop**: trims or expands the canvas bounds. Pixels discarded by a crop are permanently removed from the layer. New pixels introduced when the canvas grows (outward crop) are initialized to index **255** (void/transparent).

---

### Layer Operations in Indexed Mode

#### New Layer

- A new pixel layer created in `indexed8` mode **must** have all pixels initialized to **255** (the void sentinel). The layer is entirely transparent.
- Duplicate Layer produces a byte-exact copy of the source layer's index data. No re-resolution occurs.

#### Merge Layers and Flatten Image

Merge Selected, Merge Down, and Flatten Image must all produce a result in `indexed8` format.

- The merge algorithm expands all input indexed layers to RGBA using the current palette, composites them using Porter-Duff `over` at full precision, then **quantizes the composited result back to palette indices** using the same RGBA Euclidean nearest-index algorithm used by drawing tools.
- **No dithering** is applied during merge quantization in this version.
- Pixels that composite to fully transparent (`a === 0`) are written as index **255** in the output layer.
- Adjustment and effect layers that are suspended in `indexed8` mode are **skipped** during merge/flatten. Their effects are not included in the composited output.
- The result layer is stored as a `Uint8Array` of palette indices, like any other `indexed8` pixel layer.

---

### Live Palette Relinking

Because layer data stores indices rather than colors, palette changes are reflected in the on-screen image immediately without any layer data modification.

- When any swatch color is edited (its RGBA value changes), all pixel layers **must** re-render with the new color in the same frame. No layer data is modified; only the GPU texture for affected layers is re-uploaded.
- When a swatch is added at the end of the palette, existing indices are unchanged. The new swatch becomes available for future drawing strokes.
- When a swatch is removed (after the user confirms the warning described above):
  - All indices in all pixel layers that referred to the removed swatch **must** be remapped to index 255 (the void sentinel).
  - All indices in all pixel layers that referred to any swatch with a higher index **must** be decremented by 1 to account for the palette shift.
  - This remapping **must** be applied atomically as a single CPU-side pass over all pixel layer data before re-uploading to the GPU.
  - The remapping **must** be recorded as a single undo history entry alongside the swatch removal. Pressing Ctrl+Z restores both the swatch list and the layer pixel data in a single undo step.
- Swatch reorder operations are blocked in indexed mode (see Palette section above).

---

### "Snap to Palette" Conversion

The conversion from `rgba8` (or `rgba32f`) to `indexed8` quantizes every pixel to the nearest palette entry. The full details of the conversion algorithm are specified in [Pixel Format Abstraction](pixel-format-abstraction.md). The following indexed-mode-specific behaviors apply:

- **No dithering is applied** during the `rgba8` → `indexed8` conversion. Each pixel is mapped to the nearest palette entry by RGBA Euclidean distance with no error diffusion. This is intentional; the [Color Dithering](color-dithering.md) adjustment layer is the recommended tool for dithered palette reduction in `rgba8` mode before converting.
- After conversion, all fully transparent pixels (`a === 0`) in the source image **must** be mapped to index **255** (the void sentinel), regardless of their RGB values.
- Partially transparent pixels (`0 < a < 255`) are treated like any other pixel for nearest-color matching (the alpha channel participates in the distance calculation).

---

### PNG Export in Indexed Mode

When the user exports an `indexed8` document to PNG (via **File → Export As → PNG**), the exported file is a standard 32-bit RGBA PNG. No indexed PNG or palette-chunk PNG format is produced.

- The exporter **must** expand every pixel index to its RGBA color using the current swatch palette at export time.
- Index values out of range (≥ palette length) **must** be exported as fully transparent (`{r:0, g:0, b:0, a:0}`).
- The exported PNG **must** be visually identical to what the user sees on the canvas at the time of export.
- The standard export flow, export dialog, and all other export options (resolution, crop to selection, etc.) apply identically to `indexed8` documents as they do to `rgba8` documents.
- Indexed PNG format (with a `PLTE` chunk) is **not** produced by this feature and is explicitly deferred.

### Other Export Formats in Indexed Mode

- **JPEG** export from `indexed8` is supported via the same expansion path as PNG (indices → RGBA, then JPEG encode). JPEG does not support alpha; the alpha channel is composited against white before encoding, matching the behavior for `rgba8` JPEG export.
- **WebP**, **TIFF**, and **TGA** export follows the same expansion-then-encode pattern.
- **`.verve` save** preserves the raw index data natively as defined in [Pixel Format Abstraction](pixel-format-abstraction.md).

---

### Disabled Tools and Features in Indexed Mode

The following tools and features are **unavailable** in `indexed8` mode. Their toolbar buttons and menu items **must** be visually grayed out and non-interactive. Clicking a grayed-out toolbar button or pressing its keyboard shortcut **must** produce no tool switch and **must** show a tooltip: *"[Tool name] is not available in Indexed/8 mode."* The Adjustments, Effects, and Filters menus must show the same tooltip on hover over any item while in indexed mode.

| Disabled Feature | Reason |
|---|---|
| Brush (advanced: opacity, softness, flow, blending modes) | Requires per-pixel alpha blending; incompatible with discrete index writes. |
| Gradient tool | Produces continuous color ramps that cannot be represented as indexed values without per-pixel quantization, which the gradient tool does not perform. |
| Clone Stamp | Reads and writes RGBA composite data; semantics are undefined for index buffers. |
| Dodge | Operates on RGBA luminance values, incompatible with index storage. |
| Burn | Same as Dodge. |
| All Adjustment Layers (Adjustments and Effects menus) | Adjustment layers operate on RGBA color channels and have no meaning applied to a palette index. Defined in [Pixel Format Abstraction](pixel-format-abstraction.md). |
| All Filter Adjustment Layers (Filters menu) | Same as adjustment layers. |
| Layer mask creation | Layer masks store grayscale alpha values; the semantics do not compose with indexed layer data. Deferred to a future spec. |
| Text tool | Text layers render RGBA glyphs; they are not index-pixel layers. Text layers can still exist in the stack alongside indexed pixel layers, but creating new text layers is disabled. |
| Shape tool | Same as text. |

The following tools remain **available** in `indexed8` mode without modification to their interaction model:
- Pencil (modified behavior as above)
- Eraser (modified behavior as above)
- Fill (modified behavior as above)
- All selection tools (Rectangular Select, Lasso, Polygonal Selection, Magic Wand, Object Selection)
- Move
- Free Transform
- Crop
- Eyedropper (modified behavior as above)
- Hand
- Zoom

---

### Tool Options Bar in Indexed Mode

When the document is `indexed8`, the tool options bar **must** reflect the constraints of the mode:

- **Pencil**: opacity slider is grayed out and displays 100%. Anti-alias toggle is grayed out and appears unchecked. All other options (size, pixel-perfect, smoothing, pixel brush gallery) remain active.
- **Eraser**: opacity and hardness controls are grayed out. Size remains active.
- **Fill**: tolerance control remains active (for index-equality region growing). Anti-alias toggle is grayed out.

---

### Status Bar

The status bar **must** display `Indexed/8` as the document mode label when `pixelFormat === 'indexed8'`. This is inherited from the [Pixel Format Abstraction](pixel-format-abstraction.md) spec and requires no additional behavior in this spec.

---

## Error States

| Trigger | Required behavior |
|---|---|
| Attempting to enter `indexed8` with an empty swatch palette | Blocked. Error: *"The swatch palette must contain at least one color before converting to Indexed/8 mode."* |
| Attempting to delete the last swatch while in `indexed8` mode | Blocked. Error: *"Cannot remove all swatches while in Indexed/8 mode. At least one palette entry is required."* |
| Attempting to delete a non-last swatch while in `indexed8` mode | Warning dialog: *"Removing this swatch will shift palette indices in all pixel layers. This operation can be undone."* Confirm / Cancel. |
| Attempting to add a 256th swatch while in `indexed8` mode | Blocked. Error: *"Indexed/8 mode supports a maximum of 255 palette entries. Index 255 is reserved as the transparent value."* |
| Clicking a disabled tool's button or using its keyboard shortcut in `indexed8` mode | No action. Tooltip: *"[Tool name] is not available in Indexed/8 mode."* |
| Hovering over any Adjustments, Effects, or Filters menu item in `indexed8` mode | Tooltip: *"Adjustments are not available in Indexed/8 mode."* |
| Opening the color picker while in `indexed8` mode | Palette-only swatch grid shown instead of standard RGBA picker. No free-form color entry is accessible. |
| Palette shrinks (swatch removed) leaving residual stale indices | Remapping pass on swatch removal prevents this in normal use. If stale indices exist (e.g., in an externally edited file), they render as fully transparent. No error shown at render time; only a visible blank pixel is produced. |

---

## Acceptance Criteria

- With a fresh `indexed8` document and a 4-color palette, drawing a pencil stroke produces pixels that are exactly one of the 4 palette indices when inspected in the raw layer data.
- Drawing with a primary color that does not exactly match any swatch maps to the nearest swatch index (by RGBA Euclidean distance). No new swatch is added to the palette.
- Drawing with the eraser replaces pixels with index 255 (the void sentinel). After erasing, those pixels render as fully transparent on screen.
- Editing a swatch color in the Swatches panel immediately changes the on-screen appearance of all pixels carrying that palette index. No layer data modification occurs.
- The eyedropper clicked on a pixel correctly sets the primary color to that pixel's palette RGBA value and selects the corresponding swatch in the Swatches panel.
- The eyedropper does not sample the composited RGBA display — clicking on a pixel that shares the same display color as another palette entry always returns the index of the layer's stored value, not the nearest-color match.
- Attempting to remove the last swatch in `indexed8` mode is blocked with an error message.
- Removing a swatch (after confirming the warning) remaps all pixels that used that index to index 255, and decrements all higher-indexed pixels by 1. Pressing Ctrl+Z restores both the swatch list and all layer pixel data.
- Swatch drag-to-reorder is non-interactive in indexed mode.
- Converting from `rgba8` to `indexed8` with a 4-color palette produces a layer where every pixel's stored value is 0, 1, 2, or 3. No value outside this range (except 255 for pixels that were fully transparent in the source) appears in the converted layer data.
- Converting from `indexed8` back to `rgba8` produces a layer where each pixel's RGBA value matches the RGBA of the palette entry it was mapped to at conversion time. Pixels that were index 255 become fully transparent RGBA.
- Exporting an `indexed8` document as PNG produces a standard 32-bit RGBA PNG. Every pixel in the exported file visually matches the on-screen canvas at export time. Index 255 pixels are exported as fully transparent.
- Merging two `indexed8` layers produces an `indexed8` result layer. Every pixel in the result has an index in the range 0–254, or 255 for transparent pixels.
- Free transform on an indexed layer uses nearest-neighbor resampling. No bilinear or bicubic interpolation of index values occurs.
- Canvas crop that exposes new pixels (outward crop) initializes those pixels to index 255.
- An `indexed8` `.verve` file round-trips: saving and reopening preserves all layer index bytes exactly, and the displayed image is visually identical before and after.
- The status bar displays `Indexed/8` when the document pixel format is `indexed8`.
- The Adjustments, Effects, and Filters top menus are fully grayed out in `indexed8` mode. Hovering over any item in these menus shows a tooltip: *"Adjustments are not available in Indexed/8 mode."* Clicking produces no action.
- The Brush, Gradient, Clone Stamp, Dodge, and Burn toolbar buttons are grayed out and non-interactive in `indexed8` mode. Pressing their keyboard shortcuts produces no tool switch and shows the not-available tooltip.
- If the active tool at the time of entering `indexed8` mode is one of the disabled tools, the application switches to the pencil tool automatically.
- The pencil opacity slider reads 100% and is non-interactive in `indexed8` mode.
- The pencil anti-alias toggle is unchecked and non-interactive in `indexed8` mode.
- Pixel brush stamps in indexed mode produce pixels whose indices match the nearest-palette-index of each non-transparent stamp pixel. Transparent stamp pixels leave the underlying layer data unchanged.
- A newly created pixel layer in `indexed8` mode has all pixel bytes equal to **255** (the void sentinel). The layer is entirely transparent.

---

## Edge Cases & Constraints

- **Single-color palette**: a palette with exactly one swatch is valid. Every pixel in the document is either index 0 (the single swatch color) or index 255 (void/transparent). The pencil always writes index 0. The eraser always writes index 255.
- **256-color palette**: the maximum palette size in `indexed8` mode is 255 usable entries (indices 0–254). Index 255 is reserved as the transparent-void sentinel (architecture constraint from [Pixel Format Abstraction](pixel-format-abstraction.md)) and cannot be used as a regular palette index. The Swatches panel in indexed mode **must not** allow a 256th swatch to be added while in `indexed8` mode.
- **Stale indices after palette shrinkage**: any pixel whose stored index value is in [palette length, 254] renders as fully transparent. After the swatch removal remapping pass, this should not occur in normal use. Index 255 (void sentinel) is always present and always renders as transparent; this is by design.
- **Selection masks in indexed mode**: selection masks operate on canvas-sized binary alpha data, separate from the indexed layer data. They are unaffected by the pixel format. Tools that respect selections (pencil, eraser, fill) continue to respect the selection mask in indexed mode.
- **Layer opacity in indexed mode**: a pixel layer in `indexed8` mode may still have a layer-level opacity setting (0–100%). The compositor applies this opacity when expanding the indexed texture to RGBA for display and export. The stored index values are unchanged.
- **Blend modes in indexed mode**: blend modes other than `normal` on an indexed pixel layer produce undefined compositional results (index values do not participate in RGBA blending). The Layer Panel must gray out blend mode controls for indexed pixel layers and force them to `normal`.
- **Undo within a stroke**: undo records are written at `pointerup`, not per-pixel during a stroke. Pressing Ctrl+Z during a stroke is not expected to partially undo the stroke.
- **Multi-layer indexed documents**: all pixel layers in an `indexed8` document share the same palette (document swatches). There is no per-layer palette. Layers still composite independently at the display level (each is expanded to RGBA before compositing).
- **Dithering during conversion**: dithering is explicitly **not** applied during `rgba8` → `indexed8` conversion in this feature version. Users who want a dithered quantization result should use the [Reduce Colors](reduce-colors.md) adjustment (Map to Palette mode) in `rgba8` mode, then rasterize and convert.

---

## Out of Scope

- **Indexed PNG import or export**: reading PNG files with a `PLTE` chunk, or writing indexed PNGs on export, are deferred to a future spec.
- **GIF import or export**: GIF files with palette data are out of scope.
- **Per-layer pixel formats**: all layers in a document share one pixel format. Mixed-format layer stacks are not supported.
- **CMYK document mode**: not part of this feature.
- **User-configurable eraser/transparent color**: the eraser target is always index 255. A UI for designating a different palette entry as the eraser or background color is not in scope for this version.
- **Dithered merge/flatten**: merge and flatten quantize using nearest-palette-index with no dithering. Dithered merge is deferred.

---

## Related Features

- [pixel-format-abstraction.md](pixel-format-abstraction.md) — the architectural foundation: `indexed8` data representation, compositor expansion, conversion pipeline, `.verve` format changes, and feature gating rules. This spec is a strict follow-on to that one.
- [palette-verve-persistence.md](palette-verve-persistence.md) — the swatch palette that serves as the indexed-mode palette, and how it is stored in `.verve` files.
- [swatch-groups.md](swatch-groups.md) — swatch group membership is tracked by index position; swatch removal in indexed mode must also update group index references.
- [reduce-colors.md](reduce-colors.md) — the recommended workflow for converting a full-color image to a limited palette before entering indexed mode. Its "Map to Palette" mode uses the same swatch palette.
- [color-dithering.md](color-dithering.md) — dithering to the palette in `rgba8` mode; unavailable in `indexed8` mode. Recommended as a pre-conversion step.
- [unified-rasterization-pipeline.md](unified-rasterization-pipeline.md) — flatten, merge, and export must expand indexed layers to RGBA correctly.
- [generate-palette.md](generate-palette.md) — automatic palette generation from image content; the resulting swatch set is the palette used in indexed mode.
