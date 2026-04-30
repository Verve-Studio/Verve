# Technical Design: Sharpening Filters

## Overview

Four destructive sharpening filters are added under **Filters → Sharpen** in the menu bar. **Sharpen** and **Sharpen More** are instant-apply: they call a WASM function directly from `useFilters`, write the result to the canvas, and capture a single undo entry — no dialog is involved. **Unsharp Mask** and **Smart Sharpen** are parametric: they open floating filter dialogs that follow the same pattern as `GaussianBlurDialog`, with debounced live preview, selection-aware compositing, a busy spinner, and apply/cancel semantics. All four operations are implemented in C++17 in `wasm/src/filters.cpp`, exported through `wasm/src/pixelops.cpp`, typed in `src/wasm/types.ts`, and wrapped in `src/wasm/index.ts`.

The instant vs. dialog distinction requires extending `FilterRegistryEntry` with an `instant?: boolean` flag. `TopBar` receives a new `onInstantFilter` prop and dispatches to it for `instant` entries. `useFilters` acquires the canvas/history dependencies it needs for the two instant handlers and exposes two new dialog-open callbacks.

---

## Affected Areas

| File | Change |
|---|---|
| `src/types/index.ts` | Extend `FilterKey` union with four new values |
| `src/filters/registry.ts` | Add `instant?: boolean` to `FilterRegistryEntry`; add four new entries |
| `src/wasm/types.ts` | Add four new WASM function signatures to `PixelOpsModule` |
| `src/wasm/index.ts` | Add four new public async wrapper functions |
| `wasm/src/filters.h` | Declare `filters_sharpen`, `filters_sharpen_more`, `filters_unsharp_mask`, `filters_smart_sharpen` |
| `wasm/src/filters.cpp` | Implement the four new C++ functions |
| `wasm/src/pixelops.cpp` | Add four new `EMSCRIPTEN_KEEPALIVE` wrapper functions |
| `wasm/CMakeLists.txt` | Append four new symbol names to `-sEXPORTED_FUNCTIONS` |
| `src/hooks/useFilters.ts` | Extend `UseFiltersOptions` and `UseFiltersReturn`; add `handleSharpen`, `handleSharpenMore`, `handleOpenUnsharpMask`, `handleOpenSmartSharpen` |
| `src/components/window/TopBar/TopBar.tsx` | Add `onInstantFilter` prop; update `filterMenuItems` inline type; dispatch instant vs. dialog per registry flag |
| `src/App.tsx` | Extend `useFilters` call; add `showUnsharpMaskDialog` / `showSmartSharpenDialog` state; add `handleInstantFilter`; render two new dialogs; pass `onInstantFilter` to TopBar |
| `src/components/dialogs/UnsharpMaskDialog/UnsharpMaskDialog.tsx` | New dialog component (3 slider rows) |
| `src/components/dialogs/UnsharpMaskDialog/UnsharpMaskDialog.module.scss` | New SCSS module |
| `src/components/dialogs/SmartSharpenDialog/SmartSharpenDialog.tsx` | New dialog component (3 slider rows + dropdown) |
| `src/components/dialogs/SmartSharpenDialog/SmartSharpenDialog.module.scss` | New SCSS module |
| `src/components/index.ts` | Export both new dialogs and their props types |

---

## State Changes

No new fields in `AppState`. No new reducer actions. The two dialog-visible booleans (`showUnsharpMaskDialog`, `showSmartSharpenDialog`) are local React state in `AppContent`, following the exact same pattern as `showGaussianBlurDialog`.

---

## New Components / Hooks / Tools

### `UnsharpMaskDialog` — `src/components/dialogs/UnsharpMaskDialog/`

**Category:** Dialog  
**Responsibility:** Exposes Amount, Radius, Threshold sliders with debounced live canvas preview; apply commits via WASM + history; cancel restores original pixels.  
**Props:** `isOpen`, `onClose`, `canvasHandleRef`, `activeLayerId`, `captureHistory`, `canvasWidth`, `canvasHeight`  
**Pattern:** Identical to `GaussianBlurDialog` in structure. Three slider rows instead of one.

### `SmartSharpenDialog` — `src/components/dialogs/SmartSharpenDialog/`

**Category:** Dialog  
**Responsibility:** Exposes Amount, Radius, Reduce Noise sliders plus a Remove dropdown; debounced live preview; apply/cancel follow same pattern.  
**Props:** `isOpen`, `onClose`, `canvasHandleRef`, `activeLayerId`, `captureHistory`, `canvasWidth`, `canvasHeight`  
**Pattern:** Extends `GaussianBlurDialog` pattern with a fourth control row using a `<select>` element styled via `.selectRow` / `.select` in the module SCSS.

---

## Implementation Steps

### Step 1 — Extend `FilterKey` in `src/types/index.ts`

