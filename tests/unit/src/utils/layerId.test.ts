import { describe, expect, it } from "vitest";
import { newLayerId } from "@/utils/layerId";

describe("newLayerId", () => {
  it("keeps the prefix", () => {
    expect(newLayerId("layer")).toMatch(/^layer-[0-9a-z]+-[0-9a-z]+$/);
    expect(newLayerId("text")).toMatch(/^text-/);
  });

  it("is unique across a tight loop within the same millisecond", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50000; i++) ids.add(newLayerId("layer"));
    expect(ids.size).toBe(50000);
  });
});
