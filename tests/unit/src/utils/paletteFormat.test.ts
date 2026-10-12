import { describe, expect, it } from "vitest";
import type { RGBAColor } from "@/types";
import { parsePaletteFile, serializePalette } from "@/utils/paletteFormat";

describe("palette files", () => {
  it("round-trips swatches and drops extra fields", () => {
    const swatches = [
      { r: 0, g: 0, b: 0, a: 255 },
      { r: 255, g: 128, b: 1, a: 0 },
    ];
    const withExtra = { ...swatches[0], extra: 1 } as RGBAColor;
    const json = serializePalette([withExtra, swatches[1]]);
    expect(JSON.parse(json)).toEqual({ version: 1, swatches });
    expect(parsePaletteFile(json)).toEqual(swatches);
  });

  it("round-trips an empty palette", () => {
    expect(parsePaletteFile(serializePalette([]))).toEqual([]);
  });

  it("accepts future versions", () => {
    expect(parsePaletteFile('{"version":3,"swatches":[{"r":1,"g":2,"b":3,"a":4}]}')).toEqual([
      { r: 1, g: 2, b: 3, a: 4 },
    ]);
  });

  it.each([
    ["not json", "{", /could not parse JSON/],
    ["array root", "[]", /root value must be an object/],
    ["null root", "null", /root value must be an object/],
    ["missing version", '{"swatches":[]}', /version/],
    ["version 0", '{"version":0,"swatches":[]}', /version/],
    ["swatches not array", '{"version":1,"swatches":{}}', /must be an array/],
    ["swatch not object", '{"version":1,"swatches":[5]}', /index 0 must be an object/],
    ["channel > 255", '{"version":1,"swatches":[{"r":256,"g":0,"b":0,"a":0}]}', /"r"/],
    ["negative channel", '{"version":1,"swatches":[{"r":0,"g":-1,"b":0,"a":0}]}', /"g"/],
    ["fractional channel", '{"version":1,"swatches":[{"r":0,"g":0,"b":0.5,"a":0}]}', /"b"/],
    ["missing alpha", '{"version":1,"swatches":[{"r":0,"g":0,"b":0}]}', /"a"/],
    ["string channel", '{"version":1,"swatches":[{"r":"1","g":0,"b":0,"a":0}]}', /"r"/],
  ])("rejects %s", (_name, json, msg) => {
    expect(() => parsePaletteFile(json)).toThrow(msg);
  });

  it("reports the index of the bad swatch", () => {
    const json = JSON.stringify({
      version: 1,
      swatches: [
        { r: 0, g: 0, b: 0, a: 0 },
        { r: 0, g: 0, b: 0, a: 300 },
      ],
    });
    expect(() => parsePaletteFile(json)).toThrow(/index 1/);
  });
});
