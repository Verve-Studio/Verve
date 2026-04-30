# Reduce Colors

## Overview

The **Reduce Colors** adjustment is a non-destructive child layer that constrains the visible color range of a pixel layer to a limited set of colors. It has two distinct modes: the first automatically finds the most representative N colors and remaps every pixel to its closest perceptual match; the second maps every pixel to the closest color in the user's current swatch palette. This is the primary tool for producing posterized, retro, or palette-locked artwork without permanently altering the source pixels.

## User Interaction

1. The user selects a pixel layer in the Layer Panel.
2. The user opens **Image → Reduce Colors…** from the TopBar. If a selection is currently active it will scope the adjustment; if none exists the whole layer is targeted.
3. A new child layer named **"Reduce Colors"** appears in the Layer Panel, indented directly beneath the parent layer — the same visual treatment as a layer mask.
4. A floating panel titled **"Reduce Colors"** opens, anchored to the upper-right corner of the canvas. It contains:
   - A **mode toggle** with two options: **Reduce to N Colors** and **Map to Palette**. Defaults to **Reduce to N Colors**.
   - Mode-specific controls (described below).
5. The canvas updates in real time whenever the mode or any control changes.
6. The user closes the panel by clicking outside it or pressing Escape. One undo history entry is recorded at this moment.
7. To revise the adjustment later, the user clicks the adjustment layer's row in the Layer Panel. The floating panel reopens at the previously saved mode and values.
8. The adjustment layer can be hidden (eye icon) to temporarily disable it, or deleted to remove it permanently.

### Mode 1 — Reduce to N Colors

When the **Reduce to N Colors** mode is active, the panel shows:

- **Colors** — a labeled slider (2–256) with an adjacent numeric input. Default: 16.

The adjustment analyzes the visible pixels on the parent layer, derives the N most representative colors, and remaps each pixel to its perceptually nearest color from that derived set. Perception is measured in OKLab space. No dithering is applied; the result is a flat, posterized appearance.

### Mode 2 — Map to Palette

When the **Map to Palette** mode is active, the panel shows:

- A read-only display of the current swatch palette color count (e.g., "32 colors in palette").
- If the palette has 0 or 1 swatches: a visible inline warning message (e.g., "Palette must have at least 2 colors") and the mode's effect is suspended — the layer renders as if no adjustment is applied.

When the palette is valid (≥ 2 swatches), each pixel on the parent layer is remapped to its perceptually nearest swatch color, measured in OKLab space. No dithering is applied.

While the panel is open and Map to Palette mode is active, any change to the swatch palette (adding, removing, or modifying a swatch) causes the canvas to re-render immediately to reflect the updated palette.

## Functional Requirements

- The adjustment **must** be stored as a non-destructive child adjustment layer immediately following its parent in the layer stack, with a `parentId` reference to the parent pixel layer.
- The parent pixel layer's pixel data **must not** be modified by this adjustment.
- The adjustment **must** be evaluated at render time via a WebGPU compute pass; the original pixel data is preserved in full.
- If a selection is active when the adjustment is created, only pixels within the selection boundary **must** be affected; the selection mask is baked into the adjustment layer at creation time.
- If no selection is active, the adjustment **must** affect the entire parent layer.
- The panel **must** expose a **mode toggle** with two states: **Reduce to N Colors** and **Map to Palette**.
- In **Reduce to N Colors** mode, the panel **must** expose a **Colors** slider and numeric input: range 2–256, default 16. Both controls **must** remain in sync.
- In **Reduce to N Colors** mode, the adjustment **must** derive N representative colors from the parent layer's pixel data using a perceptual clustering algorithm in OKLab color space.
- In **Reduce to N Colors** mode, each pixel **must** be remapped to the perceptually nearest color in the derived set, with distance measured in OKLab space.
- In **Map to Palette** mode, the panel **must** display a read-only label showing the current swatch count.
- In **Map to Palette** mode, when the swatch palette contains 0 or 1 colors, the adjustment **must** show an inline warning and **must not** alter the rendered output.
- In **Map to Palette** mode with ≥ 2 swatches, each pixel **must** be remapped to the perceptually nearest swatch color, with distance measured in OKLab space.
- In **Map to Palette** mode, any change to the swatch palette **must** trigger an immediate re-render of the adjustment preview.
- Neither mode **must** apply dithering — each pixel maps to exactly one output color.
- Fully transparent pixels (alpha = 0) **must** remain fully transparent and **must not** be included in the color derivation for mode 1.
- The canvas **must** update in real time whenever the mode toggle or the Colors slider is changed.
- Closing the panel **must** record exactly one undo history entry. Undoing **must** remove the adjustment layer.
- The adjustment layer **must** support visibility toggle, deletion, and re-editing from the Layer Panel.

