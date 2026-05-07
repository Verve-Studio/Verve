// ─── Clone Stamp store ────────────────────────────────────────────────────────
// Module-level singleton. The clone stamp tool handler, Canvas overlay, and
// App.tsx all import this directly.

export interface CloneStampSource {
  x: number;
  y: number;
  layerId: string;
}

class CloneStampStore {
  source: CloneStampSource | null = null;

  alignedOffset: { dx: number; dy: number } | null = null;

  onSourceDeleted: (() => void) | null = null;

  private listeners = new Set<() => void>();

  subscribe(fn: () => void): void {
    this.listeners.add(fn);
  }
  unsubscribe(fn: () => void): void {
    this.listeners.delete(fn);
  }
  notify(): void {
    for (const fn of this.listeners) fn();
  }

  setSource(x: number, y: number, layerId: string): void {
    this.source = { x, y, layerId };
    this.alignedOffset = null;
    this.notify();
  }

  clearSource(): void {
    this.source = null;
    this.alignedOffset = null;
    this.onSourceDeleted?.();
    this.notify();
  }
}

export const cloneStampStore = new CloneStampStore();
