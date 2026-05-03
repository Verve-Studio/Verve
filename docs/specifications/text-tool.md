# Text Tool

## Overview

The text tool lets users place, style, and edit vector-quality text directly on the canvas. Text exists as a dedicated layer type (`TextLayerState`) that stores all typographic metadata and is rasterized on demand via Canvas 2D. Text layers remain fully editable at any time — content, font, size, color, spacing, and bounding box can all be changed non-destructively until the user explicitly converts the layer to pixels via **Rasterize Layer**. Text metadata is saved with the `.verve` document and survives file reload.

---

## Text Layer Data Model

The complete set of fields stored on a text layer:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique layer identifier |
| `name` | `string` | Display name in the Layers panel |
| `visible` | `boolean` | Visibility toggle |
| `opacity` | `number` | Layer opacity 0–1 |
| `locked` | `boolean` | Prevents edits when true |
| `blendMode` | `BlendMode` | Compositing mode |
| `type` | `'text'` | Discriminant |
| `text` | `string` | Raw text content including newlines |
| `x` | `number` | Canvas-space X of the top-left anchor of the bounding box |
| `y` | `number` | Canvas-space Y of the top-left anchor of the bounding box |
| `boxWidth` | `number` | Fixed box width in canvas pixels; `0` = auto (point text) |
| `boxHeight` | `number` | Fixed box height in canvas pixels; `0` = auto |
| `fontFamily` | `string` | Font family name (e.g. `"Arial"`) |
| `fontSize` | `number` | Size in canvas pixels (not points) |
| `bold` | `boolean` | Bold weight |
| `italic` | `boolean` | Italic style |
| `underline` | `boolean` | Underline decoration |
| `strikethrough` | `boolean` | Strikethrough decoration |
| `align` | `'left' \| 'center' \| 'right' \| 'justify'` | Horizontal text alignment |
| `color` | `{ r: number; g: number; b: number; a: number }` | Text fill color, channels 0–255 |
| `letterSpacing` | `number` | Extra space between characters in canvas pixels; `0` = none |
| `lineHeight` | `number` | Line height multiplier relative to `fontSize`; default `1.2` |
| `kerning` | `'auto' \| 'none'` | `'auto'` applies font kerning pairs; `'none'` disables all pair adjustments |

**Color representation:** the `color` field uses integer channels 0–255 internally to remain consistent with `rgba8` layers. The rasterizer constructs the CSS `rgba()` string from these values directly.

**Extending later:** tracking (global letter spacing), baseline shift, and per-character overrides are intentionally out of scope for this version. The `letterSpacing` field covers the most common use case (tracking) at the whole-text level.

---

## Editing Interaction

### Creating a text layer

**Point text (click):**
1. Select the Text tool.
2. Click on an empty area of the canvas.
3. A new text layer is created at the click position with `boxWidth = 0`, `boxHeight = 0` (auto-size).
4. The layer enters **editing mode** immediately — a cursor appears inside the bounding box overlay.
5. The new layer's color is initialized from the current **primary color**.
6. Typography properties (font family, size, weight, etc.) are inherited from the tool options bar.

**Area text (click-drag):**
1. Select the Text tool.
2. Press and hold on an empty area of the canvas, then drag to define a rectangle.
3. On pointer-up, a new text layer is created with `boxWidth` and `boxHeight` set to the dragged dimensions and `x`/`y` set to the top-left corner of the drag rectangle.
4. The layer enters editing mode immediately.

**Re-entering editing mode:**
- With the Text tool active, click anywhere inside an existing text layer's bounding box to enter editing mode for that layer.
- Double-clicking a text layer row in the Layers panel (while any tool is active) switches to the Text tool and enters editing mode for that layer.

### While editing

- The **bounding box overlay** (dashed blue border) is drawn around the text layer on the canvas overlay. Resize handles appear at all eight cardinal and corner positions.
- The **rendered text** (rasterized from `TextLayerState`) remains visible behind the editor at all times. It updates live as the user types.
- A **transparent contenteditable overlay** (or invisible textarea) is positioned over the bounding box at the correct screen-space position and zoom, capturing keyboard input. The overlay is styled to exactly match the layer's typography settings so the cursor position feels natural.
- The text layer's `text` field is updated on every keystroke and the rasterizer re-runs immediately, keeping the canvas preview in sync.
- The overlay must not cover or obscure the rendered text beneath it — the overlay itself is transparent; only the blinking cursor and text selection highlights are drawn on top.

