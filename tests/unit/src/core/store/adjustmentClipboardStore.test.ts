import { afterEach, describe, expect, it } from "vitest";
import type { EffectParamsMap } from "@/core/effects/effectTypes";
import {
  clearAdjustmentClipboardData,
  getAdjustmentClipboardData,
  setAdjustmentClipboardData,
} from "@/core/store/adjustmentClipboardStore";

afterEach(() => {
  clearAdjustmentClipboardData();
});

describe("adjustmentClipboardStore", () => {
  it("is empty until something is copied", () => {
    expect(getAdjustmentClipboardData()).toBeNull();
  });

  it("set / get / clear the copied curves settings", () => {
    const payload = { channel: "rgb" } as unknown as EffectParamsMap["curves"];
    const data = { kind: "curves-settings" as const, version: 1 as const, payload };
    setAdjustmentClipboardData(data);
    expect(getAdjustmentClipboardData()).toBe(data);
    clearAdjustmentClipboardData();
    expect(getAdjustmentClipboardData()).toBeNull();
    setAdjustmentClipboardData(data);
    setAdjustmentClipboardData(null);
    expect(getAdjustmentClipboardData()).toBeNull();
  });
});
