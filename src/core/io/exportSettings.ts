/**
 * Export settings model, shared by the Export dialog, the export pipeline
 * (`useExportOps`) and the automation Export node. Format rules (which
 * formats need a float document, which support layer modes, option clamps)
 * live here so every surface applies the same ones.
 */
import type { PixelFormat, ToneMappingOperator } from "@/types";

export type ExportFormat =
  | "png"
  | "jpeg"
  | "webp"
  | "tga"
  | "tiff"
  | "exr"
  | "hdr"
  | "tiff32"
  | "dds"
  | "psd"
  | "pdf";
export type DdsCompression = "bc1" | "bc3" | "bc7" | "bc6h" | "rgba32f";

/** How layers are encoded into the exported file(s).
 *  - "single"     : flatten everything into one image (single-layer file).
 *  - "multilayer" : write one file that preserves the layer structure.
 *                   Only meaningful for layer-capable formats (PSD, EXR).
 *  - "separate"   : write one file per selected layer, named
 *                   `<filePath-stem>_<sanitised-layer-name>.<ext>`. */
export type LayerExportMode = "single" | "multilayer" | "separate";

/** How a float (HDR) document is reduced to 8 bits for LDR formats. */
export interface ExportToneMapping {
  operator: ToneMappingOperator;
  exposureEV: number;
}

export interface ExportSettings {
  filePath: string;
  format: ExportFormat;
  jpegQuality: number; // 0–100
  jpegBackground: string; // CSS hex colour
  webpQuality: number; // 0–100
  exrCompression: 0 | 1 | 2 | 3; // 0=none,1=zip,2=zips,3=piz
  exrHalfFloat: boolean;
  ddsCompression: DdsCompression;
  ddsMipLevels: number; // >= 1
  layerMode: LayerExportMode;
  /** IDs of the layers to export when `layerMode === "separate"`. */
  perLayerIds?: string[];
  /** Float documents → LDR formats. Omitted: the document's current
   *  display tone mapping and exposure (what the Export dialog does). */
  toneMapping?: ExportToneMapping;
}

export const EXPORT_FORMATS: readonly { format: ExportFormat; label: string; hdrOnly?: boolean }[] = [
  { format: "png", label: "PNG" },
  { format: "jpeg", label: "JPEG" },
  { format: "webp", label: "WebP" },
  { format: "tga", label: "TGA" },
  { format: "tiff", label: "TIFF" },
  { format: "psd", label: "PSD (Photoshop)" },
  { format: "pdf", label: "PDF" },
  { format: "dds", label: "DDS" },
  { format: "exr", label: "OpenEXR", hdrOnly: true },
  { format: "hdr", label: "Radiance HDR (.hdr)", hdrOnly: true },
  { format: "tiff32", label: "TIFF (32-bit float)", hdrOnly: true },
];

export const DDS_COMPRESSIONS: readonly { value: DdsCompression; label: string; hdrOnly?: boolean }[] = [
  { value: "bc7", label: "BC7 — high quality, RGBA" },
  { value: "bc3", label: "BC3 — DXT5, RGBA" },
  { value: "bc1", label: "BC1 — DXT1, RGB (smallest)" },
  { value: "bc6h", label: "BC6H — HDR, lossy", hdrOnly: true },
  { value: "rgba32f", label: "RGBA32F — HDR, lossless", hdrOnly: true },
];

export const EXR_COMPRESSIONS: readonly { value: 0 | 1 | 2 | 3; label: string }[] = [
  { value: 0, label: "None" },
  { value: 1, label: "ZIP (lossless, scanline)" },
  { value: 2, label: "ZIPS (lossless, single scanline)" },
  { value: 3, label: "PIZ (lossless, wavelet)" },
];