## Acceptance Criteria

- After creating the adjustment, the parent layer's pixel data is unchanged when inspected directly.
- In Reduce to N Colors mode with N = 2, the canvas renders using exactly two colors.
- In Reduce to N Colors mode with N = 256 on a layer that already has fewer than 256 distinct colors, the output is visually identical to the original.
- In Map to Palette mode with a 4-swatch palette, every visible pixel in the output is one of the four palette colors.
- In Map to Palette mode with a 1-swatch palette, an inline warning is visible in the panel and the canvas is unaffected (renders identically to the unmodified parent layer).
- In Map to Palette mode with a 0-swatch palette, an inline warning is visible in the panel and the canvas is unaffected.
- Adding a swatch while Map to Palette mode is active causes the canvas to update immediately without any user interaction.
- Removing a swatch while Map to Palette mode is active causes the canvas to update immediately.
- Dragging the Colors slider in Reduce to N Colors mode updates the canvas continuously.
- Creating with an active selection restricts the color-reduction effect to the selected area; pixels outside the selection are rendered as-is.
- Creating with no active selection applies the effect to the full layer.
- Hiding the adjustment layer removes the visual effect without deleting it; the parent layer renders normally.
- Pressing Ctrl+Z once after closing the panel removes the adjustment layer entirely.
- Clicking the adjustment layer in the Layer Panel reopens the panel with the previously saved mode and control values.
- Fully transparent pixels are not recolored and remain transparent.
- Switching from Map to Palette mode to Reduce to N Colors mode (and back) while the panel is open preserves the previously entered N value.

## Edge Cases & Constraints

- If the parent layer contains only one distinct color, Reduce to N Colors mode with any N ≥ 1 produces output identical to the original.
- The adjustment is not applicable to text layers, shape layers, or mask layers.
- The selection mask baked at creation time does not update if the user modifies the selection after the adjustment layer has been created.
- Multiple Reduce Colors adjustments may be stacked on the same parent layer; each operates independently and is evaluated in layer order.
- In Map to Palette mode, the palette read at render time is the current live palette — if the palette changes while the panel is closed and the adjustment layer exists, the next render reflects the new palette automatically.
- Partially transparent pixels are remapped by color only; their alpha value is not altered by the adjustment.
- When N equals the number of distinct colors already present in the layer, the output may be visually identical to the original, depending on the clustering algorithm's exact quantization result.

## Related Features

- [adjustment-menu.md](adjustment-menu.md) — the menu entry that creates this adjustment
- [generate-palette.md](generate-palette.md) — palette generation tool; the resulting swatch set drives Map to Palette mode
- [palette-verve-persistence.md](palette-verve-persistence.md) — palette save/load; the loaded palette is the live swatch set read by Map to Palette mode
- [unified-rasterization-pipeline.md](unified-rasterization-pipeline.md) — the render pipeline that evaluates this adjustment at export, flatten, and merge time
- [hue-saturation.md](hue-saturation.md) — another non-destructive child adjustment layer following the same pattern
