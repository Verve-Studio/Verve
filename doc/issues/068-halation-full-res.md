# 068 · Halation blurs at full resolution; Bloom keeps a full-res extract texture

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Low |
| Category | Performance |
| Area | Effects / Halation, Bloom |
| Verified | No — reported by reviewer |

## Problem
Halation runs up to 5 iterations × H+V of a 201-tap box at full resolution with no downsample. Bloom keeps a full-resolution `extractTex` even at half/quarter quality.

## Where
- `src/core/effects/Halation/HalationEffect.tsx:142-162`
- `src/core/effects/Bloom/BloomEffect.tsx`

## Suggested fix
Reuse Bloom's downsample path for Halation. Fold Bloom's threshold into the downsample pass so the extract texture is at blur resolution.

## Done when
- Halation cost scales with the downsampled resolution; Bloom at quarter quality allocates no full-res textures.


## Resolution
**Halation** now extracts into a transient full-res texture, box-downsamples 2× into the cached glow buffers (shared `bloom-downsample` shader), and runs all blur iterations at half resolution with the radius halved to keep the same spread; the composite upsamples via its sampler. **Bloom** no longer keeps its full-resolution extract texture in the cross-frame cache; it is transient for the encode (it is downsampled or copied immediately), so only the (quarter/half-res) blur buffers stay resident. Not done: folding the threshold into the downsample pass.
