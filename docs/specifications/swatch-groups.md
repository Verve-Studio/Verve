# Swatch Groups

## Overview

The Swatches panel is extended with two complementary capabilities: multi-selection of swatches and named groups. Multi-selection lets users operate on several swatches at once (for example, grouping them together or deleting them as a batch). Named groups let users tag subsets of their palette with a meaningful label and then highlight those members at a glance via a dropdown — without hiding or rearranging any swatches. These features work together to support organized, large palettes while keeping the flat swatch grid as the always-visible source of truth.

---

## User Interaction

### Selecting swatches

- **Plain left-click** — Sets the foreground color to the clicked swatch (existing behavior) and simultaneously makes that swatch the sole selected item. Any previous selection is cleared. This click also becomes the **anchor** for subsequent shift-range selections.
- **Ctrl+left-click** — Toggles the clicked swatch in or out of the current selection without changing the active foreground color. Does not update the anchor.
- **Shift+left-click** — Selects all swatches between the current anchor swatch and the clicked swatch, inclusive (order follows the displayed grid: left-to-right, top-to-bottom). Does not change the active foreground color and does not move the anchor.

Selected swatches are visually distinguished by a colored border or ring that is clearly distinct from both the "active foreground color" indicator and the group-highlight style.

Clicking anywhere in the swatch panel that is not a swatch cell (e.g. the empty area or the panel header) clears the selection.

### Context menu

Right-clicking any swatch opens a context menu at the cursor position. The context menu contains:

1. **Delete** — Immediately removes the right-clicked swatch from the palette. This action applies to the right-clicked swatch only, regardless of what else is currently selected. No confirmation dialog is shown.
2. **Group Selected Entries…** — Opens a modal prompt asking the user to enter a group name. On confirm, a group with that name is created (or, if a group with that name already exists, the selected swatches are added to it). The swatches that join the group are determined as follows:
   - If one or more swatches are currently selected, those swatches are grouped.
   - If no swatches are currently selected, only the right-clicked swatch is grouped.

   This item is always enabled, even if only a single swatch is selected or the current selection is empty.

### Group dropdown

Two new controls appear in the Swatches panel header, to the **left of the hamburger (≡) menu button**:

1. **Group dropdown** — A select-like control whose default label is "All swatches". It lists the names of all currently defined groups in addition to the "All swatches" entry. Selecting a group **highlights** every swatch that belongs to that group with a distinct visual style (separate from the selection highlight). All swatches remain visible regardless of which group is selected — the dropdown is purely a highlight filter, not a visibility filter.

2. **Remove group button (×)** — A button immediately adjacent to the group dropdown that disbands the currently selected group. When clicked, the group record is deleted, but every swatch that belonged to it remains in the palette. The button is **disabled** (non-interactive, visually dimmed) when "All swatches" is selected in the dropdown.

### Renaming a group

A group name can be changed in two ways (either is acceptable in the implementation):
- Via a rename option in the context menu when right-clicking a swatch that belongs to the group, or
- By double-clicking the group's name directly within the dropdown list.

The renamed group retains all of its member swatches. The new name must be unique among existing group names (case-sensitive); the UI must prevent saving a duplicate name.

---

## Functional Requirements

- The application must support zero or more named swatch groups. Each group has a unique, non-empty, case-sensitive name.
- A swatch may belong to **zero, one, or multiple** groups simultaneously. Group membership is non-exclusive.
- Swatches are identified within a group by their **index** in the canonical swatch array (insertion order). If a swatch is removed from the palette, all group records must update their indices to reflect the new positions of the remaining swatches.
- The panel header must display the group dropdown and the remove-group button to the left of the hamburger menu button whenever the Swatches tab is active.
- Selecting a group in the dropdown must apply a distinct highlight style to all member swatches without hiding, reordering, or deselecting any other swatches.
- The "All swatches" dropdown entry must always be present as the first option and must not be deletable or renameable.
- The remove-group button must disband the active group (delete the group record from state) without removing any swatches from the palette. It must be disabled when "All swatches" is the active dropdown selection.
- The context menu "Group Selected Entries…" action must open a text prompt. On confirmation with a non-empty name, the group is created or extended and the panel returns focus to the swatch grid.
- If the user cancels the group-name prompt (presses Escape or clicks Cancel), no group is created or modified.
- Selecting a group in the dropdown does **not** alter the active foreground or background color.
- All group data must persist in the `.verve` file (see Data Model below) and must be restored faithfully on file open.
- `SwatchGroup` must be exported from `src/types/` so other features can reference the type.

