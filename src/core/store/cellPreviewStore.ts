/**
 * Flattened previews of cell animation frames (onion skin, playback and the
 * Animation panel's thumbnails), keyed by frame file path. Module-global:
 * keyed by path, a folder open in several tabs shares its previews.
 *
 * Bitmaps are GPU-backed; entries are closed when replaced or dropped.
 */

type Listener = () => void;

const bitmaps = new Map<string, ImageBitmap>();
const listeners = new Set<Listener>();
let version = 0;

const key = (path: string): string => path.replace(/\\/g, "/").toLowerCase();

function notify(): void {
  version++;
  listeners.forEach((fn) => fn());
}

export const cellPreviewStore = {
  get(path: string): ImageBitmap | undefined {
    return bitmaps.get(key(path));
  },
  has(path: string): boolean {
    return bitmaps.has(key(path));
  },
  set(path: string, bitmap: ImageBitmap): void {
    const k = key(path);
    const prev = bitmaps.get(k);
    if (prev && prev !== bitmap) prev.close();
    bitmaps.set(k, bitmap);
    notify();
  },
  delete(path: string): void {
    const k = key(path);
    const prev = bitmaps.get(k);
    if (!prev) return;
    prev.close();
    bitmaps.delete(k);
    notify();
  },
  /** Increments on every change (for `useSyncExternalStore`). */
  get version(): number {
    return version;
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
