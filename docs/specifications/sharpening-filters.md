# Sharpening Filters

## Overview

Verve provides four destructive sharpening filters that increase the apparent crispness of edges and fine details on the active pixel layer. Two are instant-apply filters (**Sharpen** and **Sharpen More**) that take effect immediately with no dialog. Two are parametric filters (**Unsharp Mask** and **Smart Sharpen**) that open a floating dialog with live preview controls, matching the interaction model of Gaussian Blur and other Verve filter dialogs. All four are undoable via the standard undo history. The filters are intended to complement Verve's blur and destructive-edit workflow, giving users full control over edge clarity — from a quick one-click sharpen to a precise, algorithm-driven sharpening pass.

## User Interaction

### Sharpen and Sharpen More (instant-apply)

1. The user ensures the target pixel layer is active in the Layer Panel.
2. The user selects **Filters → Sharpen → Sharpen** (or **Sharpen More**) from the menu bar. If the active layer is not a pixel layer, the menu item is grayed out.
3. The filter applies immediately — no dialog is shown. The canvas updates at once to reflect the sharpened pixels.
4. One undo history entry is recorded ("Sharpen" or "Sharpen More"), and the operation is complete.
5. If an error occurs during processing, a toast notification is shown and the layer is left unchanged.

### Unsharp Mask (parametric)

1. The user ensures the target pixel layer is active in the Layer Panel.
2. The user selects **Filters → Sharpen → Unsharp Mask…** from the menu bar. If the active layer is not a pixel layer, the menu item is grayed out.
3. The **Unsharp Mask** dialog opens. The canvas shows the layer's current unmodified pixels.
4. The dialog presents three controls:
   - **Amount** — integer slider and numeric input, range 1–500 (%), default 100.
   - **Radius** — integer slider and numeric input, range 1–64 (px), default 2.
   - **Threshold** — integer slider and numeric input, range 0–255 (levels), default 0.
5. As the user adjusts any control, a sharpened preview appears on the canvas after a short debounce delay. The dialog remains open during preview.
6. If an active selection is present, a note in the dialog indicates that sharpening will apply only to the selected area.
7. While the preview is being computed, a busy spinner is shown inside the dialog.
8. The user clicks **Apply** to commit the filter, or **Cancel** (or presses Escape) to discard the preview and leave the layer unchanged.

### Smart Sharpen (parametric)

1. The user ensures the target pixel layer is active in the Layer Panel.
2. The user selects **Filters → Sharpen → Smart Sharpen…** from the menu bar. If the active layer is not a pixel layer, the menu item is grayed out.
3. The **Smart Sharpen** dialog opens. The canvas shows the layer's current unmodified pixels.
4. The dialog presents four controls:
   - **Amount** — integer slider and numeric input, range 1–500 (%), default 100.
   - **Radius** — integer slider and numeric input, range 1–64 (px), default 2.
   - **Reduce Noise** — integer slider and numeric input, range 0–100 (%), default 10.
   - **Remove** — dropdown with two options: "Gaussian Blur" and "Lens Blur".
5. As the user adjusts any control, a sharpened preview appears on the canvas after a short debounce delay.
6. If an active selection is present, a note in the dialog indicates that sharpening will apply only to the selected area.
7. While the preview is being computed, a busy spinner is shown inside the dialog.
8. The user clicks **Apply** to commit the filter, or **Cancel** (or presses Escape) to discard the preview and leave the layer unchanged.

## Functional Requirements

### All four filters

- All sharpening filter items **must** appear grouped under **Filters → Sharpen** in the menu bar.
- All four items **must** be disabled when the active layer is not a pixel layer (adjustment layer, mask, text, shape, or no layer selected).
- Each filter **must** affect only the currently active pixel layer; no other visible layer may be modified.
- If an active selection exists, each filter **must** sharpen only the pixels within the selection boundary, leaving pixels outside the selection byte-for-byte unchanged. The selection boundary is evaluated at the moment of application.
- If no active selection exists, each filter **must** be applied to every pixel on the active layer.
- Each filter **must** record exactly one undo history entry per application. Pressing Ctrl+Z / Cmd+Z once **must** restore the layer's pixel data to its exact pre-sharpen state.

### Sharpen (instant-apply)

- Selecting **Filters → Sharpen → Sharpen** **must** apply a standard 3×3 sharpening convolution immediately, without opening any dialog. The kernel has a center weight of 5, cardinal neighbor weights of −1 (up, down, left, right), and corner weights of 0.
- The result produces a moderate sharpening of edges and details.
- The undo history entry **must** be labeled "Sharpen".
- If an error occurs, a toast notification **must** surface the error; the layer **must** remain unmodified.

### Sharpen More (instant-apply)

- Selecting **Filters → Sharpen → Sharpen More** **must** apply a stronger 3×3 sharpening convolution immediately, without opening any dialog. The kernel has a center weight of 9 and all eight surrounding neighbor weights of −1.
- The result produces a noticeably stronger sharpening than Sharpen.
- The undo history entry **must** be labeled "Sharpen More".
- If an error occurs, a toast notification **must** surface the error; the layer **must** remain unmodified.

