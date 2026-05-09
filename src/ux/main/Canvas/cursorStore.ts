// ─── Cursor store ─────────────────────────────────────────────────────────────
// Module-level singleton. Canvas publishes pointer position here; StatusBar
// subscribes to display it. Kept outside React state to avoid re-render storms
// on every pointer-move event.

type Listener = () => void;

/** Pixel info for the hovered pixel when in indexed8 mode. */
export interface IndexedPixelInfo {
  /** Palette index at the hovered pixel (0-254, or 255 for void/transparent). */
  index: number;
  /** Palette color for that index, or null if index is 255 or out of range. */
  color: { r: number; g: number; b: number; a: number } | null;
}

class CursorStore {
  x: number = 0;
  y: number = 0;
  visible: boolean = false;
  /** Set while in indexed8 mode; null otherwise. */
  pixelInfo: IndexedPixelInfo | null = null;
  /** Raw channel values at the cursor pixel, or null when unavailable. */
  pixelValues: number[] | null = null;
  /** True when pixelValues are in float (0.0–1.0) range (rgba32f mode). */
  pixelIsFloat: boolean = false;

  private listeners = new Set<Listener>();

  // Notifications are coalesced to one per animation frame. Pointer events fire at
  // up to ~1000 Hz (high-poll mice) and pen tablets emit ~20 coalesced events per
  // frame; without coalescing, every event triggered React re-renders in StatusBar,
  // InfoPanel and a ruler repaint, which compounded with WebGPU work to cause
  // sluggish painting. Subscribers always read the latest state via the store fields.
  private rafScheduled = false;
  private flushNotify(): void {
    this.rafScheduled = false;
    for (const fn of this.listeners) fn();
  }
  private scheduleNotify(): void {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => this.flushNotify());
  }

  subscribe(fn: Listener): void {
    this.listeners.add(fn);
  }
  unsubscribe(fn: Listener): void {
    this.listeners.delete(fn);
  }

  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.visible = true;
    this.scheduleNotify();
  }

  setPixelInfo(info: IndexedPixelInfo | null): void {
    this.pixelInfo = info;
    this.scheduleNotify();
  }

  setPixelValues(values: number[] | null, isFloat: boolean): void {
    this.pixelValues = values;
    this.pixelIsFloat = isFloat;
    this.scheduleNotify();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.scheduleNotify();
  }
}

export const cursorStore = new CursorStore();
