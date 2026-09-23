# 052 · Every `layers` change re-rasterizes all text/shape/path/frame layers

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | GPU layer sync |
| Verified | No — reported by reviewer |

## Problem
Only linked layers have a signature gate (`useGpuLayerSync.ts:299`). Any state change (opacity slider, rename, visibility toggle) triggers N canvas-sized CPU raster passes plus full `writeTexture` uploads for N parametric layers. The `contentVersion` bump also invalidates the `adjGroup` / composite caches and the plan fingerprint, so a full re-composite follows.

## Where
- `src/core/services/useGpuLayerSync.ts:244-357`

## Suggested fix
Apply the linked-layer approach to every parametric type: keep `lastRasterSig` per layer, keyed on its parametric fields and pixel format, and skip re-raster when unchanged.

## Done when
- Dragging a layer's opacity slider in a document with 20 text layers doesn't re-rasterize any of them.


## Resolution
Text, shape, path and frame layers in `useGpuLayerSync` now go through `needsRaster()`: a signature of the layer state minus compositing-only fields (opacity, visible, blendMode, name, locked, colorSpace) plus the pixel format, with frame content identified by object identity instead of stringifying its base64. The signature is kept in a `WeakMap` keyed by GpuLayer, so remounted layers always re-rasterise. Offsets are still reset every sync. Palette-indexed shapes still re-rasterise on swatch changes via the separate swatch effect.
