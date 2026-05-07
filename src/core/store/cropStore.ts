// ─── Crop store ───────────────────────────────────────────────────────────────
// Module-level singleton. The crop tool and Canvas overlay both import this
// directly; App.tsx registers an onCrop callback to perform the actual crop.

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Listener = () => void;

class CropStore {
  /** Live drag preview (before pointer-up). Drawn by Canvas overlay in orange. */
  pendingRect: { x1: number; y1: number; x2: number; y2: number } | null = null;
  /** Committed crop rectangle (after pointer-up). Displayed in options bar. */
  rect: CropRect | null = null;
  /** Set by App.tsx — called when the user presses the Crop button. */
  onCrop: (() => void) | null = null;

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): void {
    this.listeners.add(fn);
  }
  unsubscribe(fn: Listener): void {
    this.listeners.delete(fn);
  }
  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** Update the live drag preview. Clears any previously committed rect. */
  setPending(x1: number, y1: number, x2: number, y2: number): void {
    this.pendingRect = { x1, y1, x2, y2 };
    this.rect = null;
    this.notify();
  }

  /** Commit the pending drag into a normalised CropRect. */
  commitRect(x1: number, y1: number, x2: number, y2: number): void {
    this.pendingRect = null;
    const x = Math.round(Math.min(x1, x2));
    const y = Math.round(Math.min(y1, y2));
    const w = Math.round(Math.abs(x2 - x1));
    const h = Math.round(Math.abs(y2 - y1));
    this.rect = w > 0 && h > 0 ? { x, y, w, h } : null;
    this.notify();
  }

  clear(): void {
    this.pendingRect = null;
    this.rect = null;
    this.notify();
  }

  /** Called by the Crop button in the options bar. */
  triggerCrop(): void {
    this.onCrop?.();
  }
}

export const cropStore = new CropStore();
