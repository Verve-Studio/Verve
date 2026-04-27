# Tiled Mode

## Overview

**Tiled Mode** is a session-level view toggle that changes how the canvas is rendered and interacted with. Instead of displaying the canvas once, the workspace shows the same composited output in a 3×3 grid — nine cells, all showing the same image. The center cell is the live editing canvas; the eight surrounding cells are real-time visual repeats of the identical output buffer.

The feature exists to help users author seamlessly tiling content: textures, sprite sheets, game tiles, or repeating patterns. Without Tiled Mode, the user cannot see whether a stroke or edit will produce a clean seam — they must mentally imagine the tiled result. With Tiled Mode active, seam quality is immediately visible, and certain tools can apply edits across canvas boundaries (wrap-around editing), so a brush stroke that exits the right edge continues seamlessly from the left.

Tiled Mode does not change what is stored in the document. It is purely a viewport and interaction mode for the current session.

---

## User Interaction

### Entering and Exiting Tiled Mode

1. The user opens the **View** menu from the menu bar.
2. The menu contains two mutually exclusive mode items: **Normal Mode** and **Tiled Mode**. A checkmark appears next to the currently active mode.
3. Clicking **Tiled Mode** switches the canvas view to the 3×3 tiled layout. The checkmark moves to **Tiled Mode**.
4. Clicking **Normal Mode** (or clicking **Tiled Mode** again) restores the standard single-canvas view. The checkmark returns to **Normal Mode**.

Only one mode can be active at a time. The transition is immediate — no dialog, no progress indicator.

### Navigating the Tiled View

Once Tiled Mode is active:

- The canvas area displays nine cells arranged in a 3×3 grid. Each cell is the same size as the canvas.
- All nine cells show the same rendered output, updated in real time as edits are made.
- The user can **pan** freely across the entire 3×3 arrangement using the same gestures as in Normal mode (space+drag, middle-mouse drag, or scroll). The view is not clamped — the user can pan to see the boundary between any two cells.
- The user can **zoom** in and out exactly as in Normal mode (Ctrl+=, Ctrl+-, Ctrl+0 to fit, or pinch/scroll-wheel). Zoom is centered on the viewport, not the center cell.
- There is no visual indicator distinguishing the center cell from the surrounding tiles by default; all nine cells render identically. The user can identify the center cell by its position or by making an edit and observing where the change originates.

### Editing in Tiled Mode

All editing happens on the center cell — the actual canvas. Tools respond to cursor events on the center cell exactly as they would in Normal Mode.

