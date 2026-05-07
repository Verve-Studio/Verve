type Listener = () => void;

class AdjustmentPreviewStore {
  private bypassIds = new Set<string>();
  private listeners = new Set<Listener>();

  isBypassed(layerId: string): boolean {
    return this.bypassIds.has(layerId);
  }

  setBypassed(layerId: string, bypassed: boolean): void {
    const had = this.bypassIds.has(layerId);
    if (bypassed && !had) {
      this.bypassIds.add(layerId);
      this.notify();
      return;
    }
    if (!bypassed && had) {
      this.bypassIds.delete(layerId);
      this.notify();
    }
  }

  clear(layerId: string): void {
    if (!this.bypassIds.has(layerId)) return;
    this.bypassIds.delete(layerId);
    this.notify();
  }

  clearAll(): void {
    if (this.bypassIds.size === 0) return;
    this.bypassIds.clear();
    this.notify();
  }

  snapshot(): ReadonlySet<string> {
    return new Set(this.bypassIds);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const adjustmentPreviewStore = new AdjustmentPreviewStore();
