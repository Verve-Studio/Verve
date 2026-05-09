// ─── Clone Stamp store ────────────────────────────────────────────────────────
// Module-level singleton. The clone stamp tool handler, Canvas overlay, and
// App.tsx all import this directly.

export interface CloneStampSource {
  x: number;
  y: number;
  layerId: string;
}

const listeners = new Set<() => void>();
// App-level handler — registered once and shared across every per-tab
// instance so it survives `setActiveScope` swapping the active scope.
const appHandlers: { onSourceDeleted: (() => void) | null } = {
  onSourceDeleted: null,
};

export class CloneStampStore {
  source: CloneStampSource | null = null;

  alignedOffset: { dx: number; dy: number } | null = null;

  get onSourceDeleted(): (() => void) | null {
    return appHandlers.onSourceDeleted;
  }
  set onSourceDeleted(fn: (() => void) | null) {
    appHandlers.onSourceDeleted = fn;
  }

  subscribe(fn: () => void): void {
    listeners.add(fn);
  }
  unsubscribe(fn: () => void): void {
    listeners.delete(fn);
  }
  notify(): void {
    for (const fn of listeners) fn();
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
