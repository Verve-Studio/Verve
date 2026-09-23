# 129 · Full ToolContext built per coalesced sample; every sample replayed into all tools

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P2 |
| Severity | Medium |
| Category | Performance |
| Area | Input pipeline |
| Verified | Yes |

## Problem
`onHover` runs per coalesced sample and builds a full context each time; non-painting tools (e.g. Frame re-rasterising) process every sample.

## Where
- `src/core/services/useCanvas.ts:189`
- `src/core/services/useCanvasPointerInput.ts:145-194`

## Suggested fix
Hover once per batch with the last sample; replay coalesced samples only into painting tools.

## Done when
- One context build per frame for hover; non-painting tools see one move per frame.

## Resolution
useCanvas calls onHover once per pointer event with the last coalesced sample (one tool-context build per frame instead of one per sample). handleMoveBatch replays every coalesced sample only into tools that need the full path (modifiesPixels, or the new ITool.wantsCoalescedSamples flag, set on Lasso and Quick Selection); other tools get the frame's last sample.