---

## Acceptance Criteria

- Clicking a swatch sets the foreground color and highlights that swatch as selected; all other swatches appear unselected.
- Ctrl-clicking a swatch adds it to an existing selection without clearing the prior selection and without changing the foreground color.
- Shift-clicking a swatch selects the contiguous range of displayed swatches between the anchor and the clicked swatch, inclusive.
- Right-clicking a swatch opens a context menu with "Delete" and "Group Selected Entries…".
- "Delete" removes only the right-clicked swatch, even when other swatches are also selected.
- "Group Selected Entries…" with two swatches selected creates a group containing exactly those two swatches, confirmed by selecting the new group in the dropdown and observing that exactly those two swatches are highlighted.
- "Group Selected Entries…" with no swatches selected creates a group containing only the right-clicked swatch.
- The group dropdown defaults to "All swatches" when no groups exist. The remove-group button is disabled in this state.
- After creating a group named "Skin Tones", the dropdown lists "Skin Tones" as an option. Selecting it highlights all member swatches in the group-highlight style.
- Clicking the remove-group (×) button while "Skin Tones" is selected disbands the group; "Skin Tones" disappears from the dropdown. All previously grouped swatches remain in the palette.
- Renaming a group updates the name in the dropdown immediately. Member swatches are unchanged.
- Saving a `.verve` file and reopening it restores all groups with the correct names and member indices.
- Opening a version 2 `.verve` file (no `swatchGroups` field) leaves groups at their default empty state without error.

---

## Data Model

Group data is stored in application state as `swatchGroups: SwatchGroup[]`, where:

```
SwatchGroup {
  id:            string    // stable unique identifier (e.g. UUID), not user-visible
  name:          string    // user-assigned display name, unique and non-empty
  swatchIndices: number[]  // indices into the canonical swatches array (insertion order)
}
```

- `swatchGroups` is added to `AppState` and to the per-tab `TabSnapshot` used for multi-document state.
- The `.verve` file format is bumped to **version 3** to accommodate `swatchGroups`. Version 3 files include both the `swatches` array (introduced in version 2) and a `swatchGroups` array.
- When opening a **version 2** `.verve` file, `swatchGroups` defaults to an empty array. No error is raised.
- When opening a **version 1** `.verve` file, both `swatches` and `swatchGroups` fall back to their application defaults.
- If a version 3 file contains a `swatchGroups` entry whose `swatchIndices` reference out-of-range indices, the file open must be aborted and an error surfaced to the user. Partially valid groups must not be applied.

---

## Edge Cases & Constraints

- If a swatch is deleted from the palette while it is a member of one or more groups, all affected groups must have their index lists updated atomically in the same state dispatch (shift all indices greater than the removed index down by one; remove any entry that matched the deleted index exactly).
- A group may become empty (zero members) if all of its swatches are individually deleted. Empty groups remain in the dropdown and can be renamed, populated again, or disbanded. They do not cause errors.
- The selection state (which swatches are currently selected) is transient UI state and is **not** persisted to the `.verve` file. On file open, the selection is always cleared.
- The active dropdown selection (which group is currently highlighted) is likewise transient and resets to "All swatches" on file open or when a new tab is opened.
- Group names are compared case-sensitively: "Blues" and "blues" are considered different names.
- The maximum length of a group name is not formally bounded, but the dropdown UI should truncate names that would overflow the control width, showing the full name in a tooltip on hover.
- Shift-range selection follows the **displayed** (hue-sorted) grid order, not the canonical insertion order. The anchor is always the most recent plain-clicked swatch.
- The group-highlight style must be visually distinguishable from the selection-highlight style so a swatch that is both selected and a member of the active group has an unambiguous appearance.
- Adding a swatch to a group (via "Group Selected Entries…") does not alter the selection state or the active foreground color.
- Drag-and-drop reordering of swatches within a group is out of scope. Collapsing or expanding groups as a view mode is out of scope. Clicking a group name to set a color is out of scope.

---

## Related Features

- [Palette Persistence in .verve Files](palette-verve-persistence.md) — defines the `.verve` format versioning model that swatch groups extend to version 3.
- [Swatches Panel: Scrolling and Hue Grouping](swatches-scroll-grouping.md) — defines the scrollable grid and hue-sort display order that swatch group highlighting and shift-range selection are applied on top of.
- [Palette File I/O](palette-file-io.md) — covers import/export of palettes to external formats (`.ase`, `.gpl`, etc.); group data is not expected to round-trip through those formats.