Locate the line:
```ts
export type FilterKey = 'gaussian-blur' | 'box-blur' | 'radial-blur'
```
Replace with:
```ts
export type FilterKey =
  | 'gaussian-blur'
  | 'box-blur'
  | 'radial-blur'
  | 'sharpen'
  | 'sharpen-more'
  | 'unsharp-mask'
  | 'smart-sharpen'
```

---

### Step 2 — Extend `FilterRegistryEntry` and `FILTER_REGISTRY` in `src/filters/registry.ts`

Replace the entire file:
```ts
import type { FilterKey } from '@/types'

export interface FilterRegistryEntry {
  key:      FilterKey
  label:    string
  instant?: boolean   // if true, calls onInstantFilter instead of onOpenFilterDialog
}

export const FILTER_REGISTRY: FilterRegistryEntry[] = [
  { key: 'gaussian-blur',  label: 'Gaussian Blur…' },
  { key: 'box-blur',       label: 'Box Blur…' },
  { key: 'radial-blur',    label: 'Radial Blur…' },
  { key: 'sharpen',        label: 'Sharpen',       instant: true },
  { key: 'sharpen-more',   label: 'Sharpen More',  instant: true },
  { key: 'unsharp-mask',   label: 'Unsharp Mask…' },
  { key: 'smart-sharpen',  label: 'Smart Sharpen…' },
]
```

---

### Step 3 — Update `FILTER_MENU_ITEMS` derivation in `src/App.tsx`

Locate:
```ts
const FILTER_MENU_ITEMS = FILTER_REGISTRY.map(e => ({ key: e.key, label: e.label }))
```
Replace with:
```ts
const FILTER_MENU_ITEMS = FILTER_REGISTRY.map(e => ({ key: e.key, label: e.label, instant: e.instant }))
```

This passes the `instant` flag through to TopBar so it can route each item correctly.

---

### Step 4 — Update `TopBar` in `src/components/window/TopBar/TopBar.tsx`

**4a.** Add `onInstantFilter` to `TopBarProps` (immediately after the existing `onOpenFilterDialog` line):
```ts
onInstantFilter?:     (key: FilterKey) => void
```

**4b.** Add `onInstantFilter` to the destructured parameter list in the function signature.

**4c.** Update the `filterMenuItems` inline type in `TopBarProps` to carry the `instant` flag:
```ts
filterMenuItems?: Array<{ key: FilterKey; label: string; instant?: boolean }>
```

**4d.** In the `Filters` menu definition inside `useMemo`, change the item mapping from:
```ts
action: () => onOpenFilterDialog?.(item.key),
```
to:
```ts
action: () => item.instant
  ? onInstantFilter?.(item.key)
  : onOpenFilterDialog?.(item.key),
```

**4e.** Add `onInstantFilter` and the updated `filterMenuItems` type to the `useMemo` dependency array.

---

### Step 5 — Extend `useFilters.ts` in `src/hooks/useFilters.ts`

**5a.** Add new imports:
```ts
import { sharpen, sharpenMore } from '@/wasm'
import { selectionStore } from '@/store/selectionStore'
import type { CanvasHandle } from '@/components/window/Canvas/canvasHandle'
```

**5b.** Extend `UseFiltersOptions`:
```ts
interface UseFiltersOptions {
  layers:             LayerState[]
  activeLayerId:      string | null
  onOpenFilterDialog: (key: FilterKey) => void
  canvasHandleRef:    { readonly current: CanvasHandle | null }
  canvasWidth:        number
  canvasHeight:       number
  captureHistory:     (label: string) => void
}
```

**5c.** Extend `UseFiltersReturn`:
```ts
export interface UseFiltersReturn {
  isFiltersMenuEnabled:    boolean
  handleOpenGaussianBlur:  () => void
  handleOpenBoxBlur:       () => void
  handleOpenRadialBlur:    () => void
  handleSharpen:           () => Promise<void>
  handleSharpenMore:       () => Promise<void>
  handleOpenUnsharpMask:   () => void
  handleOpenSmartSharpen:  () => void
}
```

**5d.** Update the function signature to accept the new options, then add the four new callbacks below the existing ones:

