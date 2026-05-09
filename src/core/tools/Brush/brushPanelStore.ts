/**
 * Module-level singleton: visibility of the floating Brush Settings ToolWindow.
 *
 * Lives outside React state so the BrushOptions tool-options bar (which doesn't
 * have access to AppContext writers without heavy plumbing) can toggle it.
 */

class BrushPanelStore {
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

export const brushPanelStore = new BrushPanelStore();
