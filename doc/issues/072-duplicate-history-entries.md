# 072 · Duplicate or empty history entries

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P3 |
| Severity | Medium |
| Category | Correctness |
| Area | Tools / History |
| Verified | No — reported by reviewer |

## Problem
- Pencil on indexed8 calls `commitStroke("Pencil")` (`Pencil.tsx:1120`), then `handleUp` auto-captures another entry (Pencil has no `skipAutoHistory`).
- The Gradient vector path calls `ctx.commitStroke("Set gradient fill")` (`Gradient.tsx:498`) and is also auto-captured.
- Alt-click to set a source in CloneStamp (`CloneStamp.tsx:116-133`) or HealingBrush (`:309-338`) pushes empty "Clone-stamp" / "Healing-brush" undo steps.

## Where
- `src/core/tools/Pencil/Pencil.tsx:1120`
- `src/core/tools/Gradient/Gradient.tsx:498`
- `src/core/tools/CloneStamp/CloneStamp.tsx:116-133`
- `src/core/tools/HealingBrush/HealingBrush.tsx:309-338`

## Suggested fix
Remove the manual commits, or set `skipAutoHistory` and commit explicitly. Give the handler a way to veto the auto-capture for non-painting clicks (e.g. `onPointerUp` returns `{ skipHistory: true }`).

## Done when
- One stroke = one undo step; setting a clone source adds none.


## Resolution
ToolHandler.onPointerUp may return { skipHistory: true } to veto the auto-capture. Pencil indexed8 no longer commits twice; Gradient's vector path commits once and skips the auto-capture; CloneStamp/HealingBrush alt-click source picks and no-source clicks add no undo step. Also fixed the alt-click layer hit test for indexed8 layers.