For tools that support **wrap-around editing** (see [Functional Requirements](#functional-requirements)), the user may also interact with the surrounding tiles:

- The user can begin a stroke anywhere in the 3×3 grid, including on a surrounding tile.
- If the stroke passes over a surrounding tile, the pixels in that tile region that would be modified are automatically translated back to the corresponding position on the canvas, wrapping across the opposite edge.
- The visual feedback on the surrounding tiles updates in real time as the stroke proceeds, so the user sees the wrap-around effect live.

For tools that do **not** support wrap-around, strokes started on a surrounding tile have no effect. The cursor remains active and visible, but no pixels are modified.

---

## Functional Requirements

### Mode Toggle

- The **View** menu **must** contain two items: **Normal Mode** and **Tiled Mode**, grouped together (with a separator from other View items if appropriate).
- Exactly one of the two items **must** display a checkmark at all times.
- The default state when opening a document is **Normal Mode**.
- Tiled Mode state **must not** be saved to the document file — closing and reopening a file always starts in Normal Mode.
- Tiled Mode state **must not** be inherited or shared across tabs. Each tab maintains its own independent view mode.
- Switching tabs **must** preserve the view mode of each tab independently.

### Rendering

- In Tiled Mode, the renderer **must** blit the same final composited output buffer nine times in a 3×3 grid layout.
- Each cell **must** be exactly the same width and height as the canvas.
- The output shown in all nine cells **must** be identical and always reflect the current composite state (including all visible layers, adjustment layers, effects, and filters).
- No separate compositing pass, adjustment pass, or filter pass **must** be run per cell. The rendering pipeline runs once; the single result is blitted nine times.
- The surrounding eight tiles **must** update in real time as the user edits, with the same frame-rate characteristics as the center cell in Normal Mode.
- Switching between Normal Mode and Tiled Mode **must not** alter the document's pixel data, layer state, or undo history.

### Pan & Zoom

- In Tiled Mode, pan must operate over the full extent of the 3×3 grid with **no clamping** to the center tile.
- Zoom behavior (shortcuts, scroll wheel, fit-to-window) **must** be identical to Normal Mode. "Fit to Window" (Ctrl+0) in Tiled Mode fits the full 3×3 grid into the viewport, not just the center cell.
- The viewport position and zoom level **must** persist independently per tab, consistent with Normal Mode behavior.

### Grid Overlay

- In Tiled Mode, the user can toggle a **tile grid overlay** that draws lines at the tile seam boundaries, visually dividing the 3×3 arrangement into its nine cells.
- The grid overlay is toggled via **View → Show Tile Grid** (or an equivalent View menu item; the exact label is a UX design decision).
- The grid overlay is **off by default** when Tiled Mode is first activated.
- The grid overlay state is session-level only — it is not persisted to the document.
- The grid lines are rendered at the tile seams only (every `W` pixels horizontally and every `H` pixels vertically, where `W` and `H` are the canvas width and height). They are not a general-purpose pixel grid.
- The grid lines must be visually distinct from the canvas content (e.g. a contrasting color with a fixed opacity) but must not obscure editing. They are an overlay on top of the composited output.
- The grid overlay is independent of any existing "Show Grid" or ruler features in Normal Mode.

### Wrap-Around Editing

Wrap-around editing applies when: (a) Tiled Mode is active, and (b) the tool in use is in the wrap-around-capable set.

**Wrap-around-capable tools:**

| Tool | Notes |
|---|---|
| Brush | All pointer strokes |
| Eraser | All pointer strokes |
| Pencil | All pointer strokes |
| Pen (Bezier) | Pixels are rasterized normally; any pixel coordinate outside canvas bounds is wrapped using the modular rule |
| Clone Stamp | Both the sampling point and the painted destination are subject to wrapping |
| Rectangular Selection | Selection region wraps if it extends past a canvas edge |
| Lasso Selection | Selection region wraps if it extends past a canvas edge |
| Polygonal Selection | Selection region wraps if it extends past a canvas edge |

**Wrap-around coordinate rule:**

When a tool operation produces a pixel at canvas coordinate $(x, y)$ where $x < 0$, $x \geq W$, $y < 0$, or $y \geq H$ (canvas width $W$, canvas height $H$), the coordinate is wrapped as:

$$x_{\text{wrapped}} = ((x \bmod W) + W) \bmod W$$
$$y_{\text{wrapped}} = ((y \bmod H) + H) \bmod H$$

This is true modular arithmetic (positive remainder), not clamping. A pixel one pixel past the right edge wraps to the left edge at the same row; a pixel one pixel above the top edge wraps to the bottom edge at the same column.

**Drawing tools (Brush, Eraser, Pencil, Pen):**

- When a pointer stroke exits one edge of the canvas, the stroke continues on the opposite edge at the wrapped coordinate.
- The wrapped portion of the stroke is applied to the actual canvas pixel data — it is not a preview-only effect. After completing the stroke, the result is a pixel layer that tiles seamlessly.
- Within a single stroke, wrap-around may occur multiple times (e.g. a stroke can cross the right edge, wrap to the left, then exit the bottom, wrapping to the top).
- Opacity accumulation within a single stroke must respect the same per-pixel cap as in Normal Mode — a pixel that is visited via both a direct path and a wrapped path within the same stroke counts as one visit at the maximum effective alpha for that stroke, not two additive visits.

**Clone Stamp wrap-around:**

- If the source point (set by Alt-click) is on a surrounding tile, the source coordinates are unwrapped back to the canvas before sampling.
- If the brush tip crosses a canvas boundary while painting, the painted pixels wrap to the opposite edge.
- Both source and destination wrapping may occur simultaneously within a single stroke.

**Selection tools wrap-around:**

- A rectangular, lasso, or polygonal selection that extends past a canvas edge produces a selection that wraps around to include the corresponding pixels on the opposite side.
- The selection is stored as a canvas-sized mask. Pixels included by wrap-around are marked as selected in their actual (wrapped) canvas position.
- The user sees the wrapped selection visually highlighted across both the originating tile and the destination tile in the 3×3 view.
- All selection operations (invert, clear, fill, copy) operate on the stored canvas-sized mask and are unaffected by the wrap-around origin of the selection.

**Tools not in scope for wrap-around (v1):**

The following tools operate only within the canvas boundary. Strokes or operations that extend beyond the canvas edge are clipped at the edge exactly as in Normal Mode:

- Transform tool
- Fill / Paint Bucket
- Gradient
- Shape
- Text
- Magic Wand
- Object Selection
- Zoom
- Eyedropper
- Move

If the user attempts to use one of these tools on a surrounding tile in Tiled Mode, the tool does nothing (the tile regions outside the center canvas are inert for these tools).

---

## Acceptance Criteria

- **View → Tiled Mode** switches the canvas area to a 3×3 grid of identical tiles. **View → Normal Mode** returns to the single canvas view.
- A checkmark appears next to the active mode in the View menu at all times.
- Opening or switching to a tab always starts in Normal Mode, regardless of what mode was active when the tab was last visited.
- Closing and reopening a file starts in Normal Mode.
- Each tab independently tracks its own view mode — activating Tiled Mode in one tab does not affect other tabs.
- All nine tiles display the same rendered output. Editing the canvas in the center tile updates all nine tiles simultaneously.
- No compositing differences exist between the center tile and the surrounding tiles — they are pixel-identical to the center.
- Panning in Tiled Mode scrolls smoothly across the full 3×3 grid without snapping to or clamping at the center tile.
- Ctrl+0 (Fit to Window) in Tiled Mode fits the entire 3×3 arrangement, not just the center tile.
- A brush stroke made in the center tile that does not cross any canvas edge produces exactly the same pixel result as in Normal Mode.
- A brush stroke that exits the right edge of the center tile continues on the left edge of the canvas at the same Y coordinate. The resulting pixel data tiles seamlessly — placing the canvas edge-to-edge with itself produces no visible seam at the brushed boundary.
- The same wrap-around behavior is verified for: top↔bottom edge crossings, corner crossings (diagonal strokes), and strokes that cross multiple edges within a single gesture.
- Within a single wrapped stroke, a pixel visited both directly and via wrap-around is painted at most once at the stroke's effective opacity (no double-opacity accumulation).
- A brush stroke begun on a surrounding tile (not the center) produces the same pixel result as if the stroke had started at the equivalent position on the canvas.
- Clone Stamp: Alt-clicking on a surrounding tile samples from the correct wrapped canvas coordinate. Painting with a wrapped destination writes to the correct wrapped canvas coordinate.
- Selection: Drawing a rectangular selection that extends beyond the right canvas boundary produces a selection mask that includes both the right-side portion and the wrapped left-side portion. Inverting, clearing, or filling the selection behaves correctly on the full wrapped mask.
- The Fill, Transform, Gradient, Shape, and Text tools clip at the canvas boundary exactly as in Normal Mode. Clicks or drags on surrounding tiles for these tools produce no effect.
- Switching from Tiled Mode to Normal Mode does not alter pixel data, layer contents, or undo history.
- Ctrl+Z in Tiled Mode undoes the last edit (including wrapped strokes) exactly as it would in Normal Mode.

---

## Edge Cases & Constraints

- **Corner crossings:** A stroke that exits through a corner (both X and Y simultaneously out of bounds) wraps on both axes independently. The result is equivalent to applying the stroke at the diagonally opposite corner of the canvas.
- **Canvas size 1×1:** Wrap-around is mathematically valid but produces a single-pixel canvas where every wrapped coordinate resolves to (0, 0). Behavior is correct but the visual result is trivial.
- **Non-square canvases:** Wrapping on X uses the canvas width; wrapping on Y uses the canvas height. The two axes are independent.
- **Large strokes:** A stroke with a large brush radius that simultaneously overlaps the center tile and multiple surrounding tiles writes the wrapped pixels to the canvas correctly. The visual update in all nine tiles reflects the complete result.
- **Adjustment layers and effects in Tiled Mode:** Adjustment layers, real-time effects, and filter layers are composited once into the final output buffer. All nine tiles show this composited result. There is no per-tile adjustment or masking.
- **Layer masks in Tiled Mode:** Layer masks are applied during compositing as normal. The composited result is blitted nine times. Tiled Mode adds no special mask behavior.
- **Undo of a wrapped stroke:** A single Ctrl+Z undoes the entire stroke, including all wrapped-edge pixel writes. The canvas is restored to exactly its pre-stroke state.
- **Selection with no active canvas area:** If the entire rectangular or lasso selection falls outside the center canvas (i.e. is drawn entirely on a surrounding tile), the wrapped selection is still applied to the canvas and treated as a normal selection.
- **Switching tabs mid-stroke:** If the user switches tabs during a pointer gesture, the stroke is cancelled as it would be in Normal Mode. No partial wrapped writes are committed.
- **Performance:** The 3×3 blit is the same single output buffer rendered nine times. The compositing cost in Tiled Mode is identical to Normal Mode — only the screen blit is expanded. Tools that produce many wrapped pixel writes (e.g. a large-radius soft brush crossing an edge) may be slightly more expensive than non-wrapping equivalents, as pixels at both the direct and wrapped coordinates must be written.
- **Fit to Window behavior:** "Fit to Window" in Tiled Mode scales the viewport to show all nine tiles with a small margin, meaning each individual tile appears at roughly one-third the size of a Normal Mode fit. If this is too small for practical use, the user can zoom in manually.

---

## Out of Scope (v1)

- Persisting Tiled Mode state per document or file.
- Tiling arrangements other than 3×3 (e.g. 5×5, infinite, user-configurable grid size).
- Per-tile adjustment passes, filters, or compositing variations.
- Wrap-around for tools not listed in the wrap-around-capable set (transform, fill, gradient, shape, text, magic wand, object selection, zoom, eyedropper, move).
- Special handling for layer masks, adjustment layers, or effect layers beyond what the normal composited output already provides.
- A dedicated visual indicator specifically highlighting the center cell as the "editable" tile (beyond what the grid overlay already provides).
- Export of a tiled/repeated image from the Tiled Mode view (export always writes the single canvas, not the 3×3 arrangement).

---

## Open Questions

1. **Center cell visual indicator:** Should the center cell have a subtle highlight, border, or overlay to help users orient themselves in the 3×3 grid, especially after zooming in? v1 defers this, but it may be needed for usability.
2. **Fit to Window scale:** Fitting the full 3×3 grid may make each tile too small. Should "Fit to Window" in Tiled Mode fit the center tile instead of the full grid, or should there be a separate shortcut for each behavior?
3. **Wrap-around for fill/paint bucket:** A flood-fill that reaches a canvas edge could logically wrap to the opposite edge for seamless texture generation. This is deferred to v1-post but should be evaluated.
4. **Scrolling past the 3×3 boundary:** Currently pan is unclamped. Should there be any clamping beyond the 3×3 grid (i.e. prevent the user from panning so far that no tiles are visible), or is an unclamped pan acceptable?

---

## Related Features

- [Brush Tool](../specifications/brush.md) — primary painting tool; wrap-around behavior extends its stroke pipeline.
- [Clone Stamp Tool](../specifications/clone-stamp.md) — both source and destination are subject to wrap-around coordinate mapping.
- [Select / Rectangular Selection](../specifications/) — selection wrapping depends on the canvas-sized selection mask representation.
- [Canvas Pan & Zoom](../specifications/) — Tiled Mode extends the pan/zoom viewport range and changes the "Fit to Window" target.
- [View Menu](../specifications/adjustment-menu.md) — Tiled Mode items are added to the View menu alongside existing zoom and grid controls.
