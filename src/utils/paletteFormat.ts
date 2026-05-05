import type { RGBAColor } from "@/types";

interface PaletteFile {
  version: number;
  swatches: { r: number; g: number; b: number; a: number }[];
}

export function serializePalette(swatches: RGBAColor[]): string {
  const file: PaletteFile = {
    version: 1,
    swatches: swatches.map(({ r, g, b, a }) => ({ r, g, b, a })),
  };
  return JSON.stringify(file, null, 2);
}

export function parsePaletteFile(json: string): RGBAColor[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `Invalid palette file: could not parse JSON. ${(e as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid palette file: root value must be an object.");
  }

  const root = parsed as Record<string, unknown>;

  if (typeof root.version !== "number" || root.version < 1) {
    throw new Error(
      'Invalid palette file: missing or unsupported "version" field.',
    );
  }

  if (!Array.isArray(root.swatches)) {
    throw new Error('Invalid palette file: "swatches" must be an array.');
  }

  const swatches: RGBAColor[] = [];
  for (let i = 0; i < root.swatches.length; i++) {
    const s = root.swatches[i];
    if (typeof s !== "object" || s === null || Array.isArray(s)) {
      throw new Error(
        `Invalid palette file: swatch at index ${i} must be an object.`,
      );
    }
    const sw = s as Record<string, unknown>;
    for (const ch of ["r", "g", "b", "a"] as const) {
      const v = sw[ch];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255) {
        throw new Error(
          `Invalid palette file: swatch at index ${i} has invalid "${ch}" value (must be an integer 0–255).`,
        );
      }
    }
    swatches.push({
      r: sw.r as number,
      g: sw.g as number,
      b: sw.b as number,
      a: sw.a as number,
    });
  }

  return swatches;
}
