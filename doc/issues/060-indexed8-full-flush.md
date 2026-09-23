# 060 · Every indexed8 flush expands and uploads the whole layer

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | GPU layers / Indexed8 |
| Verified | Partially — `LayerTextureStore.flush` full-upload for indexed8 confirmed |

## Problem
`Indexed8Strategy.uploadPatch` → `uploadFull` allocates a new `w*h*4` buffer on every flush (`indexedColorExpand.ts:12`) and uploads all of it. `LayerTextureStore.flush` reports a full-layer dirty rect, which disables the incremental render path. Paid on every pencil dab in indexed documents.

## Where
- `src/graphics/webgpu/layers/formats/Indexed8Strategy.ts:57-63`
- `src/graphics/webgpu/layers/LayerTextureStore.ts:159-179`
- `indexedColorExpand.ts:12`

## Suggested fix
Expand only the dirty rect into a reused scratch buffer and upload the patch. Keep full re-expansion for explicit palette changes via a separate `flushLayerPalette`.

## Done when
- A pencil dab on a 4K indexed8 layer uploads only its dirty patch.


## Resolution
`Indexed8Strategy` records the palette each layer was last fully expanded with. The new `canPatch()` hook in `PixelFormatStrategy`, used by `LayerTextureStore.flush`, allows a patch upload while the palette is unchanged (identity or content). In that case only the dirty rect is expanded (packed) and written with `writeTexture`, and the frame-dirty rect is the patch, so the incremental render path works. A changed palette (palette animation, swatch edits) still triggers a full re-expand. A flush with no palette now reuses the layer's last palette instead of expanding against `[]`, which rendered the layer blank.