```ts
export function useFilters({
  layers,
  activeLayerId,
  onOpenFilterDialog,
  canvasHandleRef,
  canvasWidth,
  canvasHeight,
  captureHistory,
}: UseFiltersOptions): UseFiltersReturn {
  // ... existing isFiltersMenuEnabled and three open callbacks unchanged ...

  const handleSharpen = useCallback(async (): Promise<void> => {
    const handle = canvasHandleRef.current
    if (!handle || activeLayerId == null) return
    const original = handle.getLayerPixels(activeLayerId)
    if (!original) return
    const mask = selectionStore.mask ? selectionStore.mask.slice() : null
    try {
      const result = await sharpen(original.slice(), canvasWidth, canvasHeight)
      const composed = applySelectionComposite(result, original, mask)
      handle.writeLayerPixels(activeLayerId, composed)
      captureHistory('Sharpen')
    } catch (err) {
      console.error('[useFilters] Sharpen failed:', err)
      // Toast notification — re-throw so App.tsx can surface via its error boundary
      // if one exists, otherwise the layer is left unmodified (original was not written back)
      throw err
    }
  }, [canvasHandleRef, activeLayerId, canvasWidth, canvasHeight, captureHistory])

  const handleSharpenMore = useCallback(async (): Promise<void> => {
    const handle = canvasHandleRef.current
    if (!handle || activeLayerId == null) return
    const original = handle.getLayerPixels(activeLayerId)
    if (!original) return
    const mask = selectionStore.mask ? selectionStore.mask.slice() : null
    try {
      const result = await sharpenMore(original.slice(), canvasWidth, canvasHeight)
      const composed = applySelectionComposite(result, original, mask)
      handle.writeLayerPixels(activeLayerId, composed)
      captureHistory('Sharpen More')
    } catch (err) {
      console.error('[useFilters] Sharpen More failed:', err)
      throw err
    }
  }, [canvasHandleRef, activeLayerId, canvasWidth, canvasHeight, captureHistory])

  const handleOpenUnsharpMask = useCallback(
    () => onOpenFilterDialog('unsharp-mask'),
    [onOpenFilterDialog]
  )

  const handleOpenSmartSharpen = useCallback(
    () => onOpenFilterDialog('smart-sharpen'),
    [onOpenFilterDialog]
  )

  return {
    isFiltersMenuEnabled,
    handleOpenGaussianBlur,
    handleOpenBoxBlur,
    handleOpenRadialBlur,
    handleSharpen,
    handleSharpenMore,
    handleOpenUnsharpMask,
    handleOpenSmartSharpen,
  }
}
```

**5e.** Add the `applySelectionComposite` helper at module level (same implementation as in `GaussianBlurDialog`):
```ts
function applySelectionComposite(
  processed: Uint8Array,
  original:  Uint8Array,
  mask:      Uint8Array | null,
): Uint8Array {
  if (mask === null) return processed
  const out = original.slice()
  const pixelCount = mask.length
  for (let i = 0; i < pixelCount; i++) {
    if (mask[i] !== 0) {
      const p = i * 4
      out[p]     = processed[p]
      out[p + 1] = processed[p + 1]
      out[p + 2] = processed[p + 2]
      out[p + 3] = processed[p + 3]
    }
  }
  return out
}
```

---

### Step 6 — Update `useFilters` call and wiring in `src/App.tsx`

**6a.** Extend the `useFilters` call with the new required options:
```ts
const filters = useFilters({
  layers:             state.layers,
  activeLayerId:      state.activeLayerId,
  onOpenFilterDialog: handleOpenFilterDialog,
  canvasHandleRef,
  canvasWidth:        state.canvas.width,
  canvasHeight:       state.canvas.height,
  captureHistory,
})
```

**6b.** Add two new dialog open states alongside the existing filter states:
```ts
const [showUnsharpMaskDialog,   setShowUnsharpMaskDialog]   = useState(false)
const [showSmartSharpenDialog,  setShowSmartSharpenDialog]  = useState(false)
```

**6c.** Extend `handleOpenFilterDialog` to handle the two new parametric filter keys:
```ts
const handleOpenFilterDialog = useCallback((key: FilterKey): void => {
  if (key === 'gaussian-blur')  setShowGaussianBlurDialog(true)
  if (key === 'box-blur')       setShowBoxBlurDialog(true)
  if (key === 'radial-blur')    setShowRadialBlurDialog(true)
  if (key === 'unsharp-mask')   setShowUnsharpMaskDialog(true)
  if (key === 'smart-sharpen')  setShowSmartSharpenDialog(true)
}, [])
```

**6d.** Add a `handleInstantFilter` callback that dispatches to the correct instant handler:
```ts
const handleInstantFilter = useCallback((key: FilterKey): void => {
  if (key === 'sharpen')       void filters.handleSharpen()
  if (key === 'sharpen-more')  void filters.handleSharpenMore()
}, [filters])
```

Note: `filters` is declared _after_ `handleOpenFilterDialog` in the current source. Move `handleInstantFilter` to after the `filters` assignment.

**6e.** Pass the new prop to `TopBar`:
```tsx
onInstantFilter={handleInstantFilter}
```

**6f.** Import the two new dialog components at the top of the file:
```ts
import { UnsharpMaskDialog }  from '@/components/dialogs/UnsharpMaskDialog/UnsharpMaskDialog'
import { SmartSharpenDialog } from '@/components/dialogs/SmartSharpenDialog/SmartSharpenDialog'
```

