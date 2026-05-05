/**
 * Module-level singleton for user-profile pixel brushes.
 *
 * These brushes are persisted to electron userData (pixel-brushes.json)
 * and are available across all documents. Document-scoped brushes live in
 * AppState.pixelBrushes and are saved inside the .verve file.
 */
import type { PixelBrush } from "@/types";

// ─── Brush file format ────────────────────────────────────────────────────────

export interface PixelBrushFile {
  version: 1;
  brushes: PixelBrush[];
}

export function serializePixelBrushFile(brushes: PixelBrush[]): string {
  const file: PixelBrushFile = { version: 1, brushes };
  return JSON.stringify(file, null, 2);
}

export function parsePixelBrushFile(json: string): PixelBrush[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) {
      // Plain array — legacy/simple format
      return parsed as PixelBrush[];
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "brushes" in parsed &&
      Array.isArray((parsed as PixelBrushFile).brushes)
    ) {
      return (parsed as PixelBrushFile).brushes;
    }
  } catch {
    // corrupt — ignore
  }
  return [];
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
