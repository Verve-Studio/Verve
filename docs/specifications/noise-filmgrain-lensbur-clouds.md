# Add Noise, Film Grain, Lens Blur, and Clouds Filters

## Overview

Verve provides four destructive parametric filters that add or generate pixel content on the active pixel layer. **Add Noise** introduces random per-pixel color or luminance variation using a selectable statistical distribution. **Film Grain** simulates the organic, spatially-correlated texture of photographic film — grain clusters rather than pure per-pixel noise. **Lens Blur** blurs the layer using an aperture-shaped kernel that mimics the bokeh disc a real camera lens produces when a subject is out of focus. **Clouds** generates a procedural cloud pattern and composites it onto the layer, optionally restricted to the active selection and blended with existing pixels. All four open a floating panel with live preview controls and an Apply/Cancel workflow, and all four are undoable via the standard undo history.

## User Interaction

### Add Noise

1. The user ensures the target pixel layer is active in the Layer Panel.
2. The user selects **Filters → Noise → Add Noise…** from the menu bar. If the active layer is not a pixel layer, the menu item is grayed out and cannot be selected.
3. The **Add Noise** floating panel opens to the right of the canvas. The canvas shows the layer's current unmodified pixels.
4. The panel presents three controls:
   - **Amount** — integer slider and numeric input, range 1–400 (%), default 25.
   - **Distribution** — two mutually exclusive toggle buttons: **Uniform** and **Gaussian**. Default is **Gaussian**.
   - **Monochromatic** — checkbox; when checked, the same noise value is applied to all three RGB channels (gray noise); when unchecked, each channel receives independent noise (color noise). Default is unchecked.
5. As the user adjusts any control, a noisy preview appears on the canvas after a short debounce delay. The panel remains open during preview.
6. If an active selection is present, a note in the panel indicates that noise will apply only within the selected area.
7. While the preview is being computed, a busy spinner is shown inside the panel.
8. The user clicks **Apply** to commit the filter, or presses **Cancel** (or Escape) to discard the preview and leave the layer unchanged.

### Film Grain

1. The user ensures the target pixel layer is active in the Layer Panel.
2. The user selects **Filters → Noise → Film Grain…** from the menu bar. If the active layer is not a pixel layer, the menu item is grayed out and cannot be selected.
3. The **Film Grain** floating panel opens to the right of the canvas. The canvas shows the layer's current unmodified pixels.
4. The panel presents three controls:
   - **Grain Size** — integer slider and numeric input, range 1–100, default 5. At 1, grain has a per-pixel character. At higher values, noise clusters into slightly blurred, larger grain shapes.
   - **Intensity** — integer slider and numeric input, range 1–200 (%), default 35.
   - **Roughness** — integer slider and numeric input, range 0–100, default 50. At 0, grain is most pronounced in shadowed areas; at 100, in highlighted areas; at 50, grain is uniform across all luminance levels.
5. As the user adjusts any control, a grain-textured preview appears on the canvas after a short debounce delay. The panel remains open during preview.
6. If an active selection is present, a note in the panel indicates that grain will apply only within the selected area.
7. While the preview is being computed, a busy spinner is shown inside the panel.
8. The user clicks **Apply** to commit the filter, or presses **Cancel** (or Escape) to discard the preview and leave the layer unchanged.

### Lens Blur

1. The user ensures the target pixel layer is active in the Layer Panel.
2. The user selects **Filters → Blur → Lens Blur…** from the menu bar. If the active layer is not a pixel layer, the menu item is grayed out and cannot be selected.
3. The **Lens Blur** floating panel opens to the right of the canvas. The canvas shows the layer's current unmodified pixels.
4. The panel presents four controls:
   - **Radius** — integer slider and numeric input, range 1–100 (px), default 10.
   - **Blade Count** — integer slider and numeric input, range 3–8, default 6. Determines the number of sides of the aperture polygon (3 = triangle, 4 = square, 6 = hexagon, etc.).
   - **Blade Curvature** — integer slider and numeric input, range 0–100, default 0. At 0, the aperture polygon has straight edges; at 100, it becomes a perfect circle.
   - **Rotation** — integer slider and numeric input, range 0–360 (°), default 0. Rotates the aperture polygon around its center.