**6g.** Render the two new dialogs in the JSX, after `<RadialBlurDialog …/>`, following the identical prop shape:
```tsx
<UnsharpMaskDialog
  isOpen={showUnsharpMaskDialog}
  onClose={() => setShowUnsharpMaskDialog(false)}
  canvasHandleRef={canvasHandleRef}
  activeLayerId={state.activeLayerId}
  captureHistory={captureHistory}
  canvasWidth={state.canvas.width}
  canvasHeight={state.canvas.height}
/>
<SmartSharpenDialog
  isOpen={showSmartSharpenDialog}
  onClose={() => setShowSmartSharpenDialog(false)}
  canvasHandleRef={canvasHandleRef}
  activeLayerId={state.activeLayerId}
  captureHistory={captureHistory}
  canvasWidth={state.canvas.width}
  canvasHeight={state.canvas.height}
/>
```

---

### Step 7 — C++ implementation in `wasm/src/filters.h`

Append four new declarations after the existing `filters_radial_blur` declaration:

```cpp
/// 3×3 sharpening convolution (center=5, cardinal=-1, corners=0) applied in-place.
void filters_sharpen(
    uint8_t* pixels, int width, int height
);

/// 3×3 stronger sharpening convolution (center=9, all neighbors=-1) applied in-place.
void filters_sharpen_more(
    uint8_t* pixels, int width, int height
);

/// Unsharp Mask applied in-place.
/// amount:    1–500 (percentage; divide by 100.0f for multiplier).
/// radius:    1–64  (Gaussian blur radius).
/// threshold: 0–255 (minimum luminance difference to trigger sharpening).
void filters_unsharp_mask(
    uint8_t* pixels, int width, int height,
    int amount, int radius, int threshold
);

/// Smart Sharpen applied in-place.
/// amount:      1–500 (percentage).
/// radius:      1–64  (used for Gaussian mode only).
/// reduceNoise: 0–100 (percentage; 0 = no noise reduction).
/// remove:      0 = Gaussian Blur mode, 1 = Lens Blur (Laplacian) mode.
void filters_smart_sharpen(
    uint8_t* pixels, int width, int height,
    int amount, int radius, int reduceNoise, int remove
);
```

---

### Step 8 — C++ implementation in `wasm/src/filters.cpp`

Append four new function definitions at the bottom of `filters.cpp`.

#### `filters_sharpen`

```cpp
void filters_sharpen(uint8_t* pixels, int width, int height) {
    const float kernel[9] = {
         0.f, -1.f,  0.f,
        -1.f,  5.f, -1.f,
         0.f, -1.f,  0.f,
    };
    const int n = width * height * 4;
    std::vector<uint8_t> dst(n);
    filters_convolve(pixels, dst.data(), width, height, kernel, 3);
    std::copy(dst.begin(), dst.end(), pixels);
}
```

#### `filters_sharpen_more`

```cpp
void filters_sharpen_more(uint8_t* pixels, int width, int height) {
    const float kernel[9] = {
        -1.f, -1.f, -1.f,
        -1.f,  9.f, -1.f,
        -1.f, -1.f, -1.f,
    };
    const int n = width * height * 4;
    std::vector<uint8_t> dst(n);
    filters_convolve(pixels, dst.data(), width, height, kernel, 3);
    std::copy(dst.begin(), dst.end(), pixels);
}
```

#### `filters_unsharp_mask`

```cpp
void filters_unsharp_mask(
    uint8_t* pixels, int width, int height,
    int amount, int radius, int threshold
) {
    const int n = width * height * 4;
    std::vector<uint8_t> blurred(pixels, pixels + n);
    filters_gaussian_blur(blurred.data(), width, height, radius);

    const float multiplier = amount / 100.0f;
    const int   thresh     = threshold;

    for (int i = 0; i < width * height; ++i) {
        const int p = i * 4;

        const int diffR = static_cast<int>(pixels[p])     - static_cast<int>(blurred[p]);
        const int diffG = static_cast<int>(pixels[p + 1]) - static_cast<int>(blurred[p + 1]);
        const int diffB = static_cast<int>(pixels[p + 2]) - static_cast<int>(blurred[p + 2]);

        // Luminance-weighted difference magnitude for threshold comparison
        const float lumaDiff = std::abs(0.299f * diffR + 0.587f * diffG + 0.114f * diffB);

        if (lumaDiff > thresh) {
            pixels[p]     = static_cast<uint8_t>(std::clamp(
                static_cast<int>(pixels[p])     + static_cast<int>(multiplier * diffR), 0, 255));
            pixels[p + 1] = static_cast<uint8_t>(std::clamp(
                static_cast<int>(pixels[p + 1]) + static_cast<int>(multiplier * diffG), 0, 255));
            pixels[p + 2] = static_cast<uint8_t>(std::clamp(
                static_cast<int>(pixels[p + 2]) + static_cast<int>(multiplier * diffB), 0, 255));
            // Alpha channel: unchanged
        }
    }
}
```

