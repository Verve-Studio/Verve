/**
 * Module-level singleton for user-profile paint brushes.
 *
 * Persisted to electron userData/paint-brushes.json. Document-scoped brushes
 * live on AppState.brushes and are saved inside the .verve file.
 */
import type { Brush } from "@/types";

interface PaintBrushFile {
  version: 1;
  brushes: Brush[];
}

export function serializeBrushFile(brushes: Brush[]): string {
  const file: PaintBrushFile = { version: 1, brushes };
  return JSON.stringify(file, null, 2);
}

export function parseBrushFile(json: string): Brush[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) return parsed as Brush[];
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "brushes" in parsed &&
      Array.isArray((parsed as PaintBrushFile).brushes)
    ) {
      return (parsed as PaintBrushFile).brushes;
    }
  } catch {
    // corrupt — ignore
  }
  return [];
}

class BrushStore {
  private brushes: Brush[] = [];
  private listeners: Set<() => void> = new Set();
  private _initialized = false;

  async init(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;
    try {
      const json = await window.api.loadUserBrushes();
      this.brushes = parseBrushFile(json);
    } catch {
      this.brushes = [];
    }
    this.notify();
  }

  getUserBrushes(): Brush[] {
    return this.brushes;
  }

  async addUserBrush(brush: Brush): Promise<void> {
    this.brushes = [...this.brushes, brush];
    this.notify();
    await this.persist();
  }

  async updateUserBrush(brush: Brush): Promise<void> {
    this.brushes = this.brushes.map((b) => (b.id === brush.id ? brush : b));
    this.notify();
    await this.persist();
  }

  async removeUserBrush(id: string): Promise<void> {
    this.brushes = this.brushes.filter((b) => b.id !== id);
    this.notify();
    await this.persist();
  }

  async setUserBrushes(brushes: Brush[]): Promise<void> {
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
      await window.api.saveUserBrushes(serializeBrushFile(this.brushes));
    } catch {
      // non-fatal
    }
  }
}

export const brushStore = new BrushStore();