5. The **Blade Count** control is visually disabled when **Blade Curvature** is 100 — at that point the aperture is a perfect circle, so the number of blades has no effect.
6. As the user adjusts any control, a blurred preview appears on the canvas after a short debounce delay. The panel remains open during preview. At large radii, preview computation may take noticeably longer.
7. If an active selection is present, a note in the panel indicates that blurring will apply only within the selected area.
8. While the preview is being computed, a busy spinner is shown inside the panel.
9. The user clicks **Apply** to commit the filter, or presses **Cancel** (or Escape) to discard the preview and leave the layer unchanged.

### Clouds

1. The user ensures the target pixel layer is active in the Layer Panel.
2. The user selects **Filters → Render → Clouds…** from the menu bar. If the active layer is not a pixel layer, the menu item is grayed out and cannot be selected.
3. The **Clouds** floating panel opens to the right of the canvas. The canvas shows the layer's current unmodified pixels.
4. The panel presents four controls:
   - **Scale** — integer slider and numeric input, range 1–200, default 50. Higher values produce larger, more spread-out cloud features.
   - **Opacity** — integer slider and numeric input, range 1–100 (%), default 100. At 100%, the cloud pattern fully replaces existing layer pixels in the affected area; at lower values, the cloud blends over the existing pixels.
   - **Color Mode** — two mutually exclusive toggle buttons: **Grayscale** (cloud rendered in black and white) and **Color** (cloud rendered using the active foreground and background colors from the color picker). Default is **Grayscale**.
   - **Seed** — integer slider and numeric input, range 0–9999, default 0. Different seed values produce visually distinct cloud variations at identical Scale and Opacity settings; the same seed always produces the same pattern.
5. As the user adjusts any control, a cloud preview appears on the canvas after a short debounce delay. The panel remains open during preview.
6. If an active selection is present, a note in the panel indicates that the cloud fill will be restricted to the selected area; pixels outside the selection are not modified.
7. While the preview is being computed, a busy spinner is shown inside the panel.
8. The user clicks **Apply** to commit the filter, or presses **Cancel** (or Escape) to discard the preview and leave the layer unchanged.

## Functional Requirements

### All four filters

- All four filter items **must** be disabled when the active layer is not a pixel layer (adjustment layer, mask, text, shape, group, or no layer selected).
- Each filter **must** affect only the currently active pixel layer; no other visible layer may be modified.
- If an active selection exists, each filter **must** affect only the pixels within the selection boundary, leaving pixels outside the selection byte-for-byte unchanged. The selection boundary is evaluated at the moment **Apply** is clicked.
- If no active selection exists, each filter **must** be applied to every pixel on the active layer.
- Each filter **must** record exactly one undo history entry per application. Pressing Ctrl+Z / Cmd+Z once **must** restore the layer's pixel data to its exact pre-filter state.
- Each filter **must** open as a **floating panel** — it does not block interaction with the rest of the application in the way a fully modal dialog does.
- The canvas **must** display a live preview while the panel is open. This preview **must** be debounced — it updates after the user has settled on a value, not on every incremental slider movement.
- The preview **must** reflect the output as it will appear when applied. It **must not** modify the actual layer pixel data until **Apply** is clicked.
- The applied result **must** be identical to the last preview shown. If the panel's controls have not changed since the last preview was rendered, clicking **Apply** must produce the same pixel output that was previewed.
- A busy spinner **must** be shown in the panel while any preview computation is in progress and hidden when the computation completes.
- Clicking **Apply** **must** permanently write the filter output to the active layer, close the panel, and record exactly one undo history entry with the label specified for that filter.
- Clicking **Cancel** or pressing Escape **must** close the panel, restore the canvas to its pre-panel appearance, and record no undo history entry.
- If an error occurs during application, an error message **must** be displayed inside the panel; the panel **must** remain open so the user can retry or cancel.
- Values entered outside a control's allowed range **must** be clamped to the nearest bound.

### Add Noise

- The **Add Noise…** item **must** appear under **Filters → Noise** in the menu bar.
- The panel **must** expose three controls:
  - **Amount**: integer, 1–400 (inclusive), unit "%", default 25. At Amount = 100, noise shifts each affected pixel channel by up to ±127 levels; at Amount = 400, shifts reach up to ±127 × 4 levels before clamping.
  - **Distribution**: toggle with two options — **Uniform** (flat random distribution across the full noise range) and **Gaussian** (bell-curve distribution; values cluster near zero, producing softer-feeling noise). Default is **Gaussian**.
  - **Monochromatic**: checkbox. When checked, a single noise value is sampled per pixel and applied identically to the R, G, and B channels, producing gray noise. When unchecked, independent noise values are sampled for each channel, producing color noise. Default is unchecked.
