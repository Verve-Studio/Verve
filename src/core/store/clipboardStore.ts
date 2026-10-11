// ─── Clipboard store ──────────────────────────────────────────────────────────
// Module-level singleton holding the last copied/cut pixel data.
// Stored as a tight bounding box so the data can be pasted into canvases of
// any size without buffer-size mismatches, in the source's native format so
// a copy/paste within Verve is lossless (floats keep HDR and precision,
// indexed pixels keep their palette indices).

import type { RGBAColor } from "@/types";

export type ClipboardPixels =
  /** Straight-alpha sRGB bytes. */
  | { format: "rgba8"; data: Uint8Array }
  /** Scene-linear floats. */
  | { format: "rgba32f"; data: Float32Array }
  /** Palette indices (255 = transparent) plus the source palette. */
  | { format: "indexed8"; data: Uint8Array; palette: readonly RGBAColor[] };

export type ClipboardData = ClipboardPixels & {
  /** Bounding-box dimensions. */
  width: number;
  height: number;
  /** Top-left position of the bounding box within the source canvas. */
  offsetX: number;
  offsetY: number;
};

export const clipboardStore: { current: ClipboardData | null } = {
  current: null,
};
