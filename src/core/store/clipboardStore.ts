// ─── Clipboard store ──────────────────────────────────────────────────────────
// Module-level singleton holding the last copied/cut pixel data.
// Stored as a tight bounding box so the data can be pasted into canvases of
// any size without buffer-size mismatches.

export interface ClipboardData {
  /** Bounding-box RGBA bytes (top-row-first). Only pixels with alpha > 0. */
  data: Uint8Array;
  /** Bounding-box dimensions. */
  width: number;
  height: number;
  /** Top-left position of the bounding box within the source canvas. */
  offsetX: number;
  offsetY: number;
}

export const clipboardStore: { current: ClipboardData | null } = {
  current: null,
};