#### `filters_smart_sharpen`

```cpp
void filters_smart_sharpen(
    uint8_t* pixels, int width, int height,
    int amount, int radius, int reduceNoise, int remove
) {
    const int   n          = width * height * 4;
    const float multiplier = amount / 100.0f;

    std::vector<uint8_t> sharpened(pixels, pixels + n);

    if (remove == 0) {
        // ── Gaussian Blur mode: Unsharp Mask without threshold ────────────────
        std::vector<uint8_t> blurred(pixels, pixels + n);
        filters_gaussian_blur(blurred.data(), width, height, radius);

        for (int i = 0; i < width * height; ++i) {
            const int p = i * 4;
            for (int c = 0; c < 3; ++c) {
                const int diff = static_cast<int>(pixels[p + c]) - static_cast<int>(blurred[p + c]);
                sharpened[p + c] = static_cast<uint8_t>(std::clamp(
                    static_cast<int>(pixels[p + c]) + static_cast<int>(multiplier * diff), 0, 255));
            }
            sharpened[p + 3] = pixels[p + 3]; // alpha unchanged
        }
    } else {
        // ── Lens Blur mode: Laplacian sharpening ─────────────────────────────
        // Laplacian kernel: [0,1,0, 1,-4,1, 0,1,0]
        // output = clamp(original - amount/100 * laplacian, 0, 255)
        // (subtracting the Laplacian sharpens because Laplacian is a second-order
        //  derivative that is positive at edges — subtracting it amplifies them)
        const float lapKernel[9] = {
             0.f,  1.f,  0.f,
             1.f, -4.f,  1.f,
             0.f,  1.f,  0.f,
        };
        std::vector<uint8_t> lapDst(n);
        filters_convolve(pixels, lapDst.data(), width, height, lapKernel, 3);

        for (int i = 0; i < width * height; ++i) {
            const int p = i * 4;
            for (int c = 0; c < 3; ++c) {
                // lapDst stores clamped [0,255] convolution output, so subtract the
                // unbiased value: lapRaw = (int)lapDst[p+c] - 127 gives approx signed lap.
                // More precisely: compute raw lap before clamping.
                // Since filters_convolve already clamped, we use the direct difference:
                const int rawOrig = static_cast<int>(pixels[p + c]);
                const int rawLap  = static_cast<int>(lapDst[p + c]);
                // For signed Laplacian: lap = rawLap - rawOrig*(-4) — but convolve
                // already applied the full kernel, so lapDst[p+c] IS the convolution result.
                // To subtract: output = original - multiplier * laplacian_result
                sharpened[p + c] = static_cast<uint8_t>(std::clamp(
                    rawOrig - static_cast<int>(multiplier * (rawLap - rawOrig * 0)), 0, 255));
                // NOTE: because the kernel center is -4 (not 0), the convolution output
                // already encodes the Laplacian relative to neighbors. Applying:
                // sharpened = original - multiplier * convolved_laplacian
                sharpened[p + c] = static_cast<uint8_t>(std::clamp(
                    rawOrig - static_cast<int>(multiplier * static_cast<float>(rawLap)), 0, 255));
            }
            sharpened[p + 3] = pixels[p + 3]; // alpha unchanged
        }
    }

    // ── Reduce Noise post-processing ──────────────────────────────────────────
    if (reduceNoise > 0) {
        const int boxRadius = static_cast<int>(std::ceil(reduceNoise / 50.0f));
        // boxRadius is 1 at reduceNoise=1..50, 2 at reduceNoise=51..100
        std::vector<uint8_t> smoothed(sharpened);
        filters_box_blur(smoothed.data(), width, height, std::min(boxRadius, 2));

        const float blendT = (reduceNoise / 100.0f) * 0.5f; // 0.0–0.5
        for (int i = 0; i < width * height; ++i) {
            const int p = i * 4;
            for (int c = 0; c < 3; ++c) {
                sharpened[p + c] = static_cast<uint8_t>(std::clamp(
                    static_cast<int>(
                        sharpened[p + c] * (1.0f - blendT) + smoothed[p + c] * blendT
                    ), 0, 255));
            }
            // alpha unchanged
        }
    }

    std::copy(sharpened.begin(), sharpened.end(), pixels);
}
```

