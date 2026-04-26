# Halftone

## Overview

**Halftone** is a non-destructive real-time effect adjustment layer that simulates the dot-screen printing process used in offset and newspaper press reproduction. In traditional printing, continuous-tone images are broken into a grid of dots of varying size — large dots reproduce dark tones, small dots reproduce light tones — and multiple color screens are overlaid at offset angles to reconstruct the full-color image with minimal moiré interference. Because it is an adjustment layer, the effect is applied in real time to the composited content below it, is fully reversible, and can be tuned at any time without modifying the underlying pixel data. Halftone is categorized as a **Real-time Effect** and appears in the **Effects** menu alongside Bloom, Chromatic Aberration, Halation, Color Key, Drop Shadow, Glow, and Outline.

## User Interaction

1. The user selects a pixel layer in the Layer Panel.
2. The user opens the **Effects** menu in the top menu bar and clicks **Halftone…**. The item is disabled when no eligible layer is active.
3. A new child adjustment layer named **"Halftone"** appears in the Layer Panel, indented immediately beneath the active layer. The **Halftone** panel opens, anchored to the upper-right corner of the canvas.
4. At the top of the panel is a **Mode switch** with two options: **Color (CMYK)** and **B&W**. The default mode is **Color (CMYK)**.

### Color (CMYK) mode

5. In Color mode, the panel shows:
   - **Frequency** — a labeled slider controlling the density of the halftone grid, expressed in cells per 100 canvas pixels. Range: 2–50, default: 10. Higher values produce smaller, more numerous dots; lower values produce larger, more spread-out dots.
   - **Channel Offsets** section — four individual labeled sliders, one per ink channel, each adjusting that channel's dot size relative to the global frequency. The sliders are labeled **C**, **M**, **Y**, and **K**. Each ranges from −50% to +50%, with a default of 0% for all four channels. A positive offset makes that channel's dots larger; a negative offset makes them smaller.
6. Adjusting any control updates the canvas preview in real time.
7. The user closes the panel by clicking outside it or pressing Escape. One undo history entry is recorded at this moment.
8. To revise the effect later, the user clicks the **"Halftone"** adjustment layer row in the Layer Panel. The panel reopens with the previously committed values.
9. The adjustment layer can be hidden (eye icon) to temporarily suppress the halftone effect, or deleted to remove the effect permanently.

### B&W mode

5. In B&W mode, the panel shows:
   - **Frequency** — the same density slider as in Color mode. Range: 2–50, default: 10.
6. There are no per-channel offset controls in B&W mode.
7. Steps 6–9 are the same as in Color mode.

### Switching modes

- Switching the Mode from Color (CMYK) to B&W, or vice versa, updates the canvas preview immediately. The Frequency value is retained between mode switches; the per-channel offsets are hidden (but preserved) when switching to B&W.

## Functional Requirements

- The **Halftone…** menu item **must** appear in the **Effects** top-level menu.
- The item **must** be enabled only when the active layer is a pixel layer. It **must** be disabled when the active layer is a mask layer, another adjustment layer, a layer group, a text layer, a shape layer, or when no layer is active.
- Activating the menu item **must** create a new child adjustment layer parented to the active layer and immediately open the Halftone panel. The parent layer's pixel data **must not** be modified.
- The adjustment layer **must** be stored non-destructively: all parameters are saved on the layer record and applied at render time.
- The panel **must** expose the following controls:

  **Shared (both modes)**
  - **Mode switch**: two mutually exclusive options — **Color (CMYK)** (default) and **B&W** — displayed as a segmented control or radio group.
  - **Frequency**: range 2–50 (cells per 100 canvas pixels), default 10. Displayed as a labeled slider with a numeric input. Values below 2 are clamped to 2; values above 50 are clamped to 50. The unit label "cells/100px" is shown adjacent to the input.

  **Color (CMYK) mode only**
  - **C Offset**: range −50% to +50%, default 0%. Labeled slider with numeric input and "%" unit.
  - **M Offset**: range −50% to +50%, default 0%. Labeled slider with numeric input and "%" unit.
  - **Y Offset**: range −50% to +50%, default 0%. Labeled slider with numeric input and "%" unit.
  - **K Offset**: range −50% to +50%, default 0%. Labeled slider with numeric input and "%" unit.

