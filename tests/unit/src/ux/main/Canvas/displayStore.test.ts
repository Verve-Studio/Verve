import { afterEach, describe, expect, it, vi } from "vitest";
import type { LutTransform } from "@/core/lut/LUT";
import { OPERATOR_SHADER_ID, displayStore } from "@/ux/main/Canvas/displayStore";

const fakeLut = {} as LutTransform;

afterEach(() => {
  displayStore.setProofProfile(null);
  displayStore.setEV(0);
  displayStore.setOperator("clamp");
  displayStore.setViewTransformLut(null);
  displayStore.setDisplayProfile(null, null);
  displayStore.setTransparentBackdrop(false);
  displayStore.setSimulatePaperColor(false);
  displayStore.setGamutWarningEnabled(false);
});

describe("displayStore", () => {
  it("maps tone-mapping operators to distinct shader ids (clamp = 0)", () => {
    expect(OPERATOR_SHADER_ID.clamp).toBe(0);
    expect(OPERATOR_SHADER_ID.reinhard).not.toBe(OPERATOR_SHADER_ID.clamp);
  });

  it("setters update fields and notify", () => {
    const fn = vi.fn();
    displayStore.subscribe(fn);
    displayStore.setEV(1.5);
    displayStore.setOperator("reinhard");
    displayStore.setViewTransformLut("lut-1");
    displayStore.setDisplayProfile(new Uint8Array([1]), fakeLut);
    displayStore.unsubscribe(fn);
    expect(displayStore.exposureEV).toBe(1.5);
    expect(displayStore.toneMappingOperator).toBe("reinhard");
    expect(displayStore.viewTransformLutId).toBe("lut-1");
    expect(displayStore.displayProfileLut).toBe(fakeLut);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("reset puts exposure back to 0 EV", () => {
    displayStore.setEV(-3);
    displayStore.reset();
    expect(displayStore.exposureEV).toBe(0);
  });

  it("proofing can only be enabled with a proof profile", () => {
    const fn = vi.fn();
    displayStore.subscribe(fn);
    displayStore.setProofEnabled(true);
    expect(displayStore.proofEnabled).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    displayStore.setProofProfile(new Uint8Array([9]));
    displayStore.setProofEnabled(true);
    expect(displayStore.proofEnabled).toBe(true);
    displayStore.unsubscribe(fn);
  });

  it("removing the proof profile turns proofing off and drops the proof LUT", () => {
    displayStore.setProofProfile(new Uint8Array([9]));
    displayStore.setProofEnabled(true);
    displayStore.setProofLut(fakeLut);
    displayStore.setProofProfile(null);
    expect(displayStore.proofEnabled).toBe(false);
    expect(displayStore.proofLut).toBeNull();
  });

  it("the gamut warning colour is copied, not aliased", () => {
    const c = { r: 255, g: 0, b: 255 };
    displayStore.setGamutWarningColor(c);
    c.r = 0;
    expect(displayStore.gamutWarningColor).toEqual({ r: 255, g: 0, b: 255 });
  });

  it("setTransparentBackdrop notifies only on change", () => {
    const fn = vi.fn();
    displayStore.subscribe(fn);
    displayStore.setTransparentBackdrop(false);
    displayStore.setTransparentBackdrop(true);
    displayStore.setTransparentBackdrop(true);
    displayStore.unsubscribe(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
