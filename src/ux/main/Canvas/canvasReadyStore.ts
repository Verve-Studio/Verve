/**
 * Which canvas mount last finished initialising its GPU layers, keyed
 * `${tabId}-${canvasKey}` (the Canvas element's React key). Programmatic
 * callers (the automation host) wait on it after operations that remount
 * the canvas — opening a document, switching tabs, resize / crop / rotate.
 */
let readyKey: string | null = null;
const listeners = new Set<() => void>();
let keptView: { left: number; top: number } | null = null;

export const canvasReadyStore = {
  markReady(key: string): void {
    readyKey = key;
    listeners.forEach((fn) => fn());
  },
  get readyKey(): string | null {
    return readyKey;
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Have the next canvas mount keep this scroll offset (and the current
   *  zoom) instead of fitting the document to the window. Cell animation
   *  frame loads use it so stepping frames doesn't move the view. */
  keepViewOnNextReady(scroll: { left: number; top: number } | null): void {
    keptView = scroll;
  },
  /** The view kept for this mount, or null to fit to window. One-shot. */
  takeKeptView(): { left: number; top: number } | null {
    const v = keptView;
    keptView = null;
    return v;
  },
};
