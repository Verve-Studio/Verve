// ─── Cursor store ─────────────────────────────────────────────────────────────
// Module-level singleton. Canvas publishes pointer position here; StatusBar
// subscribes to display it. Kept outside React state to avoid re-render storms
// on every pointer-move event.

type Listener = () => void

/** Pixel info for the hovered pixel when in indexed8 mode. */
export interface IndexedPixelInfo {
  /** Palette index at the hovered pixel (0-254, or 255 for void/transparent). */
  index: number
  /** Palette color for that index, or null if index is 255 or out of range. */
  color: { r: number; g: number; b: number; a: number } | null
}

class CursorStore {
  x: number = 0
  y: number = 0
  visible: boolean = false
  /** Set while in indexed8 mode; null otherwise. */
  pixelInfo: IndexedPixelInfo | null = null

  private listeners = new Set<Listener>()

  subscribe(fn: Listener): void   { this.listeners.add(fn) }
  unsubscribe(fn: Listener): void { this.listeners.delete(fn) }
  private notify(): void          { for (const fn of this.listeners) fn() }

  setPosition(x: number, y: number): void {
    this.x = x
    this.y = y
    this.visible = true
    this.notify()
  }

  setPixelInfo(info: IndexedPixelInfo | null): void {
    this.pixelInfo = info
    this.notify()
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.notify()
  }
}

export const cursorStore = new CursorStore()