export const DEFAULT_EXPORT_SETTINGS: Omit<ExportSettings, "filePath"> = {
  format: "png",
  jpegQuality: 92,
  jpegBackground: "#ffffff",
  webpQuality: 90,
  exrCompression: 0,
  exrHalfFloat: false,
  ddsCompression: "bc7",
  ddsMipLevels: 1,
  layerMode: "single",
};

export const isFlatLdrFormat = (f: ExportFormat): boolean =>
  f === "png" || f === "jpeg" || f === "webp" || f === "tga" || f === "tiff";

/** PSD / EXR keep the layer structure. */
export const isLayerCapableFormat = (f: ExportFormat): boolean => f === "psd" || f === "exr";

/** Whether `format` can write the layer mode at all. */
export function supportsLayerMode(format: ExportFormat, mode: LayerExportMode): boolean {
  if (mode === "single") return true;
  if (mode === "separate") return isFlatLdrFormat(format) || isLayerCapableFormat(format);
  return isLayerCapableFormat(format);
}

/** Formats / DDS modes that keep float data; the rest are 8-bit and tone
 *  map float documents. */
export function isLdrExport(s: Pick<ExportSettings, "format" | "ddsCompression">): boolean {
  if (s.format === "exr" || s.format === "hdr" || s.format === "tiff32") return false;
  return !(s.format === "dds" && (s.ddsCompression === "bc6h" || s.ddsCompression === "rgba32f"));
}

/** Float output needs a float (rgba32f) document. */
export function requiresFloatDocument(s: Pick<ExportSettings, "format" | "ddsCompression">): boolean {
  return !isLdrExport(s);
}

/** Maximum mip levels such that the smallest level stays >= 128 px (each
 *  level halves both dimensions). */
export function maxDdsMipLevels(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 1;
  let levels = 1;
  let cw = width;
  let ch = height;
  while (cw >> 1 >= 128 && ch >> 1 >= 128) {
    cw >>= 1;
    ch >>= 1;
    levels++;
  }
  return levels;
}

/** Replace or append the correct extension for `format`. */
export function applyExportExtension(filePath: string, format: ExportFormat): string {
  if (!filePath) return filePath;
  return filePath.replace(/\.(png|jpe?g|webp|tga|tiff?|exr|hdr|dds|psd|pdf)$/i, "") + exportExtension(format);
}

export function exportExtension(format: ExportFormat): string {
  switch (format) {
    case "jpeg":
      return ".jpg";
    case "tiff32":
      return ".tiff";
    default:
      return `.${format}`;
  }
}

/**
 * Clamp options to their valid ranges and the layer mode to what the format
 * supports (the Export dialog's rules). Throws when the format can't be
 * written from a document of `pixelFormat`.
 */
export function normalizeExportSettings(
  s: ExportSettings,
  doc: { width: number; height: number; pixelFormat: PixelFormat },
): ExportSettings {
  if (!s.filePath.trim()) throw new Error("No export path.");
  if (requiresFloatDocument(s) && doc.pixelFormat !== "rgba32f") {
    throw new Error(
      `${s.format === "dds" ? `DDS ${s.ddsCompression.toUpperCase()}` : s.format.toUpperCase()} export needs a 32-bit float document (Image → Color Mode → RGB/32 Float).`,
    );
  }
  const clampQ = (q: number): number => Math.max(1, Math.min(100, Math.round(q)));
  const layerMode = supportsLayerMode(s.format, s.layerMode) ? s.layerMode : "single";
  return {
    ...s,
    filePath: s.filePath.trim(),
    jpegQuality: clampQ(s.jpegQuality),
    webpQuality: clampQ(s.webpQuality),
    jpegBackground: /^#[0-9a-f]{6}$/i.test(s.jpegBackground) ? s.jpegBackground : "#ffffff",
    ddsMipLevels: Math.max(1, Math.min(maxDdsMipLevels(doc.width, doc.height), Math.floor(s.ddsMipLevels))),
    layerMode,
    perLayerIds: layerMode === "separate" ? s.perLayerIds?.slice() : undefined,
  };
}
