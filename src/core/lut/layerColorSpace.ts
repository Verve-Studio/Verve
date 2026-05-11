// ─── Layer colour-space → IDT resolution ─────────────────────────────────────
//
// Pure helpers used by the renderer + UI to translate a `LayerColorSpace`
// tag into rendering decisions:
//
//   - `effectiveColorSpace(layer)` — resolves `'auto'` to the concrete
//     working-space tag for the layer's pixel format.
//   - `idtLutIdFor(space)` — returns the built-in IDT LUT id that decodes
//     a tagged log-encoded layer into the document's working space, or
//     `null` if no decode is needed.

import type { LayerColorSpace, PixelFormat } from "@/types";

/** Resolve `'auto'` to the concrete tag for a layer's pixel format.
 *  `'auto' + rgba8/indexed8` → `'srgb'`; `'auto' + rgba32f` → `'linear-srgb'`. */
export function effectiveColorSpace(
  space: LayerColorSpace | undefined,
  format: PixelFormat,
): Exclude<LayerColorSpace, "auto"> {
  if (!space || space === "auto") {
    return format === "rgba32f" ? "linear-srgb" : "srgb";
  }
  return space;
}

/** Built-in IDT LUT id that decodes a given log-encoded space to scene-linear
 *  sRGB. Returns `null` for working-space-native tags (`'srgb'`,
 *  `'linear-srgb'`) where no decode is required. */
export function idtLutIdFor(space: LayerColorSpace | undefined): string | null {
  switch (space) {
    case "slog3":
      return "builtin:idt-sony-slog3";
    case "logc3":
      return "builtin:idt-arri-logc3";
    case "vlog":
      return "builtin:idt-panasonic-vlog";
    case "red-log3g10":
      return "builtin:idt-red-log3g10";
    case "clog3":
      return "builtin:idt-canon-clog3";
    case "apple-log":
      return "builtin:idt-apple-log";
    case "aces-cg":
      return "builtin:idt-acescg";
    default:
      return null;
  }
}

export const ALL_LAYER_COLOR_SPACES: LayerColorSpace[] = [
  "auto",
  "srgb",
  "linear-srgb",
  "aces-cg",
  "slog3",
  "logc3",
  "vlog",
  "red-log3g10",
  "clog3",
  "apple-log",
];

export const LAYER_COLOR_SPACE_LABEL: Record<LayerColorSpace, string> = {
  auto: "Auto (document working space)",
  srgb: "sRGB (display-encoded)",
  "linear-srgb": "Linear sRGB (scene-linear)",
  "aces-cg": "ACEScg (AP1 primaries, scene-linear)",
  slog3: "Sony S-Log3 / S-Gamut3.Cine",
  logc3: "ARRI LogC3 / Wide Gamut",
  vlog: "Panasonic V-Log / V-Gamut",
  "red-log3g10": "RED Log3G10 / REDWideGamutRGB",
  clog3: "Canon C-Log3 / Cinema Gamut",
  "apple-log": "Apple Log / Rec.2020",
};