### Exiting editing mode

Editing mode ends when any of the following occurs:
- The user presses **Escape**.
- The user switches to a different tool.
- The user clicks outside the bounding box overlay (not on a resize handle).
- A modal dialog opens.

On exit, the layer state is committed as-is. No confirmation is needed. If the text field is empty when editing ends, the text layer is automatically deleted.

---

## Bounding Box

### Point text (auto-size, `boxWidth = 0`)

- The bounding box width expands to fit the widest line of text. There is no hard wrapping — the user must press **Enter** to create new lines.
- The bounding box height expands to fit all lines.
- The overflow behavior does not apply because the box always fits the content.
- Resize handles are shown but dragging any handle converts the layer to **area text** by setting `boxWidth`/`boxHeight` to the new dragged dimensions.

### Area text (fixed-size, `boxWidth > 0`)

- Text wraps at the box width boundary. Wrapping follows `white-space: pre-wrap; overflow-wrap: break-word` semantics (words break at spaces; words wider than the box are broken at the character level).
- Lines that exceed the box height are **clipped** and not rendered (overflow is hidden).
- An **overflow indicator** — a small `+` icon in a square, identical to Photoshop's — is drawn at the bottom-right corner of the bounding box whenever the text overflows the height. This is drawn on the canvas overlay, not as a pixel on the layer.
- Resize handles allow the user to change both width and height. Dragging the top or left edges moves the `x`/`y` anchor while keeping the right/bottom edge fixed.
- Minimum box size is 20 canvas pixels in each dimension.

### Resize handles

Eight handles are shown at the N, NE, E, SE, S, SW, W, NW positions of the bounding box. The cursor changes to the appropriate directional resize cursor on hover. Dragging is constrained to the handle's axis (cardinal handles resize one dimension; corner handles resize both). There is no Shift-constrain-to-aspect-ratio on text boxes — aspect ratio lock is not available for text layers.

---

## Typography Controls (Tool Options Bar)

All controls in the tool options bar are updated live: changing any value immediately re-rasterizes the active text layer. When no text layer is active, changing a value sets the default for the next text layer created.

| Control | Widget | Range / Values | Unit |
|---|---|---|---|
| Font family | Searchable dropdown, populated by `queryLocalFonts` (falls back to a curated probe list) | System fonts | — |
| Font size | Numeric slider + text input | 1–3000 | canvas pixels |
| Bold | Toggle button (`B`) | on/off | — |
| Italic | Toggle button (`I`) | on/off | — |
| Underline | Toggle button (`U`) | on/off | — |
| Strikethrough | Toggle button (`S` with strikethrough) | on/off | — |
| Alignment | Four-button group (left / center / right / justify) | — | — |
| Letter spacing | Numeric slider + text input | −500 to 2000 | milliems (1/1000 em) |
| Line height | Numeric slider + text input | 0.1 to 10.0 | em multiplier |
| Kerning | Dropdown | `Auto`, `None` | — |
| Color swatch | Clickable color swatch | — | — |

**Letter spacing units:** values are stored in the `letterSpacing` field as canvas pixels computed at render time from the em multiplier. The UI displays and accepts values in **milliems** (thousandths of an em, matching Photoshop's tracking field) for familiarity. The rasterizer converts: `pixelOffset = (milliems / 1000) * fontSize`.

**Line height:** stored as a unitless multiplier (`lineHeight`). A value of `1.2` means each line's top is spaced `fontSize × 1.2` pixels below the previous line's top. Displayed in the UI as a plain number (e.g. `1.20`). The default is `1.2`.

**Kerning:** `'auto'` enables CSS `font-kerning: auto` on the Canvas 2D context (the browser/OS applies font pair tables). `'none'` sets `font-kerning: none`. Stored as the `kerning` field on `TextLayerState`.

---

## Font Color

The text layer's fill color is controlled by two synchronized mechanisms:

1. **Color swatch in the tool options bar** — a small rectangular swatch displays the active text layer's current color (or the tool's pending color if no layer is selected). Clicking it opens the application's standard color picker dialog. The selected color is applied to the active text layer immediately.