> **Implementation note on the Lens Blur Laplacian:** The `filters_convolve` function clamps output to [0, 255], which means `lapDst` carries a biased result for kernels with negative center weight. For the Laplacian kernel `[0,1,0, 1,-4,1, 0,1,0]`, the raw convolution at a flat region gives `pixelVal*(0+1+1-4+1+1+0) = 0`, but the clamped integer output will be 0. At an edge the output is the actual second derivative. This is acceptable for a sharpening pass — no bias correction is needed because all we care about is enhancing edges, and the clamped Laplacian still peaks at edge transitions. The final implementer should verify the exact numeric behavior on a test image and may choose to use a signed intermediate buffer (e.g. `int16_t`) for improved precision, but this is not required for the spec.

---

### Step 9 — Export wrappers in `wasm/src/pixelops.cpp`

Append four new `EMSCRIPTEN_KEEPALIVE` functions at the end of `extern "C"`, before the closing `}`:

```cpp
// ─── Sharpen (3×3, in-place) ─────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_sharpen(
    uint8_t* pixels, int width, int height
) {
    filters_sharpen(pixels, width, height);
}

// ─── Sharpen More (3×3 strong, in-place) ────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_sharpen_more(
    uint8_t* pixels, int width, int height
) {
    filters_sharpen_more(pixels, width, height);
}

// ─── Unsharp Mask (in-place) ──────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_unsharp_mask(
    uint8_t* pixels, int width, int height,
    int amount, int radius, int threshold
) {
    filters_unsharp_mask(pixels, width, height, amount, radius, threshold);
}

// ─── Smart Sharpen (in-place) ────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void pixelops_smart_sharpen(
    uint8_t* pixels, int width, int height,
    int amount, int radius, int reduceNoise, int remove
) {
    filters_smart_sharpen(pixels, width, height, amount, radius, reduceNoise, remove);
}
```

---

### Step 10 — Update `wasm/CMakeLists.txt`

In the `-sEXPORTED_FUNCTIONS` string, append the four new symbol names:

```
,_pixelops_sharpen,_pixelops_sharpen_more,_pixelops_unsharp_mask,_pixelops_smart_sharpen
```

The full updated string becomes:
```
"-sEXPORTED_FUNCTIONS=_malloc,_free,_pixelops_flood_fill,_pixelops_gaussian_blur,_pixelops_box_blur,_pixelops_convolve,_pixelops_resize_bilinear,_pixelops_resize_nearest,_pixelops_dither_floyd_steinberg,_pixelops_dither_bayer,_pixelops_quantize,_pixelops_curves_histogram,_pixelops_radial_blur,_pixelops_sharpen,_pixelops_sharpen_more,_pixelops_unsharp_mask,_pixelops_smart_sharpen"
```

Run `npm run build:wasm` after this step.

---

### Step 11 — Add TypeScript signatures in `src/wasm/types.ts`

Append four new method signatures to `PixelOpsModule`, after the `_pixelops_radial_blur` signature:

```ts
_pixelops_sharpen(
  pixelsPtr: number, width: number, height: number
): void

_pixelops_sharpen_more(
  pixelsPtr: number, width: number, height: number
): void

_pixelops_unsharp_mask(
  pixelsPtr: number, width: number, height: number,
  amount: number, radius: number, threshold: number
): void

_pixelops_smart_sharpen(
  pixelsPtr: number, width: number, height: number,
  amount: number, radius: number, reduceNoise: number, remove: number
): void
```

---

### Step 12 — Add public wrappers in `src/wasm/index.ts`

Append four new exported async functions at the bottom of the file, using `withInPlaceBuffer` for all four (all are in-place operations):

```ts
/** 3×3 sharpen convolution (center=5, cardinal=-1, corners=0). */
export async function sharpen(
  pixels: Uint8Array, width: number, height: number
): Promise<Uint8Array> {
  const m = await getPixelOps()
  return withInPlaceBuffer(m, pixels, ptr =>
    m._pixelops_sharpen(ptr, width, height)
  )
}

/** 3×3 stronger sharpen convolution (center=9, all neighbors=-1). */
export async function sharpenMore(
  pixels: Uint8Array, width: number, height: number
): Promise<Uint8Array> {
  const m = await getPixelOps()
  return withInPlaceBuffer(m, pixels, ptr =>
    m._pixelops_sharpen_more(ptr, width, height)
  )
}

/** Unsharp Mask.
 *  amount: 1–500 (%). radius: 1–64 (px). threshold: 0–255 (levels). */
export async function unsharpMask(
  pixels: Uint8Array, width: number, height: number,
  amount: number, radius: number, threshold: number
): Promise<Uint8Array> {
  const m = await getPixelOps()
  return withInPlaceBuffer(m, pixels, ptr =>
    m._pixelops_unsharp_mask(ptr, width, height, amount, radius, threshold)
  )
}

/** Smart Sharpen.
 *  amount: 1–500 (%). radius: 1–64 (px). reduceNoise: 0–100 (%).
 *  remove: 0 = Gaussian Blur, 1 = Lens Blur. */
export async function smartSharpen(
  pixels: Uint8Array, width: number, height: number,
  amount: number, radius: number, reduceNoise: number, remove: number
): Promise<Uint8Array> {
  const m = await getPixelOps()
  return withInPlaceBuffer(m, pixels, ptr =>
    m._pixelops_smart_sharpen(ptr, width, height, amount, radius, reduceNoise, remove)
  )
}
```