- The halftone rendering pipeline **must** be a GPU compute pass. No CPU fallback.

### Color (CMYK) rendering pipeline

1. **Composite input** — read the flattened pixel content of the layers below the Halftone adjustment within the same compositing stack, producing an RGBA source image at full canvas resolution.
2. **RGB → CMYK conversion** — convert the source pixels to CMYK using the standard artistic approximation:
   - `K = 1 − max(R, G, B)`
   - `C = (1 − R − K) / (1 − K)` (0 when K = 1)
   - `M = (1 − G − K) / (1 − K)` (0 when K = 1)
   - `Y = (1 − B − K) / (1 − K)` (0 when K = 1)
3. **Per-channel screen rendering** — for each of the four channels (C, M, Y, K), render a halftone screen independently:
   - The screen grid is a square grid rotated to the channel's fixed angle: **C = 105°, M = 75°, Y = 90°, K = 45°**. These angles are fixed and not user-adjustable.
   - The cell pitch (in canvas pixels) is derived from the Frequency value: `cell_pitch = 100 / frequency`.
   - Each grid cell contains one circular dot. The dot's radius is proportional to the channel's value at the center of that cell: `dot_radius = channel_value × (cell_pitch / 2) × (1 + offset / 100)`, where `offset` is the per-channel ±% offset slider value. The effective dot radius is clamped to [0, `cell_pitch / 2`] — dots never exceed the cell boundary.
   - Each cell's channel value is sampled from the CMYK source image at the cell's center coordinate after rotating back from screen space to canvas space.
   - A pixel belongs to the dot in its cell if its distance to the cell center (in rotated screen space) is less than or equal to the computed dot radius.
4. **Screen-to-ink compositing** — convert the four binary dot masks back to RGB for display:
   - For each output pixel, determine which ink channels have a dot present at that location. Treat each channel as a subtractive ink: start from white (1, 1, 1) and subtract contributions from each ink layer present.
   - Specifically, composite the four channel dot masks using subtractive mixing: `RGB_out = (1 − C_dot) × (1 − M_dot) × (1 − Y_dot) × (1 − K_dot)` for each RGB component as filtered by the CMYK-to-RGB matrix.
   - Pixels where no dot is present from any channel remain transparent (alpha = 0), not white (see **Design Decision: Background** below).
5. **Alpha** — the output alpha of each pixel is the union of all four dot masks at that pixel. Pixels covered by at least one dot have alpha = 1; pixels covered by no dot have alpha = 0.

### B&W rendering pipeline

1. **Composite input** — same as Color step 1.
2. **Luminance** — compute the perceptual luminance of each source pixel: `L = 0.2126 × R + 0.7152 × G + 0.0722 × B`.
3. **Single screen** — render one halftone screen at a fixed angle of **45°**. The cell pitch is derived from Frequency identically to Color mode. The dot radius in each cell is proportional to the **inverse** of the cell's luminance value: `dot_radius = (1 − L_cell) × (cell_pitch / 2)`. This produces the classic newspaper halftone: large black dots in shadows, small dots in highlights, and no dot in pure white areas.
4. **Output** — pixels inside a dot are solid black (R=0, G=0, B=0, A=1). Pixels outside all dots are transparent (A=0). The luminance of the source image is not used to color the dots; they are always black.

