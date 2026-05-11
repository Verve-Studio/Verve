import type { EffectParamsMap } from "@/core/effects/effectTypes";

export type AdjustmentClipboardData = {
  kind: "curves-settings";
  version: 1;
  payload: EffectParamsMap["curves"];
} | null;

let clipboardData: AdjustmentClipboardData = null;

export function getAdjustmentClipboardData(): AdjustmentClipboardData {
  return clipboardData;
}

export function setAdjustmentClipboardData(
  data: AdjustmentClipboardData,
): void {
  clipboardData = data;
}

export function clearAdjustmentClipboardData(): void {
  clipboardData = null;
}