2. **Primary color** — when a new text layer is created, its color is initialized to the current primary color. Changing the primary color does **not** automatically update existing text layers; it only affects newly created layers. This avoids unintentional color changes to existing text.

When editing mode is active and the user changes the primary color or picks a new color from the swatch, the active text layer's `color` field is updated immediately and the layer re-rasterizes.

---

## Metadata Persistence

Text layer metadata is saved as part of the `.verve` document format. The full `TextLayerState` object — including `text`, all typography fields (`fontFamily`, `fontSize`, `bold`, `italic`, `underline`, `strikethrough`, `align`, `color`, `letterSpacing`, `lineHeight`, `kerning`), and bounding-box geometry (`x`, `y`, `boxWidth`, `boxHeight`) — is serialized directly as JSON within the document.

The rasterized pixel data for a text layer is **also** saved alongside the metadata (as a PNG in the same layer entry as pixel layers). This ensures that text renders correctly even if the required font is not installed on the machine that opens the file. The rasterized pixels are treated as a display cache; on open, if the font is available, the layer re-rasterizes from metadata to guarantee pixel-perfect output at the current canvas size.

Text layers must survive a full save/reload cycle with all properties intact and remain editable (not converted to pixel layers) after reopening.

---

## Layer Panel

### Appearance

- Text layers display a **"T" icon** (the same serif capital T used in Photoshop and most professional editors) in place of the layer thumbnail.
- The layer name defaults to the first characters of the text content, truncated at 30 characters, when the user has not explicitly renamed the layer. If the text content is empty or the user has set a custom name, the custom name is used.
- Auto-naming updates live as the user types during the first editing session. After the user manually renames the layer (double-click on name → type → commit), auto-naming stops.

### Double-click to edit

Double-clicking the layer row (not the name label, but anywhere in the non-interactive area of the row) while the Text tool is active re-enters editing mode for that layer. If a different tool is active, the Text tool becomes active and editing mode is entered.

### Rename

Double-clicking the **name label** area of the layer row opens the inline name editor (same behavior as pixel layers). Pressing Enter or clicking away commits the new name. This does not enter text content editing mode.

### Context menu

The Layers panel context menu for a text layer includes:
- **Edit Text** — enters editing mode (same as double-click on the row)
- **Rasterize Layer** — converts to a pixel layer permanently (see Rasterization)
- Standard entries shared with other layer types: Duplicate Layer, Delete Layer, Add Mask

---

## Rasterization

Text layers are rasterized using **Canvas 2D** (`CanvasRenderingContext2D`). This is the correct and intentional approach — Canvas 2D provides system-quality font rendering including subpixel hinting, kerning, and ligatures without requiring a custom text renderer.

### Live rasterization (non-destructive)

Every time a text layer's state changes (content, any typography property, or bounding box dimensions), the rasterizer runs and uploads the result to the layer's GPU texture. The layer pixel buffer is always canvas-sized with `offsetX = 0`, `offsetY = 0`. This is a known inefficiency but is acceptable for the current architecture; the rasterizer is fast enough at typical text layer sizes.

The rasterization pipeline:
1. Clear the layer buffer to fully transparent.
2. Create a temporary off-screen `<canvas>` at the document dimensions.
3. Configure the 2D context with the layer's font, size, style, color, and spacing properties.
4. Split `text` on `\n` to get paragraphs. Each paragraph is word-wrapped using `wrapLine()` to produce display lines (for area text, `boxWidth > 0`; for point text, no wrapping).
5. Draw each line with correct horizontal alignment (`fillText`) and apply underline/strikethrough decorations as filled rectangles at the appropriate offsets.
6. Copy the resulting pixel data into `gl.data` and call `renderer.flushLayer(layer)`.

**Strikethrough** is rendered as a filled rectangle at `y = lineY + fontSize × 0.35` with thickness `max(1, round(fontSize / 14))`, matching the underline thickness rule.

**Letter spacing** is applied by measuring each character individually and advancing the draw cursor by `characterWidth + letterSpacingPx` between glyphs. This replicates CSS `letter-spacing` semantics in Canvas 2D.

**Line height** is applied by multiplying `lineHeight × fontSize` to compute the pixel distance between baseline anchors of consecutive lines.