- The canvas preview **must** update in real time while any control is being adjusted, without perceptible lag on typical image sizes.
- Closing the panel **must** record exactly one undo history entry. Pressing Ctrl+Z / Cmd+Z once **must** remove the Halftone adjustment layer and restore the canvas to its pre-effect state.
- The adjustment layer **must** support:
  - **Visibility toggle** — hiding the layer suppresses the halftone effect without deleting it or its settings.
  - **Deletion** — permanently removes the adjustment layer and restores the underlying appearance.
  - **Re-editing** — clicking the layer row in the Layer Panel reopens the panel with the last committed parameter values, including the active mode.
- The Halftone effect **must** be included in flatten, export, and merge outputs via the unified rasterization pipeline. It **must not** be silently skipped or no-oped during non-preview rendering.
- If a selection is active when the Halftone adjustment layer is created, the halftone rendering **must** be restricted to the selected area; the selection mask is baked into the adjustment layer at creation time.

## Design Decision: Background (Transparent vs. White)

**Recommendation: transparent background (non-dot pixels have alpha = 0).**

A white background would permanently occlude all layers beneath the Halftone effect, eliminating any possibility of combining the halftone look with the underlying image content. Transparent dots, by contrast, composite naturally over whatever is below: an artist who wants the classic "printed on white paper" look can simply add a white solid color layer beneath the Halftone layer, while an artist who wants halftone dots floating over a photograph or color wash retains full compositional flexibility. Transparent is therefore the more general and creative-friendly default.

## Acceptance Criteria

- With a pixel layer active, **Effects → Halftone…** is enabled, creates a child adjustment layer named "Halftone" in the Layer Panel, and opens the Halftone panel.
- With a non-pixel layer active (mask layer, another adjustment layer, layer group, or no layer), the menu item is grayed out and produces no action.
- The parent layer's raw pixel data is unchanged after creating the Halftone adjustment (verifiable by reading raw pixel values before and after).
- In **Color (CMYK) mode** at default settings (Frequency 10, all offsets 0%), a clearly visible multi-color halftone dot pattern appears on a pixel layer with a gradient or photograph, with visible rosette structure from the overlapping angle-offset screens.
- In **B&W mode** at default settings (Frequency 10), a grayscale image shows large black dots in dark areas and small or absent dots in bright areas over a transparent field.
- Non-dot pixels are transparent (alpha = 0), not white, in both modes. Compositing a Halftone layer over a colored background layer shows the background color through the gaps between dots.
- Setting Frequency to 2 produces a very coarse grid (large, widely spaced dots, roughly 50px pitch at 100% zoom). Setting it to 50 produces a fine grid (small, dense dots, roughly 2px pitch).
- Each per-channel offset slider (CMYK mode) independently enlarges or shrinks that channel's dots. Setting K Offset to +50% makes the black dots visibly larger than the C, M, Y dots at the same frequency.
- Setting all per-channel offsets to −50% produces very small dots at full coverage (all cells have dots at half their maximum size).
- Switching from Color (CMYK) to B&W collapses the panel to show only the Frequency slider; the canvas immediately updates to display a single black dot screen. Switching back restores the CMYK panel with previously set offset values intact.
- Hiding the Halftone adjustment layer removes the halftone pattern and reveals the original unmodified canvas content.
- Deleting the Halftone adjustment layer removes it from the Layer Panel and the canvas returns to the unmodified appearance.
- Pressing Ctrl+Z / Cmd+Z once after closing the panel removes the Halftone adjustment layer entirely.
- Clicking the Halftone adjustment layer row reopens the panel showing all previously committed values, including the active mode and per-channel offsets.
- Creating with an active selection restricts the halftone effect to that area; pixels outside the selection boundary are unaffected.
- Entering Frequency = 60 clamps to 50; entering 0 clamps to 2. Entering an offset of 75% clamps to 50%; entering −80% clamps to −50%.
- The effect is present and correct in flatten, export, and merge outputs — the halftone dot pattern is visible in a PNG exported from a document containing a Halftone adjustment layer.
- The canvas preview updates in real time while dragging any slider, without perceptible lag on a canvas up to 4000 × 4000 px.

