import { describe, expect, it } from "vitest";
import { DEVICE_KEYS, DEVICE_LABELS, DEVICE_PALETTES } from "@/utils/devicePalettes";

describe("device palettes", () => {
  it("keys, labels and palettes cover the same set", () => {
    expect([...DEVICE_KEYS].sort()).toEqual(Object.keys(DEVICE_PALETTES).sort());
    expect([...DEVICE_KEYS].sort()).toEqual(Object.keys(DEVICE_LABELS).sort());
  });

  it("have the documented sizes", () => {
    expect(DEVICE_PALETTES.cga).toHaveLength(16);
    expect(DEVICE_PALETTES.ega).toHaveLength(64);
    expect(DEVICE_PALETTES.c64).toHaveLength(16);
    expect(DEVICE_PALETTES.gameboy).toHaveLength(4);
    expect(DEVICE_PALETTES.zxspectrum).toHaveLength(16);
    expect(DEVICE_PALETTES.nes).toHaveLength(54);
  });

  it("contain only opaque, valid byte colours that fit an indexed8 palette", () => {
    for (const key of DEVICE_KEYS) {
      const pal = DEVICE_PALETTES[key];
      expect(pal.length).toBeLessThanOrEqual(255);
      for (const c of pal) {
        for (const v of [c.r, c.g, c.b]) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(255);
        }
        expect(c.a).toBe(255);
      }
    }
  });

  it("EGA is every combination of the four 2-bit levels", () => {
    const keys = new Set(DEVICE_PALETTES.ega.map((c) => `${c.r},${c.g},${c.b}`));
    expect(keys.size).toBe(64);
    for (const c of DEVICE_PALETTES.ega)
      for (const v of [c.r, c.g, c.b]) expect([0, 85, 170, 255]).toContain(v);
  });

  it("parses hex correctly", () => {
    expect(DEVICE_PALETTES.cga[6]).toEqual({ r: 0xaa, g: 0x55, b: 0x00, a: 255 });
    expect(DEVICE_PALETTES.gameboy[0]).toEqual({ r: 0x0f, g: 0x38, b: 0x0f, a: 255 });
  });
});
