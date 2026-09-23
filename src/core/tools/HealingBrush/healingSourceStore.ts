// ─── Healing Brush source store ──────────────────────────────────────────────
// Per-document (lives in `DocumentScope`): the alt-click source anchor must
// not follow the user into another tab. Listeners are module-level so a panel
// that subscribed while one tab was active still wakes up after a switch.

export interface HealingSource {
  /** Anchor in canvas-space pixels. Set by alt-click. */
  x: number;
  y: number;
  /** ID of the layer the alt-click landed on (used to read source pixels). */
  layerId: string;
}

const listeners = new Set<() => void>();

export class HealingSourceStore {
  source: HealingSource | null = null;

  /** Source-to-destination offset locked at the start of an aligned stroke.
   *  Cleared when Aligned is OFF or when the source is re-set. */
  alignedOffset: { dx: number; dy: number } | null = null;

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
}
