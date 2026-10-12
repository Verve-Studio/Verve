import { describe, expect, it } from "vitest";
import { buildFillLayerPixels } from "@/core/services/useContentAwareFill";

describe("buildFillLayerPixels (Content-Aware Fill layer)", () => {
  it("keeps the inpainted pixels inside the selection and scales alpha by a soft mask", () => {
    const inpainted = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 200]);
    const out = buildFillLayerPixels(inpainted, new Uint8Array([0, 128, 255]), 3);
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 4, 5, 6, 128, 7, 8, 9, 200]);
  });
});