### Unsharp Mask (parametric)

- The **Unsharp Mask…** menu item **must** open a floating filter dialog.
- The dialog **must** expose three controls, each with both a slider and a synced numeric input:
  - **Amount**: integer, 1–500 (inclusive), unit "%" , default 100.
  - **Radius**: integer, 1–64 (inclusive), unit "px", default 2.
  - **Threshold**: integer, 0–255 (inclusive), unit "levels", default 0.
- Values entered outside the allowed range **must** be clamped to the nearest bound.
- The sharpening algorithm **must** be: blur the layer with a Gaussian of the specified Radius; compute the per-pixel difference between the original and the blurred result (the unsharp mask); multiply that difference by (Amount / 100); add the amplified difference back to the original pixel. Pixels where the absolute difference between original and blurred is below Threshold **must** be left unchanged.
- The canvas **must** display a live sharpened preview that is debounced — it updates after the user settles on a value, not on every incremental slider movement.
- The preview **must** reflect the final output as it will appear when applied. It **must not** modify the actual layer pixel data until **Apply** is clicked.
- A busy spinner **must** be shown in the dialog while a preview computation is in progress.
- If an active selection is present, the dialog **must** display a note informing the user that only the selected area will be sharpened.
- Clicking **Apply** **must** permanently write the sharpened pixels to the active layer, close the dialog, and record one undo history entry labeled "Unsharp Mask".
- Clicking **Cancel** or pressing Escape **must** close the dialog, restore the canvas to its pre-dialog appearance, and record no undo history entry.
- If an error occurs during application, an error message **must** be displayed inside the dialog; the dialog **must** remain open so the user can retry or cancel.

### Smart Sharpen (parametric)

- The **Smart Sharpen…** menu item **must** open a floating filter dialog.
- The dialog **must** expose four controls:
  - **Amount**: integer slider and numeric input, 1–500 (inclusive), unit "%", default 100.
  - **Radius**: integer slider and numeric input, 1–64 (inclusive), unit "px", default 2.
  - **Reduce Noise**: integer slider and numeric input, 0–100 (inclusive), unit "%", default 10.
  - **Remove**: dropdown selector with options "Gaussian Blur" and "Lens Blur".
- Values entered outside the allowed range for numeric controls **must** be clamped to the nearest bound.
- When **Remove** is set to **Gaussian Blur**, the sharpening algorithm **must** follow the same Unsharp Mask approach (Gaussian blur → difference → amplify by Amount → add back), but without a Threshold control.
- When **Remove** is set to **Lens Blur**, the sharpening algorithm **must** use Laplacian sharpening: `output = clamp(original + (Amount / 100) × laplacian(original))`, where the Laplacian kernel approximates out-of-focus (lens) blur more accurately than a Gaussian difference.
- After computing the sharpened result (regardless of **Remove** mode), a noise-reduction smoothing pass **must** be applied proportional to **Reduce Noise**. At 0%, no smoothing is applied; at 100%, a maximum gentle smoothing is applied to suppress haloing and sharpening artifacts.
- The canvas **must** display a live sharpened preview that is debounced — it updates after the user settles on a value, not on every incremental slider movement.
- The preview **must** reflect the final output as it will appear when applied. It **must not** modify actual layer pixel data until **Apply** is clicked.
- A busy spinner **must** be shown in the dialog while a preview computation is in progress.
- If an active selection is present, the dialog **must** display a note informing the user that only the selected area will be sharpened.
- Clicking **Apply** **must** permanently write the sharpened pixels to the active layer, close the dialog, and record one undo history entry labeled "Smart Sharpen".
- Clicking **Cancel** or pressing Escape **must** close the dialog, restore the canvas to its pre-dialog appearance, and record no undo history entry.
- If an error occurs during application, an error message **must** be displayed inside the dialog; the dialog **must** remain open so the user can retry or cancel.

## Acceptance Criteria

### Sharpen and Sharpen More

- With a pixel layer active, **Filters → Sharpen → Sharpen** and **Sharpen More** are both enabled.
- With a non-pixel layer active (or no layer), both items are grayed out and clicking them does nothing.
- Clicking **Sharpen** applies immediately; no dialog appears; the canvas visibly sharpens.
- Clicking **Sharpen More** applies immediately; no dialog appears; the result is visibly stronger than Sharpen on the same source image.
- Pressing Ctrl+Z / Cmd+Z once after either instant filter restores the layer's pixel data to its exact pre-sharpen state.
- With a selection active, only pixels inside the selection are sharpened by either instant filter.
- With no selection, both instant filters affect the entire layer.

### Unsharp Mask

