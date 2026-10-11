/**
 * Which canvas mount last finished initialising its GPU layers, keyed
 * `${tabId}-${canvasKey}` (the Canvas element's React key). Programmatic
 * callers (the automation host) wait on it after operations that remount
 * the canvas — opening a document, switching tabs, resize / crop / rotate.
 */
let readyKey: string | null = null;
const listeners = new Set<() => void>();

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
};