- The undo history entry **must** be labeled "Add Noise".
- If an error occurs during application, a toast notification **must** surface the error if the panel is no longer open, or an error row **must** appear inside the panel if it is still open; the layer **must** remain unmodified.

### Film Grain

- The **Film Grain…** item **must** appear under **Filters → Noise** in the menu bar.
- The panel **must** expose three controls:
  - **Grain Size**: integer, 1–100 (inclusive), no unit, default 5. At size 1, grain is per-pixel in character. At larger values, the generated noise is blurred by a small radius before being added, producing coarser grain clusters. The blur radius scales with Grain Size.
  - **Intensity**: integer, 1–200 (inclusive), unit "%", default 35. At 100%, the grain field (range ±127 levels) is added to the layer at full weight. At 50%, the grain is added at half weight.
  - **Roughness**: integer, 0–100 (inclusive), no unit, default 50. At 0, the grain amplitude is modulated by pixel luminance so that darker pixels receive stronger grain and brighter pixels receive weaker grain. At 100, the modulation is inverted — brighter pixels receive stronger grain. At 50, grain amplitude is uniform regardless of luminance.
- The undo history entry **must** be labeled "Film Grain".
- If an error occurs during application, an error row **must** be displayed inside the panel; the panel **must** remain open and the layer **must** remain unmodified.

### Lens Blur

- The **Lens Blur…** item **must** appear under **Filters → Blur** in the menu bar.
- The panel **must** expose four controls:
  - **Radius**: integer, 1–100 (inclusive), unit "px", default 10. Defines the radius of the aperture disc used as the blur kernel.
  - **Blade Count**: integer, 3–8 (inclusive), no unit, default 6. Defines the number of sides of the aperture polygon. Only has a visible effect when Blade Curvature is less than 100.
  - **Blade Curvature**: integer, 0–100 (inclusive), no unit, default 0. At 0, the aperture polygon has straight edges. At 100, the aperture is a perfect circle. Intermediate values produce rounded polygon shapes.
  - **Rotation**: integer, 0–360 (inclusive), unit "°", default 0. Rotates the aperture polygon. Has no visible effect when Blade Curvature is 100.
- The **Blade Count** control **must** be visually disabled (non-interactive) when Blade Curvature is 100.
- The blur result **must** use a convolution kernel shaped to match the aperture polygon defined by Blade Count, Blade Curvature, and Rotation at the given Radius.
- For performance at large radii, the filter **may** use a circular disk approximation in place of the full polygon kernel when the radius exceeds a quality threshold. The trade-off between accuracy and performance is transparent to the user; the spinner communicates that computation is in progress.
- The undo history entry **must** be labeled "Lens Blur".
- If an error occurs during application, an error row **must** be displayed inside the panel; the panel **must** remain open and the layer **must** remain unmodified.

### Clouds

- The **Clouds…** item **must** appear under **Filters → Render** in the menu bar.
- The panel **must** expose four controls:
  - **Scale**: integer, 1–200 (inclusive), no unit, default 50. Higher values produce larger, more spread-out cloud features. Lower values produce a finer, more granular cloud texture.
  - **Opacity**: integer, 1–100 (inclusive), unit "%", default 100. At 100%, the cloud pattern completely replaces the layer pixels in the affected area. At values below 100%, the cloud is blended over the existing pixels proportionally.
  - **Color Mode**: toggle with two options — **Grayscale** (cloud rendered in black and white) and **Color** (cloud rendered using the foreground and background colors that are active at the time **Apply** is clicked). Default is **Grayscale**.
  - **Seed**: integer, 0–9999 (inclusive), no unit, default 0. The same combination of Seed, Scale, and Color Mode **must** always produce the same cloud pattern. Changing the Seed value **must** produce a visually distinct pattern.
- The Clouds filter is **generative** — its output does not depend on the existing pixel data of the layer. Existing pixel content is only relevant when Opacity is less than 100%, in which case it is partially preserved beneath the cloud pattern.
- When Color Mode is **Color**, the cloud pattern **must** be rendered using the foreground and background colors that are active at the moment **Apply** is clicked, not the colors at the moment the panel was opened.
- The undo history entry **must** be labeled "Clouds".
- If an error occurs during application, an error row **must** be displayed inside the panel; the panel **must** remain open and the layer **must** remain unmodified.

## Acceptance Criteria

### Add Noise