- With a pixel layer active, **Filters → Sharpen → Unsharp Mask…** is enabled and opens the dialog.
- With a non-pixel layer active (or no layer), the menu item is grayed out.
- The dialog opens with Amount = 100, Radius = 2, Threshold = 0.
- Slider and numeric input stay in sync; typing a value outside the allowed range clamps it.
- After the user stops adjusting a control, the canvas updates to show a sharpened preview within the debounce window; the canvas does not update on every pixel of slider drag.
- The busy spinner appears while the preview is computing and disappears when it finishes.
- With an active selection, the dialog shows a selection-awareness note.
- Clicking **Apply** sharpens the layer's pixels, closes the dialog, and records one "Unsharp Mask" undo entry.
- Clicking **Cancel** leaves the layer byte-for-byte identical to its pre-dialog state.
- Pressing Escape while the dialog is open produces the same result as clicking **Cancel**.
- With a selection active, **Apply** sharpens only selected pixels; outside pixels are unchanged.
- With no selection, **Apply** sharpens the entire layer.
- Pressing Ctrl+Z / Cmd+Z once after **Apply** restores the layer's pre-sharpen state.
- A simulated error during application shows an error message inside the dialog without closing it.

### Smart Sharpen

- With a pixel layer active, **Filters → Sharpen → Smart Sharpen…** is enabled and opens the dialog.
- With a non-pixel layer active (or no layer), the menu item is grayed out.
- The dialog opens with Amount = 100, Radius = 2, Reduce Noise = 10, Remove = "Gaussian Blur".
- Slider and numeric input stay in sync; out-of-range values are clamped.
- Switching the **Remove** dropdown between "Gaussian Blur" and "Lens Blur" triggers a new debounced preview.
- The canvas does not update on every pixel of slider drag — it waits for the user to settle.
- The busy spinner appears while the preview is computing and disappears when it finishes.
- Clicking **Apply** with "Lens Blur" selected produces a visually different result than "Gaussian Blur" on the same input.
- With Reduce Noise = 0, the applied result contains no extra smoothing pass. With Reduce Noise = 100, noticeable smoothing of sharpening artifacts is visible.
- Clicking **Apply** sharpens the layer, closes the dialog, and records one "Smart Sharpen" undo entry.
- Clicking **Cancel** leaves the layer byte-for-byte identical to its pre-dialog state.
- Pressing Escape while the dialog is open produces the same result as clicking **Cancel**.
- With a selection active, **Apply** sharpens only selected pixels.
- Pressing Ctrl+Z / Cmd+Z once after **Apply** restores the layer's pre-sharpen state.
- A simulated error during application shows an error message inside the dialog without closing it.

## Edge Cases & Constraints

- Applying any sharpening filter to a blank (fully transparent) layer is valid and records an undo entry, but produces no visible change.
- Very high Amount values (e.g. 500%) or repeated applications of Sharpen More on an already-sharp or high-contrast layer may cause pixel values to clamp at 0 or 255, introducing hard banding. This is expected and intentional behavior.
- A Threshold of 0 in Unsharp Mask sharpens every pixel on the layer, including smooth gradients, which can introduce noise in flat areas. This is the expected behavior for Threshold = 0.
- A Threshold of 255 in Unsharp Mask means only pixels with the maximum possible tonal difference are sharpened; in practice this may sharpen nothing or very little. This is a valid input.
- A Reduce Noise value of 0 in Smart Sharpen disables the noise-reduction pass entirely; the output is determined solely by Amount, Radius, and Remove mode.
- The "Lens Blur" mode in Smart Sharpen is more suitable for photographs than for pixel art (which typically has hard, 1-pixel edges). Users may find minimal visible difference on pixel art sources — this is expected.
- All four dialogs and instant-apply filters are **not** re-editable after commit. Once applied, the original pixel data cannot be recovered except via undo.
- The Unsharp Mask and Smart Sharpen dialogs are modal — the menu bar and canvas are not interactive while they are open.
- For instant-apply filters, errors (e.g. memory failures) are surfaced as toast notifications only; no dialog is available to show an inline error.
- Sharpening a layer with a very large canvas at high radius values in Unsharp Mask or Smart Sharpen may take a non-trivial amount of time. The busy spinner communicates that computation is in progress.

## Out of Scope

- **Non-destructive sharpening** — a sharpen filter layer that stores parameters and re-applies on render is a separate, future feature.
- **High Pass sharpening** — the High Pass workflow (desaturate, overlay blend) is a separate technique not covered here.
- **Edge-detection-based masking** — automatic edge detection to restrict sharpening to edge regions only is not part of any of the four filters specified here.
- **Per-channel sharpening** — applying different sharpening intensities to individual color channels is not supported.
- **Applying any filter to multiple layers simultaneously** — all four filters always target the single active layer.
- **Save/recall of filter parameters** — the dialog controls reset to defaults each time the dialog is opened; no preset system is provided in this feature.
- **Real-time preview on every slider frame** — preview is intentionally debounced; sub-frame updates are out of scope.

## Related Features

- [filters-menu.md](filters-menu.md) — the Filters menu that hosts these items and defines shared enable/disable rules
- [gaussian-blur.md](gaussian-blur.md) — sibling parametric filter dialog; Unsharp Mask and Smart Sharpen follow the same dialog interaction model
- [unified-rasterization-pipeline.md](unified-rasterization-pipeline.md) — compositing pipeline used when a selection is active to isolate which pixels are modified
