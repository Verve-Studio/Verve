/**
 * Module-level singleton: visibility of the Paint Brushes management modal.
 *
 * Mirrors `brushPanelStore` but for the modal dialog rather than the
 * floating settings tool-window. Kept separate so the two can be open
 * independently — opening the manager doesn't dismiss the floating panel.
 */

class BrushManagerStore {
  private _visible = false;
  private listeners: Set<() => void> = new Set();

  isVisible(): boolean {
    return this._visible;
  }

  open(): void {
    if (this._visible) return;
    this._visible = true;
    this.notify();
  }

  close(): void {
    if (!this._visible) return;
    this._visible = false;
    this.notify();
  }

  toggle(): void {
    this._visible = !this._visible;
    this.notify();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }
}

export const brushManagerStore = new BrushManagerStore();