- With a pixel layer active, **Filters → Noise → Add Noise…** is enabled and opens the floating panel.
- With a non-pixel layer active (or no layer), the menu item is grayed out and clicking it does nothing.
- The panel opens with Amount = 25, Distribution = Gaussian, Monochromatic unchecked.
- Slider and numeric input stay in sync; typing a value outside the allowed range clamps it to the nearest bound.
- After the user stops adjusting a control, the canvas updates to show a noisy preview within the debounce window; the canvas does not update on every pixel of slider drag.
- The busy spinner appears while the preview is computing and disappears once it finishes.
- With Monochromatic unchecked, the noise introduces visible color variation (R, G, B differ per pixel). With Monochromatic checked, the noise is visibly gray (R, G, B equal per pixel).
- With Uniform distribution, the noise values are spread evenly across the full range. With Gaussian distribution, most noise values are small and extreme values are rare, giving a softer appearance at the same Amount.
- With an active selection, the panel shows a selection-awareness note, and **Apply** affects only pixels inside the selection.
- Without an active selection, **Apply** affects the entire layer.
- Clicking **Apply** modifies the layer's pixel data, closes the panel, and records one "Add Noise" undo entry.
- Clicking **Cancel** leaves the layer's pixel data byte-for-byte identical to its pre-panel state.
- Pressing Escape while the panel is open produces the same result as clicking **Cancel**.
- Pressing Ctrl+Z / Cmd+Z once after **Apply** restores the layer's pre-filter state exactly.
- A simulated error during application shows an error row inside the panel without closing it.

### Film Grain

- With a pixel layer active, **Filters → Noise → Film Grain…** is enabled and opens the floating panel.
- With a non-pixel layer active (or no layer), the menu item is grayed out.
- The panel opens with Grain Size = 5, Intensity = 35, Roughness = 50.
- Slider and numeric input stay in sync; out-of-range values are clamped.
- At Grain Size = 1, the applied grain looks per-pixel. At Grain Size = 20 or higher, grain is visibly coarser with smooth cluster shapes rather than isolated pixels.
- With Roughness = 0 on an image that has dark and light areas, more grain is visible in the dark areas than the light areas. With Roughness = 100, the inverse is true.
- After the user stops adjusting a control, the canvas updates within the debounce window.
- With an active selection, **Apply** affects only selected pixels.
- Without an active selection, **Apply** affects the entire layer.
- Clicking **Apply** modifies the layer's pixel data, closes the panel, and records one "Film Grain" undo entry.
- Clicking **Cancel** or pressing Escape leaves the layer byte-for-byte unchanged.
- Pressing Ctrl+Z / Cmd+Z once after **Apply** restores the layer's pre-filter state.
- A simulated error during application shows an error row inside the panel without closing it.

### Lens Blur

- With a pixel layer active, **Filters → Blur → Lens Blur…** is enabled and opens the floating panel.
- With a non-pixel layer active (or no layer), the menu item is grayed out.
- The panel opens with Radius = 10, Blade Count = 6, Blade Curvature = 0, Rotation = 0.
- Slider and numeric input stay in sync; out-of-range values are clamped.
- At Blade Curvature = 100, the Blade Count control is visually disabled and the bokeh discs are circular.
- At Blade Curvature = 0 with Blade Count = 6, bokeh discs on a bright-against-dark image appear hexagonal.
- Changing Rotation visibly rotates the polygon aperture shape in the bokeh on non-circular settings.
- After the user stops adjusting a control, the canvas updates within the debounce window.
- The busy spinner is visible while the preview is computing; at Radius = 100 the spinner is visible for a noticeably longer period.
- With an active selection, **Apply** blurs only pixels inside the selection.
- Without an active selection, **Apply** blurs the entire layer.
- Clicking **Apply** modifies the layer's pixel data, closes the panel, and records one "Lens Blur" undo entry.
- Clicking **Cancel** or pressing Escape leaves the layer byte-for-byte unchanged.
- Pressing Ctrl+Z / Cmd+Z once after **Apply** restores the layer's pre-filter state.
- A simulated error during application shows an error row inside the panel without closing it.

### Clouds

