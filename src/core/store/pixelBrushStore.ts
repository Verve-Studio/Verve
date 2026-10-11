/**
 * Module-level singleton for user-profile pixel brushes.
 *
 * These brushes are persisted to electron userData (pixel-brushes.json)
 * and are available across all documents. Document-scoped brushes live in
 * AppState.pixelBrushes and are saved inside the .verve file.
 */
import type { PixelBrush } from "@/types";
import { base64ToBytes, bytesToBase64 } from "@/utils/base64";

// ─── Brush file format ────────────────────────────────────────────────────────
//
// `pixel-brushes.json` / `.pxbrush` are JSON, so the RGBA payload is base64
// in the file only; in memory it's a Uint8Array.

/** A pixel brush as written to a file: `rgba` is base64 (brush files) or a
 *  container blob reference (`.verve`). */
export type SerializedPixelBrush = Omit<PixelBrush, "rgba"> & { rgba: string };

interface PixelBrushFile {
  version: 1;
  brushes: SerializedPixelBrush[];
}

export function serializePixelBrushFile(brushes: PixelBrush[]): string {
  const file: PixelBrushFile = {
    version: 1,
    brushes: brushes.map((b) => ({ ...b, rgba: bytesToBase64(b.rgba) })),
  };
  return JSON.stringify(file, null, 2);
}

/** Structural check for a pixel brush: positive integer size and a payload
 *  of exactly width × height × 4 bytes. Malformed brushes (zero size → NaN
 *  grid snapping, truncated data) broke painting. */
export function isValidPixelBrush(b: unknown): b is PixelBrush {
  if (typeof b !== "object" || b === null) return false;
  const r = b as Record<string, unknown>;
  const { width: w, height: h, rgba, id } = r;
  if (typeof id !== "string" || !(rgba instanceof Uint8Array)) return false;
  if (!Number.isInteger(w) || !Number.isInteger(h)) return false;
  if ((w as number) < 1 || (h as number) < 1 || (w as number) * (h as number) > 1 << 20)
    return false;
  return rgba.length === (w as number) * (h as number) * 4;
}

/** Rebuild a serialized brush, resolving its `rgba` string through
 *  `decode`; null when the brush is malformed. */
export function deserializePixelBrush(
  raw: unknown,
  decode: (rgba: string) => Uint8Array,
): PixelBrush | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.rgba !== "string") return null;
  try {
    const brush = { ...r, rgba: decode(r.rgba) };
    return isValidPixelBrush(brush) ? brush : null;
  } catch {
    return null;
  }
}

export function parsePixelBrushFile(json: string): PixelBrush[] {
  let list: unknown[] = [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) {
      list = parsed;
    } else if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { brushes?: unknown }).brushes)
    ) {
      list = (parsed as { brushes: unknown[] }).brushes;
    }
  } catch {
    // corrupt — ignore
  }
  return list
    .map((b) => deserializePixelBrush(b, base64ToBytes))
    .filter((b): b is PixelBrush => b !== null);
}

// ─── Store class ──────────────────────────────────────────────────────────────

class PixelBrushStore {
  private brushes: PixelBrush[] = [];
  private listeners: Set<() => void> = new Set();
  private _initialized = false;

  /** Load user brushes from electron userData. Call once at app startup. */
  async init(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;
    try {
      const json = await window.api.loadUserPixelBrushes();
      this.brushes = parsePixelBrushFile(json);
    } catch {
      this.brushes = [];
    }
    this.notify();
  }

  getUserBrushes(): PixelBrush[] {
    return this.brushes;
  }

  async addUserBrush(brush: PixelBrush): Promise<void> {
    this.brushes = [...this.brushes, brush];
    this.notify();
    await this.persist();
  }

  async removeUserBrush(id: string): Promise<void> {
    this.brushes = this.brushes.filter((b) => b.id !== id);
    this.notify();
    await this.persist();
  }

  async renameUserBrush(id: string, name: string): Promise<void> {
    this.brushes = this.brushes.map((b) => (b.id === id ? { ...b, name } : b));
    this.notify();
    await this.persist();
  }

  async setUserBrushes(brushes: PixelBrush[]): Promise<void> {
    this.brushes = brushes;
    this.notify();
    await this.persist();
  }

  subscribe(fn: () => void): void {
    this.listeners.add(fn);
  }

  unsubscribe(fn: () => void): void {
    this.listeners.delete(fn);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  private async persist(): Promise<void> {
    try {
      await window.api.saveUserPixelBrushes(
        serializePixelBrushFile(this.brushes),
      );
    } catch {
      // non-fatal
    }
  }
}

export const pixelBrushStore = new PixelBrushStore();
