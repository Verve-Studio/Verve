# Polygonal Selection Tool

## Overview

The **Polygonal Selection Tool** (Polygonal Lasso) lets users draw a straight-edged, multi-vertex selection region by clicking to place anchor points one at a time. Unlike the freehand Lasso tool, every segment between points is a perfectly straight line. Once the polygon is closed — either by clicking back near the first point or by double-clicking — the enclosed region is committed as the active pixel selection and the marching-ants overlay appears. This is Verve's equivalent of Photoshop's Polygonal Lasso Tool.

---

## User Interaction

### Activating the tool

The user selects the Polygonal Lasso from the toolbox, or presses **L** to activate it (L cycles through lasso-family tools; with only one lasso tool present, L directly activates the Polygonal Lasso). The cursor changes to the polygonal lasso cursor when hovering over the canvas.

### Drawing a polygon (the normal flow)

1. The user clicks anywhere on the canvas to place the **first anchor point**. A small filled circle (the close indicator) is permanently drawn at this point for the duration of the polygon session.
2. The user moves the cursor. A **rubber-band line** (thin, dashed or contrasting) is drawn in real time from the last placed vertex to the current cursor position, showing the edge that would be added on the next click.
3. The user clicks again to place a **second anchor point**. A permanent line segment is drawn between the first and second points; the rubber-band now extends from the second point.
4. The user continues clicking to add additional vertices. Each click locks in a new straight-line segment and the rubber-band shifts to trail from the newest point.

### Closing the polygon

There are three ways to close and commit the selection:

**A — Click-to-close (snap):** When the cursor comes within approximately 12 px of the first anchor point, a **close indicator** (a small circle rendered on the first point) changes appearance to signal that the polygon is snappable. Clicking at this moment closes the polygon by connecting the last vertex back to the first, then immediately commits the enclosed region as the active pixel selection.

**B — Double-click:** The user double-clicks anywhere on the canvas (before having snapped). The polygon is automatically closed by drawing a final straight segment from the second-to-last point to the very first anchor point (skipping the literal double-click position). The enclosed region is committed.

**C — Single click on the first point (exact hit):** If the cursor is within snap radius of the first point and the user single-clicks (not a double-click), that is treated the same as the snap-close path described in option A.

After any close, the committed polygon is rasterized into the selection mask, the marching-ants overlay appears, and the tool resets to the **idle** state, ready to begin a new polygon.

### Cancelling and stepping back (keyboard controls)

| Key | Behavior |
|---|---|
| **Escape** | Cancels the entire in-progress polygon. All placed vertices and the rubber-band are discarded. The existing pixel selection (if any) is unchanged. The tool returns to idle. |
| **Backspace** or **Delete** | Removes the most recently placed vertex. The rubber-band retracts to trail from the previous point. If only the first anchor point remains and Backspace is pressed again, the polygon is cancelled entirely (same effect as Escape). |

These keys only act while a polygon is actively being drawn. In idle state they have no effect on the tool.

---

## Interaction States

| State | Description |
|---|---|
| **Idle** | No polygon in progress. Cursor shows the lasso icon. Clicking starts a new polygon. |
| **Drawing** | One or more anchor points have been placed. Rubber-band follows the cursor. Clicking adds a vertex; Backspace removes the last vertex; Escape cancels; double-click closes. |
| **Near-close** | The cursor is within ~12 px of the first anchor point while in Drawing state. The close indicator on the first point becomes visually prominent. The next click closes the polygon. |

---

## Selection Mode

The selection mode is determined by modifier keys held at the moment the **first anchor point** is placed (i.e. the very first click of the polygon). Subsequent clicks within the same polygon do not re-read modifier state.

| Modifier | Mode | Effect on existing selection |
|---|---|---|
| None | **New / Replace** | Replaces the current selection with the new polygon |
| Shift | **Add** | Unions the new polygon with the current selection |
| Alt | **Subtract** | Removes the new polygon area from the current selection |
| Shift + Alt | **Intersect** | Retains only the area covered by both the current selection and the new polygon |

The active mode is also controllable from the **tool options bar** (see below), which acts as the persistent default when no modifier key is held.

---

## Tool Options Bar

The Polygonal Lasso options bar contains a single control group:

**Mode** — four icon buttons corresponding to New, Add, Subtract, and Intersect modes. The active mode is highlighted. Clicking a button sets the default mode for subsequent polygons. Modifier keys at draw time always override the bar setting for that polygon.

No feather or anti-alias controls are present in the initial implementation.

---

## Functional Requirements