- With a pixel layer active, **Filters → Render → Clouds…** is enabled and opens the floating panel.
- With a non-pixel layer active (or no layer), the menu item is grayed out.
- The panel opens with Scale = 50, Opacity = 100, Color Mode = Grayscale, Seed = 0.
- Slider and numeric input stay in sync; out-of-range values are clamped.
- Changing the Seed value produces a visually different cloud pattern at identical Scale settings.
- Applying the filter twice with the same Seed and Scale settings produces identical pixel output both times.
- With Opacity = 100, the applied result fully replaces the layer's existing pixel data in the affected area (no original content visible beneath).
- With Opacity = 50, the original layer pixels are partially visible through the cloud pattern.
- With Color Mode = Grayscale, the cloud result contains no color — it is visually black, white, and gray. With Color Mode = Color, the cloud is tinted using the active foreground and background colors.
- After the user stops adjusting a control, the canvas updates within the debounce window.
- With an active selection, the panel shows a selection-awareness note, and **Apply** restricts the cloud fill to the selected area; pixels outside are unchanged.
- Without an active selection, **Apply** fills the entire layer.
- Clicking **Apply** modifies the layer's pixel data, closes the panel, and records one "Clouds" undo entry.
- Clicking **Cancel** or pressing Escape leaves the layer byte-for-byte unchanged.
- Pressing Ctrl+Z / Cmd+Z once after **Apply** restores the layer's pre-filter state.
- A simulated error during application shows an error row inside the panel without closing it.

## Edge Cases & Constraints

- Applying any of the four filters to a fully transparent layer is valid and records an undo entry. Add Noise, Film Grain, and Lens Blur produce no visible change on a fully transparent layer. Clouds at Opacity = 100 replaces the transparent layer with cloud-pattern pixel data (including alpha).
- Add Noise at Amount = 400 produces very harsh noise and will saturate many pixels at 0 or 255. This is expected and intentional.
- Film Grain at Intensity = 200 can similarly saturate highlights and crush shadows. This is expected and intentional.
- Lens Blur at Radius = 100 requires a 201×201 kernel computation and may take several seconds on a large canvas. The busy spinner communicates that computation is in progress; the user should not click Apply a second time. This is expected behavior for maximum quality settings.
- A Clouds Seed value of 0 is a valid and meaningful input — it selects the first of 10 000 available patterns. It is not a "no-seed" or "random" state.
- In Clouds Color Mode, if the active foreground and background colors are identical, the cloud pattern is rendered in a single flat color. The noise field is still applied but all visible variation will be in luminance only. This is expected behavior.
- The random output of Add Noise and Film Grain is not deterministic across sessions (no user-exposed seed control). Users who want a repeatable result must keep the layer on the undo stack or save the exported file before applying.
- All four filter panels are non-modal in their floating-panel form; however, the canvas preview region reflects the live filter preview while the panel is open. Other layer operations should not be performed while a filter panel is open.
- All four dialogs and instant-apply filters are **not** re-editable after commit. Once applied, the original pixel data cannot be recovered except via undo.
- Lens Blur's polygon-to-circle approximation may produce slightly different bokeh shapes at high Blade Curvature values near (but not equal to) 100 compared to the exact polygon kernel. This is a performance trade-off and does not constitute a defect.

## Out of Scope

- **Non-destructive noise or grain layers** — a noise/grain adjustment layer that re-applies on render is a separate, future feature.
- **Depth-map-driven Lens Blur** — using a separate depth channel to vary blur radius spatially (as in Photoshop's full Lens Blur depth-source workflow) is not part of this feature.
- **Animated or time-shuffled noise** — generating animated noise across frames is not supported.
- **Per-channel noise amounts** — applying different strengths to individual color channels independently is not supported by Add Noise.
- **Difference Clouds** — a variant of the Clouds filter that blends using a Difference mode rather than normal opacity is not included.
- **Scale-linked cloud animation** (scrolling/shifting the noise field offset) is not supported.
- **Applying any filter to multiple layers simultaneously** — all four filters always target the single active layer.
- **Save/recall of filter parameters** — the panel controls reset to defaults each time the panel is opened; no preset system is provided in this feature.
- **Real-time preview on every slider frame** — preview is intentionally debounced; sub-frame updates are out of scope.

## Related Features

- [filters-menu.md](filters-menu.md) — the Filters menu that hosts these items and defines shared enable/disable rules
- [gaussian-blur.md](gaussian-blur.md) — sibling blur filter; Lens Blur follows the same floating-panel dialog interaction model
- [radial-blur.md](radial-blur.md) — sibling blur filter under **Filters → Blur**
- [sharpening-filters.md](sharpening-filters.md) — sibling parametric filter dialogs; same Apply/Cancel/debounced-preview pattern
- [unified-rasterization-pipeline.md](unified-rasterization-pipeline.md) — compositing pipeline used when a selection is active to isolate which pixels are modified
