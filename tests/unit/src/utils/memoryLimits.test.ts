import { describe, expect, it } from "vitest";
import {
  GB,
  parseMemoryLimitGB,
  sanitizeBufferMemoryBytes,
  sanitizeHistoryMemoryBytes,
  validMemoryCapBytes,
} from "@/utils/memoryLimits";

describe("memoryLimits", () => {
  it("sanitizeHistoryMemoryBytes clamps to 0.5–64 GB and defaults non-finite values", () => {
    expect(sanitizeHistoryMemoryBytes(0)).toBe(0.5 * GB);
    expect(sanitizeHistoryMemoryBytes(-1)).toBe(0.5 * GB);
    expect(sanitizeHistoryMemoryBytes(NaN)).toBe(4 * GB);
    expect(sanitizeHistoryMemoryBytes(2 * GB)).toBe(2 * GB);
    expect(sanitizeHistoryMemoryBytes(1000 * GB)).toBe(64 * GB);
  });

  it("sanitizeBufferMemoryBytes has a 0.5 GB floor and defaults non-finite values", () => {
    expect(sanitizeBufferMemoryBytes(0)).toBe(0.5 * GB);
    expect(sanitizeBufferMemoryBytes(-1)).toBe(0.5 * GB);
    expect(sanitizeBufferMemoryBytes(NaN)).toBe(8 * GB);
    expect(sanitizeBufferMemoryBytes(Infinity)).toBe(8 * GB);
    expect(sanitizeBufferMemoryBytes(128 * GB)).toBe(128 * GB);
  });

  it("validMemoryCapBytes replaces corrupt caps and passes positive ones through", () => {
    for (const bad of [0, -1, NaN, Infinity, "8" as unknown, null, undefined])
      expect(validMemoryCapBytes(bad, 7)).toBe(7);
    expect(validMemoryCapBytes(128, 7)).toBe(128);
  });

  it("parseMemoryLimitGB ignores empty / unparsable input and clamps the rest", () => {
    expect(parseMemoryLimitGB("", 16)).toBeNull();
    expect(parseMemoryLimitGB("  ", 16)).toBeNull();
    expect(parseMemoryLimitGB("abc", 16)).toBeNull();
    expect(parseMemoryLimitGB("-3", 16)).toBe(0.5);
    expect(parseMemoryLimitGB("2.5", 16)).toBe(2.5);
    expect(parseMemoryLimitGB("40", 16)).toBe(16);
  });
});