- The tool **must** be accessible in the toolbox and activated by the keyboard shortcut **L**.
- While drawing, the rubber-band line **must** update continuously on every pointer-move event, showing the prospective next edge from the last vertex to the current cursor position.
- Each click (outside snap radius of the first point) **must** add a new vertex and draw a permanent edge from the previous vertex.
- When the cursor is within approximately 12 px of the first anchor point (and at least 3 vertices have already been placed), the close indicator **must** become visually prominent.
- Clicking within the snap radius of the first point **must** close the polygon and commit the selection.
- Double-clicking anywhere while drawing **must** close the polygon by connecting the last-placed vertex to the first anchor point and commit the selection. The position of the double-click itself **must not** be added as an extra vertex.
- Pressing **Escape** while drawing **must** cancel the polygon without modifying the current pixel selection.
- Pressing **Backspace** or **Delete** while drawing **must** remove the most recently placed vertex. If removing the last vertex leaves only the starting point, a further Backspace **must** cancel the polygon entirely.
- The committed polygon **must** be rasterized into the `selectionStore` mask using the polygon-fill rule (scanline fill of the closed vertex list).
- Selection mode (replace / add / subtract / intersect) **must** be applied as specified by the modifier key held on the first click, or by the tool options bar setting when no modifier is held.
- After committing, the marching-ants overlay **must** update to reflect the new selection.
- After committing, the tool **must** reset to idle state, ready to begin a new polygon.
- The rubber-band and in-progress vertex segments **must not** be composited into the pixel canvas — they are overlay-only previews.
- Keyboard controls (Escape, Backspace) **must** only respond while a polygon is actively being drawn; they **must not** interfere with other tool states or global shortcuts when the tool is idle.

---

## Acceptance Criteria

- Clicking three or more times to build a triangle, then clicking back on the first point (within 12 px) commits a triangular selection; marching ants appear around the triangle.
- Double-clicking after placing two points produces a closed triangle (the double-click position is ignored; the edge goes from point 2 back to point 1).
- With an active rectangular selection, Shift-clicking to start a polygon and closing it adds the polygon area to the existing selection without replacing it.
- With an active selection, Alt-clicking to start a polygon and closing it removes the polygon area from the selection.
- Pressing Escape after placing four vertices clears the in-progress polygon; the previously committed selection (if any) is unchanged; no new selection is added.
- Pressing Backspace after placing the third vertex reverts to a two-vertex rubber-band; pressing Backspace again reverts to a one-vertex (origin) state; pressing Backspace a third time cancels the polygon entirely.
- Closing a polygon that lies entirely outside the canvas bounds produces an empty (null) selection — no selection is committed and any previous selection is replaced with nothing.
- A polygon with only two placed vertices (a line) that is closed (e.g. by pressing Backspace back to the start and then cancelling) cannot produce a selection — the degenerate case is discarded.
- The rubber-band line is visible during drawing but disappears immediately once the polygon is closed or cancelled.
- The close indicator circle on the first anchor point becomes visually distinct (e.g. filled or highlighted) when the cursor is within 12 px of it.
- Setting the mode to **Add** in the options bar and drawing a polygon adds to the existing selection without requiring the Shift modifier.

---

## Edge Cases & Constraints

- **Single anchor point:** If the user places exactly one point and then presses Escape or Backspace, no selection is committed. The polygon is discarded.
- **Two anchor points (a line):** A closed polygon from two points would be degenerate (zero area). Committing such a shape produces no selection. The tool discards it silently.
- **Very small polygon (< 1 px² area):** May result in zero selected pixels after rasterization. No error is shown; the selection mask is simply empty (or unchanged in add/intersect mode).
- **Polygon entirely outside the canvas:** The rasterization step will fill no pixels. The resulting mask is empty; the marching-ants overlay does not appear.
- **Polygon partially outside the canvas:** Only pixels that lie within the canvas boundary are included in the selection; out-of-bounds portions are clipped.
- **Snap radius is screen-space, not canvas-space:** The ~12 px snap threshold is measured in screen pixels after the current zoom level is applied, so the effective canvas-space threshold varies with zoom. At high zoom the snap area is smaller relative to the canvas; at low zoom it is larger.
- **Modifier keys at mid-polygon:** Changing modifier keys after the first click has no effect on the mode for that polygon session. The mode is locked to the state at the first click.
- **No feathering in initial implementation:** The polygon is always committed with feather = 0 and pixel-perfect fill. Feathering may be added as a future tool option.
- **No anti-aliasing in initial implementation:** The rasterized selection boundary follows exact pixel boundaries; sub-pixel edge softening is not applied.
- **No vertex editing after close:** Once a polygon is committed it becomes a pixel mask. Individual vertices cannot be moved or deleted after the fact.

---

## Related Features

- [select-menu-actions.md](select-menu-actions.md) — Select All, Deselect, Invert Selection commands that act on the same pixel selection produced here
- [find-layers.md](find-layers.md) — layer-targeting that may interact with an active selection
- Marquee Selection Tool (Rectangular) — shares the same `selectionStore` mask and the same mode (Add / Subtract / Intersect) semantics
- Freehand Lasso Tool — sibling lasso-family tool that draws a freehand path rather than straight-edged segments; shares the **L** shortcut family when additional lasso tools are added
- Magic Wand Tool — alternate selection tool that commits to the same mask