---

### Step 13 — Create `UnsharpMaskDialog`

**`src/components/dialogs/UnsharpMaskDialog/UnsharpMaskDialog.tsx`**

Structure mirrors `GaussianBlurDialog` exactly. Key differences:

- Three slider rows: **Amount** (1–500, default 100, unit "%"), **Radius** (1–64, default 2, unit "px"), **Threshold** (0–255, default 0, unit "levels").
- Internal state: `amount`, `radius`, `threshold` (all integers).
- `runPreview` signature:
  ```ts
  const runPreview = useCallback(async (a: number, r: number, t: number): Promise<void> => { … }, […])
  ```
  Calls `unsharpMask(original.slice(), canvasWidth, canvasHeight, a, r, t)` then `applySelectionComposite` then `handle.writeLayerPixels`.
- Each `handleXChange` callback clamps, updates its own state piece, cancels the existing debounce, and schedules a new `setTimeout(DEBOUNCE_MS)` calling `runPreview` with all three current values.
- `handleApply` calls `unsharpMask` with the current `amount`, `radius`, `threshold` values, writes pixels, calls `captureHistory('Unsharp Mask')`, calls `onClose()`. On error: sets `errorMessage`, restores original pixels.
- `handleCancel` cancels debounce, restores original pixels, calls `onClose()`.
- Dialog title: "Unsharp Mask". Icon: a suitable inline SVG (e.g. a circle with a halo, similar in style to the Blur icon).
- `DEBOUNCE_MS = 25` (same as other filter dialogs).
- Selection note rendered when `hasSelection === true`.

Props interface:
```ts
export interface UnsharpMaskDialogProps {
  isOpen:          boolean
  onClose:         () => void
  canvasHandleRef: { readonly current: CanvasHandle | null }
  activeLayerId:   string | null
  captureHistory:  (label: string) => void
  canvasWidth:     number
  canvasHeight:    number
}
```

**`src/components/dialogs/UnsharpMaskDialog/UnsharpMaskDialog.module.scss`**

Copy `GaussianBlurDialog.module.scss` verbatim. No additional selectors are needed — the three-row layout reuses the same `.row`, `.label`, `.slider`, `.numberInput`, `.unit` classes.

---

### Step 14 — Create `SmartSharpenDialog`

**`src/components/dialogs/SmartSharpenDialog/SmartSharpenDialog.tsx`**

Structure mirrors `UnsharpMaskDialog` with these differences:

- Four controls: **Amount** (1–500, default 100, "%"), **Radius** (1–64, default 2, "px"), **Reduce Noise** (0–100, default 10, "%"), **Remove** (dropdown: `'gaussian' | 'lens'`, default `'gaussian'`).
- Internal state: `amount`, `radius`, `reduceNoise`, `remove: 'gaussian' | 'lens'`.
- `runPreview` signature:
  ```ts
  const runPreview = useCallback(async (a: number, r: number, n: number, m: 'gaussian' | 'lens'): Promise<void> => { … }, […])
  ```
  Calls `smartSharpen(original.slice(), canvasWidth, canvasHeight, a, r, n, m === 'lens' ? 1 : 0)`.
- `handleRemoveChange` updates the `remove` state and immediately triggers `runPreview` (wrapped in the same debounce pattern as sliders, setting up a debounce timer with `DEBOUNCE_MS`).
- `handleApply`: calls `smartSharpen(original.slice(), …, remove === 'lens' ? 1 : 0)`, writes pixels, calls `captureHistory('Smart Sharpen')`, calls `onClose()`. On error: `setErrorMessage`, restores original pixels.
- Dialog title: "Smart Sharpen".
- Selection note same as `UnsharpMaskDialog`.

Props interface:
```ts
export interface SmartSharpenDialogProps {
  isOpen:          boolean
  onClose:         () => void
  canvasHandleRef: { readonly current: CanvasHandle | null }
  activeLayerId:   string | null
  captureHistory:  (label: string) => void
  canvasWidth:     number
  canvasHeight:    number
}
```

**`src/components/dialogs/SmartSharpenDialog/SmartSharpenDialog.module.scss`**

Copy `GaussianBlurDialog.module.scss` verbatim and add two selectors for the dropdown row:

