// Export settings rules shared by the Export dialog, export pipeline and
// automation.
import { describe, expect, it } from "vitest";
import {
  applyExportExtension,
  DEFAULT_EXPORT_SETTINGS,
  EXPORT_FORMATS,
  exportExtension,
  isLdrExport,
  maxDdsMipLevels,
  normalizeExportSettings,
  requiresFloatDocument,
  supportsLayerMode,
  type ExportFormat,
  type ExportSettings,
} from "@/core/io/exportSettings";
import { maxDdsMipLevels as wasmMaxDdsMipLevels } from "@/wasm";

const ALL: ExportFormat[] = EXPORT_FORMATS.map((f) => f.format);
const settings = (over: Partial<ExportSettings> = {}): ExportSettings => ({
  ...DEFAULT_EXPORT_SETTINGS,
  filePath: "/out/image.png",
  ...over,
});

describe("format rules", () => {
  it("float output formats are exactly the hdrOnly ones (+ float DDS modes)", () => {
    for (const f of EXPORT_FORMATS) {
      expect(requiresFloatDocument({ format: f.format, ddsCompression: "bc7" }), f.format).toBe(!!f.hdrOnly);
      expect(isLdrExport({ format: f.format, ddsCompression: "bc7" })).toBe(!f.hdrOnly);
    }
    expect(requiresFloatDocument({ format: "dds", ddsCompression: "bc6h" })).toBe(true);
    expect(requiresFloatDocument({ format: "dds", ddsCompression: "rgba32f" })).toBe(true);
    expect(requiresFloatDocument({ format: "dds", ddsCompression: "bc1" })).toBe(false);
  });

  it("layer modes: single always; multilayer only PSD/EXR; separate for flat LDR + layered formats", () => {
    for (const f of ALL) expect(supportsLayerMode(f, "single")).toBe(true);
    expect(ALL.filter((f) => supportsLayerMode(f, "multilayer")).sort()).toEqual(["exr", "psd"]);
    expect(ALL.filter((f) => supportsLayerMode(f, "separate")).sort()).toEqual(
      ["exr", "jpeg", "png", "psd", "tga", "tiff", "webp"].sort(),
    );
  });
});

describe("extensions", () => {
  it("maps each format to its file extension", () => {
    expect(exportExtension("jpeg")).toBe(".jpg");
    expect(exportExtension("tiff32")).toBe(".tiff");
    expect(exportExtension("png")).toBe(".png");
    expect(exportExtension("exr")).toBe(".exr");
  });

  it("replaces a known extension (any case) or appends one", () => {
    expect(applyExportExtension("/a/b.PNG", "jpeg")).toBe("/a/b.jpg");
    expect(applyExportExtension("/a/b.jpeg", "tiff32")).toBe("/a/b.tiff");
    expect(applyExportExtension("/a/b.tif", "webp")).toBe("/a/b.webp");
    expect(applyExportExtension("/a/b", "psd")).toBe("/a/b.psd");
    expect(applyExportExtension("/a/b.backup", "png")).toBe("/a/b.backup.png");
    expect(applyExportExtension("", "png")).toBe("");
    // Every format's own extension is recognised again.
    for (const f of ALL) expect(applyExportExtension(`x${exportExtension(f)}`, "png")).toBe("x.png");
  });
});

describe("maxDdsMipLevels", () => {
  it("keeps the smallest mip at >= 128 px and matches the WASM rule", async () => {
    expect(maxDdsMipLevels(1024, 1024)).toBe(4);
    expect(maxDdsMipLevels(1024, 256)).toBe(2);
    expect(maxDdsMipLevels(255, 4096)).toBe(1);
    expect(maxDdsMipLevels(0, 10)).toBe(1);
    for (const [w, h] of [
      [1, 1],
      [128, 128],
      [256, 255],
      [4096, 2048],
      [3000, 777],
    ] as const) {
      expect(maxDdsMipLevels(w, h)).toBe(await wasmMaxDdsMipLevels(w, h, 128));
    }
  });
});

describe("normalizeExportSettings", () => {
  const doc8 = { width: 512, height: 512, pixelFormat: "rgba8" as const };
  const docF = { width: 512, height: 512, pixelFormat: "rgba32f" as const };

  it("clamps qualities, mip count and background; trims the path", () => {
    const n = normalizeExportSettings(
      settings({
        filePath: "  /out/x.jpg  ",
        format: "jpeg",
        jpegQuality: 150.4,
        webpQuality: -5,
        jpegBackground: "red",
        ddsMipLevels: 99.7,
      }),
      doc8,
    );
    expect(n.filePath).toBe("/out/x.jpg");
    expect(n.jpegQuality).toBe(100);
    expect(n.webpQuality).toBe(1);
    expect(n.jpegBackground).toBe("#ffffff");
    expect(n.ddsMipLevels).toBe(maxDdsMipLevels(512, 512));
    expect(normalizeExportSettings(settings({ ddsMipLevels: 0 }), doc8).ddsMipLevels).toBe(1);
    expect(normalizeExportSettings(settings({ jpegBackground: "#A0b1C2" }), doc8).jpegBackground).toBe("#A0b1C2");
  });

  it("falls back to single-layer mode when the format can't write the requested mode", () => {
    const n = normalizeExportSettings(settings({ format: "png", layerMode: "multilayer", perLayerIds: ["a"] }), doc8);
    expect(n.layerMode).toBe("single");
    expect(n.perLayerIds).toBeUndefined();
    const ids = ["a", "b"];
    const s = normalizeExportSettings(settings({ format: "png", layerMode: "separate", perLayerIds: ids }), doc8);
    expect(s.perLayerIds).toEqual(ids);
    expect(s.perLayerIds).not.toBe(ids);
  });

  it("refuses float formats for non-float documents and empty paths", () => {
    expect(() => normalizeExportSettings(settings({ format: "exr" }), doc8)).toThrow(/EXR export needs a 32-bit float document/);
    expect(() => normalizeExportSettings(settings({ format: "dds", ddsCompression: "bc6h" }), doc8)).toThrow(
      /DDS BC6H export needs/,
    );
    expect(normalizeExportSettings(settings({ format: "exr" }), docF).format).toBe("exr");
    expect(() => normalizeExportSettings(settings({ filePath: "   " }), docF)).toThrow(/No export path/);
  });

  it("does not mutate its input", () => {
    const s = settings({ jpegQuality: 500 });
    const copy = structuredClone(s);
    normalizeExportSettings(s, doc8);
    expect(s).toEqual(copy);
  });
});
