import type { AdjustmentParamsMap } from "@/types";

export type AdjustmentClipboardData = {
  kind: "curves-settings";
  version: 1;
  payload: AdjustmentParamsMap["curves"];
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