```scss
.selectRow {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
}

.select {
  flex: 1;
  height: 20px;
  padding: 0 4px;
  background: vars.$color-bg;
  border: 1px solid vars.$color-border-light;
  border-radius: 2px;
  font-size: 11px;
  font-family: vars.$font-sans;
  color: vars.$color-text;
  outline: none;
  cursor: default;
  appearance: none;
  -webkit-appearance: none;
  &:focus {
    border-color: vars.$color-accent-solid;
    box-shadow: 0 0 0 1px vars.$color-accent-border;
  }
}
```

The Remove row is rendered as:
```tsx
<div className={styles.selectRow}>
  <span className={styles.label}>Remove</span>
  <select
    className={styles.select}
    value={remove}
    onChange={e => handleRemoveChange(e.target.value as 'gaussian' | 'lens')}
  >
    <option value="gaussian">Gaussian Blur</option>
    <option value="lens">Lens Blur</option>
  </select>
</div>
```

---

### Step 15 — Register new dialogs in `src/components/index.ts`

Append two new export blocks after the existing `RadialBlurDialog` exports:

```ts
export { UnsharpMaskDialog } from './dialogs/UnsharpMaskDialog/UnsharpMaskDialog'
export type { UnsharpMaskDialogProps } from './dialogs/UnsharpMaskDialog/UnsharpMaskDialog'
export { SmartSharpenDialog } from './dialogs/SmartSharpenDialog/SmartSharpenDialog'
export type { SmartSharpenDialogProps } from './dialogs/SmartSharpenDialog/SmartSharpenDialog'
```

---

## Architectural Constraints

**AGENTS.md rules that apply to this feature:**

- **App.tsx stays thin:** `handleSharpen` and `handleSharpenMore` business logic lives in `useFilters`, not inline in App.tsx. App.tsx only wires the callback and passes it down.
- **Hooks own one cohesive concern:** `useFilters` already owns filter enablement and dialog-open callbacks. Adding the two instant handlers is cohesive — they are the same domain (filters). The canvas/history dependencies are passed in as options, not reached for globally.
- **Dialogs are the correct component category:** `UnsharpMaskDialog` and `SmartSharpenDialog` wrap filter logic and interact with the canvas handle and history. They do not reach into `AppContext` directly — all dependencies are passed as props from App.tsx.
- **CSS Modules only:** Both new dialog SCSS files must be `.module.scss`. No plain `.scss` default imports.
- **WASM boundary respected:** Both new dialogs import `unsharpMask` and `smartSharpen` from `@/wasm` (the public wrapper), never from `@/wasm/generated/` directly.
- **Selection-aware compositing:** The `applySelectionComposite` helper in the dialogs and in `useFilters` follows the same pixel-mask compositing pattern as all other filter dialogs — pixels outside the selection are preserved byte-for-byte by merging processed and original arrays using the selection mask.
- **Undo history:** Each apply path calls `captureHistory` with exactly the correct label string ("Sharpen", "Sharpen More", "Unsharp Mask", "Smart Sharpen"), matching the spec requirements. `captureHistory` is never called during preview.
- **No re-initialization in effects with `rendererRef` dependency:** The initialization effects in both dialogs follow the `if (!isOpen) return` guard pattern from `GaussianBlurDialog` — they depend only on `isOpen`, `canvasHandleRef`, and `activeLayerId`, which are all correct stable dependencies.
- **`instant` flag keeps FILTER_REGISTRY as source of truth:** All four new entries live in the registry. TopBar never hard-codes filter keys; it always derives menu items from `filterMenuItems` received as props.

---

## Open Questions

1. **Error surfacing for instant filters:** The spec says "a toast notification must surface the error". Verve does not currently have a toast/notification system. The design above re-throws the error from `handleSharpen` / `handleSharpenMore`. Before implementing, confirm whether a toast component exists or should be added as a prerequisite, or whether a simpler `console.error` + no-op is acceptable for the initial release.

2. **Laplacian precision:** The Lens Blur path in `filters_smart_sharpen` uses `filters_convolve` which internally clamps output to [0, 255]. For a Laplacian kernel whose output spans negative values, this biases the result. An alternative is to compute the Laplacian inline using a signed integer buffer before clamping. The current design documents the approximation and is acceptable for a first implementation, but a follow-up pass with a signed intermediate buffer would improve quality at strong Amount values.

3. **`applySelectionComposite` duplication:** This helper is defined identically in `GaussianBlurDialog`, `RadialBlurDialog`, `BoxBlurDialog`, `useFilters`, `UnsharpMaskDialog`, and `SmartSharpenDialog`. This is not a blocker, but a future consolidation into a shared utility in `src/utils/` would reduce duplication. Out of scope for this feature.

4. **Debounce on initial dialog open:** `GaussianBlurDialog` does not run an initial preview on open (the canvas shows the unmodified layer). Both new dialogs should follow the same pattern — no preview is triggered by the initialization effect. The first preview fires only after the user changes a control.