### Destructive rasterization (Rasterize Layer)

**Layer → Rasterize Layer** (or the context menu equivalent) converts a text layer to a standard pixel layer permanently. After this operation:
- The layer type becomes a pixel layer.
- All `TextLayerState`-specific fields (`text`, `fontFamily`, `bold`, etc.) are discarded.
- The pixel data captured at the moment of rasterization is retained.
- The operation is undoable via the history stack.
- The layer's name is preserved.

This operation is available from:
- The **Layer** top menu → Rasterize Layer
- The Layers panel context menu → Rasterize Layer

---

## Move Tool Interaction

Text layers can be repositioned with the Move tool. Dragging a text layer moves its `x` and `y` position on the canvas. The bounding box (and all text within it) moves as a unit. There is no pixel-level manipulation — moving a text layer updates `x`/`y` in the layer state and re-rasterizes with the new position.

Hit-testing for the Move tool uses the text layer's bounding box (same as the Text tool's hover highlight): the layer is considered "grabbed" if the pointer is within `{x, y, x + effectiveBoxWidth, y + effectiveBoxHeight}`.

---

## Multi-line Editing

### Key behavior

| Key | Behavior |
|---|---|
| **Enter** | Insert a newline (`\n`) at the cursor — always, for both point text and area text |
| **Shift+Enter** | Identical to Enter in Verve (no soft-wrap distinction; behavior matches Photoshop) |
| **Tab** | Insert a tab character (`\t`). Tab stops are every `4 × fontSize` canvas pixels (measured in the rasterizer by spacing to the next multiple of the tab stop grid). |
| **Escape** | Commit and exit editing mode |
| **Backspace / Delete** | Standard character deletion |
| **Ctrl+A / Cmd+A** | Select all text in the layer |
| **Arrow keys** | Move cursor within text |
| **Home / End** | Move cursor to start/end of current line |
| **Ctrl+Z / Cmd+Z** | Undo within the text editing session (native textarea undo); does **not** pop the Verve history stack while editing mode is active |

The text input area supports standard OS-level text services including IME (input method editors for CJK and other languages), autocorrect (OS-managed), and system clipboard (Ctrl/Cmd+C/X/V).

---

## Edge Cases & Constraints

- **Empty layer on exit:** if the user creates a text layer but exits editing mode without typing any content, the layer is automatically removed.
- **Missing font on open:** if the `.verve` file references a font not installed on the current machine, the rasterized PNG cache is used for display. The layer remains a text layer (not rasterized); an indicator (warning icon in the layer row) signals that the font is substituted. The user can re-rasterize with any available font by changing the font family.
- **Indexed color mode:** text layers are always rasterized as RGBA8 internally, regardless of the document's pixel format. When the document is in indexed-color mode, the text layer is composited using the RGBA8 path; it cannot reference palette indices directly.
- **HDR / rgba32f documents:** text layers are rasterized as RGBA8 and then composited into the float pipeline at 8-bit precision. HDR text (values > 1.0) is not supported.
- **Very small font sizes (< 6px):** rendered but may be illegible; no minimum is enforced.
- **Zoom and DPI:** the editor overlay is scaled to match the current canvas zoom and the device pixel ratio so that the cursor and selection highlight align visually with the rendered text.
- **Locked layers:** while `locked = true`, the Text tool will not enter editing mode for that layer, and the Move tool will not reposition it. The bounding box hover outline is still shown but the cursor indicates the locked state.
- **Undo during editing:** Ctrl/Cmd+Z while editing mode is active is intercepted by the textarea and performs native undo within the text session. It does **not** pop the Verve history stack. Once editing mode ends, the entire editing session is committed as a single history entry.

---

## Related Features

- [Layers Panel](../specifications/find-layers.md) — layer panel interactions, rename, visibility
- [Unified Rasterization Pipeline](../specifications/unified-rasterization-pipeline.md) — how text layers are included in flatten/export/merge
- [HDR / FP32 Mode](../specifications/hdr-fp32-mode.md) — pixel format constraints affecting text compositing
- [Indexed Color Mode](../specifications/indexed-color-mode.md) — palette mode constraints affecting text compositing
- [Free Transform](../specifications/free-transform.md) — free transform does not apply to text layers; rasterize first
