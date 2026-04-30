# Find Layers

## Overview

**Find Layers** is a real-time name filter for the Layers panel that lets users quickly locate layers in a complex document. Typing in the filter bar hides every layer whose name does not match the query, narrowing the visible list without affecting the document in any way. Clearing the filter instantly restores the full layer stack. This replicates the layer search bar found in Photoshop's Layers panel.

---

## User Interaction

1. The user opens **Select → Find Layers** from the top menu bar, or presses **Alt+Shift+Ctrl+F** (Windows/Linux) / **Alt+Shift+Cmd+F** (macOS).
2. A text input appears at the top of the Layers panel, directly below the panel's toolbar row (blend mode / opacity controls). The input is immediately focused and ready to accept text.
3. As the user types, the Layers panel updates in real time: layers whose names do not contain the typed string are hidden; layers whose names contain the string remain visible.
4. When a matching layer lives inside a group, the group row itself remains visible even if the group's own name does not match — this preserves the visual hierarchy and context for matched layers.
5. When the filter is active, a subtle visual indicator (e.g., a tinted or highlighted input) communicates that the layer list is currently filtered.
6. To clear the filter, the user either:
   - Presses **Escape**, which clears the input text, closes/collapses the filter bar, and restores the full layer stack; or
   - Manually deletes all text in the input field, which restores the full layer stack while keeping the input visible and focused.
7. The user may also click an **×** clear button inside the input to remove the text and restore all layers.
8. Clicking anywhere outside the filter input (e.g., the layer list, canvas, or another panel) blurs the input but does **not** close or reset the filter — the filter remains active with the last typed query until the user explicitly clears it.
9. The filter bar collapses (becomes invisible and takes no vertical space) when it is both unfocused and empty.

---

## Functional Requirements

- The **Select** menu **must** contain a **Find Layers** item with the shortcut **Alt+Shift+Ctrl+F** (Windows/Linux) and **Alt+Shift+Cmd+F** (macOS), positioned between the **Deselect Layers** item and the **Invert Selection** item, separated from each by a divider.
- Invoking **Find Layers** **must** open and focus the filter input in the Layers panel. If the input is already visible, it **must** simply re-focus it without clearing the current query.
- The filter input **must** perform a **case-insensitive substring match** on the layer name. A layer is considered matching if its name contains the query string anywhere within it.
- Non-matching layers **must** be hidden from the Layers panel list while the filter is active. They are not deleted, moved, or altered in any way.
- Matching layers **must** remain fully visible with their thumbnail, visibility toggle, lock state, and name shown normally.
- A group layer **must** remain visible whenever at least one of its descendants (direct or nested) matches the filter, regardless of whether the group's own name matches.
- If a group's own name matches the filter, the group row **must** remain visible along with all of its descendants, regardless of whether they individually match.
- Adjustment and mask child layers attached to a matching parent **must** remain visible alongside their parent.
- The filter **must** be a pure display filter: it **must not** reorder, delete, lock, hide (in the document sense), or otherwise alter any layer's properties or the layer stack.
- The active layer and all selected layers **must** remain unchanged while the filter is active.
- While the filter input is focused, typing characters **must not** trigger global tool-switching keyboard shortcuts (e.g., pressing **B** must not activate the Brush tool).
- Pressing **Escape** while the filter input is focused **must** clear the text, collapse the input, and restore the full layer list.
- Removing all text from the input manually **must** immediately restore the full unfiltered layer list while keeping the input open.
- The filter **must not** persist across sessions. Opening Verve or switching to a different document tab **must** present a fully unfiltered layer list with the filter bar collapsed.
- Switching document tabs while a filter is active **must** reset and collapse the filter for the newly active tab.

---

## Acceptance Criteria

- Opening **Select → Find Layers** shows the filter input and moves keyboard focus to it.
- Pressing **Alt+Shift+Ctrl+F** / **Alt+Shift+Cmd+F** with the Layers panel visible opens and focuses the filter input.
- Pressing the same shortcut again when the input is already focused does not clear the current query.
- Typing `"back"` in a document containing layers named `"Background"`, `"Shadow"`, and `"Character"` shows only `"Background"` (case-insensitive match); `"Shadow"` and `"Character"` are hidden.
- Typing `"BACK"` produces the same result as typing `"back"`.
- A layer named `"Sky"` inside a group named `"Scenery"` with a sibling layer named `"Ground"`: typing `"sky"` shows both `"Scenery"` (the parent group) and `"Sky"` (the match); `"Ground"` is hidden.
- Typing `"scen"` shows `"Scenery"` and all of its children (`"Sky"` and `"Ground"`), because the group name itself matches.
- When the filter is active, clicking a visible layer row in the Layers panel sets it as the active layer normally.
- Pressing Escape while the filter input is focused clears the text and restores all layers; the input collapses.
- Deleting all characters from the input manually restores all layers and keeps the input focused.
- At no point during filtering is any layer's `visible` property, pixel data, position, or order changed.
- Pressing **B** while the filter input is focused does not switch the active tool to Brush.
- After switching to a second document tab, the Layers panel shows that tab's full unfiltered layer list with the filter collapsed.
- Switching back to the original tab also shows a full unfiltered layer list.
- The filter bar is not visible (takes no space) when empty and unfocused.

---

## Edge Cases & Constraints

- **No matches:** When the typed query matches no layer in the document, the Layers panel list is empty. No error or placeholder message is required, but the filter input remains active and editable.
- **Single layer:** A document with only one layer behaves normally — the layer is shown if it matches, hidden if it does not.
- **Empty canvas / no layers:** If the document has no layers, the filter input can still be opened and closed; opening it against an empty layer stack simply does nothing visible.
- **Collapsed groups:** A group that is collapsed in the Layers panel (children hidden by the collapse toggle) and whose name matches the filter remains visible as a collapsed row. If a child matches but the group is collapsed, the group row is surfaced (expanded in the filtered view or shown as a collapsed row with a match indicator — but the user sees at minimum the group row).
- **Adjustment and mask child layers:** These are always shown or hidden together with their parent pixel layer. They are not independently matched against the filter query.
- **Very long names:** The filter input must handle layer names of arbitrary length; matching is always substring-based regardless of name length.
- **Whitespace-only query:** A query consisting only of spaces is treated as a non-empty query. Layers whose names contain a space remain visible; others are hidden. (An all-whitespace query is distinct from an empty query.)
- **Active layer hidden by filter:** If the currently active layer's name does not match the filter, the layer is hidden in the panel but remains the active layer for all tool operations. The hidden active layer is not automatically changed.
- **Undo/redo during filter:** Undo and redo operations function normally while the filter is active. The filter does not interact with history — it only affects what is displayed in the Layers panel.
- **Layer renamed while filter is active:** If the user renames a layer (double-clicking its name in the panel), the filter re-evaluates immediately after the rename is confirmed, potentially hiding or showing the renamed layer.

---

## Related Features

- [select-menu-actions.md](select-menu-actions.md) — the Select menu that hosts the Find Layers entry
- [layer-groups.md](layer-groups.md) — group hierarchy rules that govern how ancestor rows are surfaced during filtering
