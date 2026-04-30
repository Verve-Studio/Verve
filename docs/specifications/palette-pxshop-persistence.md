# Palette Persistence in .verve Files

## Overview

When a user saves their work as a `.verve` project file, the current swatch palette is included in that file alongside the canvas and layer data. When the file is reopened, the palette is restored exactly as it was when the file was saved. This makes the swatch palette a first-class part of a Verve project, so collaborators and future sessions always start with the intended color set rather than the application default.

## User Interaction

This feature requires no new UI. It operates transparently as part of the existing **File → Save** and **File → Open** workflows:

1. The user works on a document and customizes the swatch palette — adding, removing, or generating colors.
2. The user saves the project via **File → Save** or **File → Save As…**, choosing a `.verve` path as usual.
3. The swatch palette at the time of saving is silently embedded in the project file.
4. The user later reopens the `.verve` file via **File → Open** (or by double-clicking the file outside the app).
5. The canvas, layers, and swatch palette are all restored to their saved state. The swatches panel reflects the palette that was active when the file was last saved.

## Functional Requirements

- When saving a `.verve` file, the application must write the complete current swatch palette into the file as an array of `{r, g, b, a}` objects under the key `swatches`.
- Saved `.verve` files that include a `swatches` field must use **format version 2**. The `version` field in the file must be set to `2`.
- When opening a **version 2** `.verve` file, the application must replace the current swatch palette with the `swatches` array from the file. All four channels (`r`, `g`, `b`, `a`) are integers in the range 0–255.
- When opening a **version 1** `.verve` file (which has no `swatches` field), the application must leave the swatch palette at its current application default. No palette data is assumed or inferred from the file.
- Swatches must round-trip without loss: every color and alpha value saved into the file must be restored byte-for-byte when the file is reopened.
- If a version 2 file is missing the `swatches` key, or if any swatch entry contains out-of-range or non-integer channel values, the open operation must be aborted and the current swatches must remain unchanged. An error must be surfaced to the user.
- The swatch data must not affect or interfere with the canvas, layer, or adjustment data already present in the file.

## Acceptance Criteria

- Saving a project produces a `.verve` file where the top-level `version` field equals `2`.
- The file contains a `swatches` array whose entries match the swatches visible in the Swatches panel at the time of saving, including any semi-transparent entries (alpha < 255).
- Reopening the saved file restores the Swatches panel to the exact palette that was saved — same colors, same count, same alpha values.
- Opening a **version 1** `.verve` file leaves the Swatches panel unchanged (application defaults are preserved).
- Saving with an empty swatch palette writes `"swatches": []` and reopening that file results in an empty Swatches panel.
- A `.verve` file opened by a JSON viewer shows the correct structure:
  ```json
  {
    "version": 2,
    "canvas": { ... },
    "layers": [ ... ],
    "swatches": [
      { "r": 255, "g": 0, "b": 0, "a": 255 },
      ...
    ]
  }
  ```
- Opening a corrupted version 2 file (missing `swatches`, non-integer channel values, or out-of-range values) does not crash the application and does not alter the existing swatches.

## Edge Cases & Constraints

- **Version 1 files are backward compatible.** No migration or re-save is forced on existing files. The format version only changes when the user explicitly saves.
- **Semi-transparent swatches** (alpha < 255) must survive the round-trip. The alpha channel must not be silently set to 255 or dropped during serialization or deserialization.
- **Empty palette.** Saving with no swatches is valid and produces `"swatches": []`. Reopening such a file replaces the current palette with an empty list.
- **Large palettes.** Serializing hundreds of swatches as JSON is expected to be instantaneous at realistic sizes; no progress indicator is required.
- **Swatch ordering.** Swatches are saved in their logical application order (the order they appear in the internal state). The display order in the panel (which may be sorted by hue) does not affect what is persisted.
- This feature does not affect the standalone `.palette` file format described in the Palette File I/O spec. The two persistence mechanisms are independent.

## Related Features

- [Palette File I/O](palette-file-io.md) — standalone `.palette` file save/open for sharing palettes independently of a project.
- [Swatches Panel: Scrolling and Hue Grouping](swatches-scroll-grouping.md) — describes the display-time hue sorting that determines how restored swatches are presented in the panel.
- [Generate Palette](generate-palette.md) — generates swatches from image content; the resulting palette is saved as part of the project when the document is next saved.
