import type { RGBAColor } from "@/types";

function hex(s: string): RGBAColor {
  return {
    r: parseInt(s.slice(1, 3), 16),
    g: parseInt(s.slice(3, 5), 16),
    b: parseInt(s.slice(5, 7), 16),
    a: 255,
  };
}

export type DevicePaletteKey =
  | "cga"
  | "ega"
  | "c64"
  | "gameboy"
  | "zxspectrum"
  | "nes";

// ─── CGA (16 colors) ──────────────────────────────────────────────────────────

const CGA: RGBAColor[] = [
  "#000000",
  "#0000AA",
  "#00AA00",
  "#00AAAA",
  "#AA0000",
  "#AA00AA",
  "#AA5500",
  "#AAAAAA",
  "#555555",
  "#5555FF",
  "#55FF55",
  "#55FFFF",
  "#FF5555",
  "#FF55FF",
  "#FFFF55",
  "#FFFFFF",
].map(hex);

// ─── EGA (64 colors — all RGB combinations of {0, 85, 170, 255}) ─────────────

const EGA: RGBAColor[] = (() => {
  const colors: RGBAColor[] = [];
  for (const r of [0, 85, 170, 255]) {
    for (const g of [0, 85, 170, 255]) {
      for (const b of [0, 85, 170, 255]) {
        colors.push({ r, g, b, a: 255 });
      }
    }
  }
  return colors;
})();

// ─── Commodore 64 (16 colors) ─────────────────────────────────────────────────

const C64: RGBAColor[] = [
  "#000000",
  "#FFFFFF",
  "#813338",
  "#75CEC8",
  "#8E3C97",
  "#56AC4D",
  "#2E2C9B",
  "#EDF171",
  "#8E5029",
  "#553800",
  "#C46C71",
  "#4A4A4A",
  "#7B7B7B",
  "#A9FF9F",
  "#706DEB",
  "#B2B2B2",
].map(hex);

// ─── Game Boy (4 colors) ──────────────────────────────────────────────────────

const GAMEBOY: RGBAColor[] = ["#0F380F", "#306230", "#8BAC0F", "#9BBC0F"].map(
  hex,
);

// ─── ZX Spectrum (16 colors) ──────────────────────────────────────────────────

const ZXSPECTRUM: RGBAColor[] = [
  "#000000",
  "#0000C5",
  "#C50000",
  "#C500C5",
  "#00C500",
  "#00C5C5",
  "#C5C500",
  "#C5C5C5",
  "#000000",
  "#0000FF",
  "#FF0000",
  "#FF00FF",
  "#00FF00",
  "#00FFFF",
  "#FFFF00",
  "#FFFFFF",
].map(hex);

// ─── NES (54 colors) ──────────────────────────────────────────────────────────

const NES: RGBAColor[] = [
  "#000000",
  "#747474",
  "#24188C",
  "#0000A8",
  "#44009C",
  "#8C0074",
  "#A80010",
  "#A40000",
  "#7C0800",
  "#402C00",
  "#004400",
  "#005000",
  "#003C14",
  "#183C5C",
  "#BCBCBC",
  "#0070EC",
  "#2038EC",
  "#8000F0",
  "#BC00BC",
  "#E40058",
  "#D82800",
  "#C84C0C",
  "#887000",
  "#009400",
  "#00A800",
  "#009038",
  "#0080A8",
  "#FCFCFC",
  "#3CBCFC",
  "#5C94FC",
  "#CC88FC",
  "#F478FC",
  "#FC74B4",
  "#FC7460",
  "#FC9840",
  "#F0BC3C",
  "#80D010",
  "#4CDC48",
  "#58F898",
  "#00E8D8",
  "#787878",
  "#A8E4FC",
  "#C4D4FC",
  "#D4C8FC",
  "#FCC4FC",
  "#FCC4D8",
  "#FCBCB0",
  "#FCD8A8",
  "#FCE4A0",
  "#E0F8A0",
  "#A8F0BC",
  "#B0FCCC",
  "#9EFCF4",
  "#C8C8C8",
].map(hex);

// ─── Registry ─────────────────────────────────────────────────────────────────

export const DEVICE_PALETTES: Record<DevicePaletteKey, RGBAColor[]> = {
  cga: CGA,
  ega: EGA,
  c64: C64,
  gameboy: GAMEBOY,
  zxspectrum: ZXSPECTRUM,
  nes: NES,
};

export const DEVICE_LABELS: Record<DevicePaletteKey, string> = {
  cga: "CGA",
  ega: "EGA",
  c64: "Commodore 64",
  gameboy: "Game Boy",
  zxspectrum: "ZX Spectrum",
  nes: "NES",
};

export const DEVICE_KEYS: DevicePaletteKey[] = [
  "cga",
  "ega",
  "c64",
  "gameboy",
  "zxspectrum",
  "nes",
];
