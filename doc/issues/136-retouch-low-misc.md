# 136 · Retouching low-severity: blur margin, sharpen space, liquify loop, object-removal scan, scope use

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P4 |
| Severity | Low |
| Category | Correctness / Performance |
| Area | Tools / retouching |
| Verified | Yes |

## Problem
- Blur's snapshot margin is 1 px for up to 3 passes.
- Sharpen works in linear light on rgba32f but sRGB on rgba8.
- Liquify allocates per pixel in its inner loop.
- Object Removal rescans the whole mask on every stamp; stray `-=` in a message.
- Clone/Healing mix `activeScope()` and `ctx.scope`; Clone Stamp doesn't validate the source layer before starting.

## Where
- `src/core/tools/Blur/Blur.tsx`
- `src/core/tools/Sharpen/Sharpen.tsx`
- `src/core/tools/Liquify/Liquify.tsx`
- `src/core/tools/ObjectRemoval/ObjectRemoval.tsx`
- `src/core/store/inpaintMaskStore.ts`

## Suggested fix
Pad by passes; sharpen in sRGB; inline liquify taps; keep a has-any flag; use ctx.scope and validate sources.

## Done when
- Each item addressed.

## Resolution
Blur's snapshot margin is `passes` px. Sharpen works in sRGB-encoded space on rgba32f (encode snapshot, decode on write; HDR kept). Liquify's inner loop fetches each bilinear tap once and no longer allocates per pixel (dispTile/dispIndex). The inpaint mask store tracks a has-any flag instead of scanning the canvas-sized mask on every stamp, and the stray '-=' in the Object Removal message is gone. Clone Stamp and Healing handlers use ctx.scope, and Clone Stamp validates its source layer before starting a stroke (notifies and records no history).