## Edge Cases & Constraints

- **Very small canvases**: On a canvas smaller than 100 × 100 px, even the coarsest Frequency setting (2 cells/100px, ~50px pitch) may produce only a few dots total. The halftone pattern is still rendered correctly; the result is simply very coarse relative to the canvas.
- **Very fine frequency with large offsets**: At Frequency 50 (2px pitch), a positive channel offset can attempt to produce dots larger than the cell. The dot radius is clamped to the cell's inscribed radius (`cell_pitch / 2`), preventing dots from overflowing into neighboring cells.
- **CMYK conversion for near-zero saturation**: Pixels that are neutral gray produce high K and near-zero C, M, Y. The resulting halftone will be dominated by the K (black) screen, which is the expected printing behavior.
- **Fully transparent source pixels**: A source pixel with alpha = 0 contributes zero channel values to its enclosing cell. If a cell's center sample falls on a transparent region, that cell's dot has radius 0 and no dot is rendered (in B&W mode, a fully transparent cell also produces no dot, since L = 0 maps to a maximum-sized black dot — see below).
- **B&W mode and fully transparent pixels**: Because the B&W pipeline maps low luminance to large dots, a fully transparent pixel (L = 0) would produce a full-sized black dot. To avoid filling transparent regions with black dots, the B&W pipeline must premultiply the cell luminance sample by the source pixel's alpha before computing dot radius. A cell whose center sample has alpha = 0 produces no dot.
- **Moiré with external content**: The four fixed screen angles (C=105°, M=75°, Y=90°, K=45°) are the traditional offset values chosen to minimize moiré between screens. Users should not expect a moiré-free result when combining the Halftone effect with other pixel patterns or textures already present in the image.
- **Multiple Halftone layers**: Multiple Halftone adjustment layers may be stacked. Each is independently computed against the composited content below it. Stacking produces cumulative dot patterns whose interaction depends on layer order and blend modes, which may or may not produce useful results; this is expected and unsupported behavior.
- **Performance at fine frequencies**: At Frequency 50 on a 4000 × 4000 px canvas, the shader processes approximately 4 million cells. This is a computationally intensive operation. Real-time preview responsiveness is required but the effect may have a longer initial compilation time on first activation.
- **Selection masks are static**: The selection baked at creation time does not update if the user modifies the selection after the Halftone layer is created.
- **No keyboard shortcut** is assigned to this effect by default.

## Open Questions

- **Angle user control**: The classic screen angles (C=105°, M=75°, Y=90°, K=45°) are fixed in this spec. A future enhancement could expose per-channel angle controls for creative misregistration effects (a deliberately shifted screen angle is a well-known artistic technique). This is out of scope for the initial implementation.
- **Dot size measurement convention**: This spec defines dot radius as `channel_value × (cell_pitch / 2)`. At 100% ink coverage the dot exactly fills the inscribed circle within its cell. Some implementations define a "dot gain" curve (printing presses physically expand dots on paper) — simulating dot gain is outside the scope of this feature.
- **B&W luminance inversion**: The decision to map **low luminance → large dot** is the classical newspaper convention. An alternative (photographic positive) convention maps **high luminance → large dot**. This spec uses the classical convention. If user testing reveals confusion, an **Invert** toggle can be added in a future revision.

## Related Features

- [adjustment-menu.md](adjustment-menu.md) — the Effects menu structure that hosts this item
- [bloom.md](bloom.md) — another real-time effect adjustment layer, for reference on panel interaction and compositing patterns
- [drop-shadow.md](drop-shadow.md) — another real-time effect, for panel and lifecycle reference
- [color-dithering.md](color-dithering.md) — a related destructive effect that also spatially distributes color information across pixels
- [unified-rasterization-pipeline.md](unified-rasterization-pipeline.md) — the compositing pipeline responsible for applying this adjustment during flatten, merge, and export
