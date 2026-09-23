# 130 · Healing: full-layer uploads, no stroke throttle; Clone/Heal full copies per stroke

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | Tools / Healing, Clone Stamp |
| Verified | Yes |

## Problem
Healing flushes without a dirty rect (full upload) and never calls strokeStart/End; Clone Stamp and Healing copy the whole source layer at every stroke start even when source ≠ destination.

## Where
- `src/core/tools/HealingBrush/HealingBrush.tsx:202, 346, 366, 402`
- `src/core/tools/CloneStamp/CloneStamp.tsx:182`

## Suggested fix
Mark dirty rects and bracket strokes; read the source live when it isn't the destination.

## Done when
- Healing uploads patches; strokes on other layers don't copy the source.

## Resolution
Healing: stamps flush through flushStamps (patch upload only) and strokes are bracketed with strokeStart/strokeEnd. Healing and Clone Stamp read a source on a different layer live instead of copying it per stroke (layer.data is re-read per stamp/segment because WASM heap growth replaces it); a same-layer source still uses a stable snapshot.
