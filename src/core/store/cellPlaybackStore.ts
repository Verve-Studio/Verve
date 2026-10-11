/**
 * Live cell animation playback, polled by the canvas overlay. Kept outside
 * React state so a 24 fps playback doesn't re-render the app every tick.
 *
 * While `showing` is set the canvas hides the document and the overlay shows
 * the preview of frame `index` instead. It stays set after playback stops
 * until the frame the user stopped on has loaded onto the canvas.
 */

type Listener = () => void;

export interface CellPlaybackSnapshot {
  playing: boolean;
  /** The overlay covers the document with frame `index`'s preview. */
  showing: boolean;
  /** Index into `cellAnimation.frames` of the frame on screen. */
  index: number;
}

let snapshot: CellPlaybackSnapshot = { playing: false, showing: false, index: 0 };
const listeners = new Set<Listener>();

export const cellPlaybackStore = {
  get snapshot(): CellPlaybackSnapshot {
    return snapshot;
  },
  update(patch: Partial<CellPlaybackSnapshot>): void {
    const next = { ...snapshot, ...patch };
    if (
      next.playing === snapshot.playing &&
      next.showing === snapshot.showing &&
      next.index === snapshot.index
    ) {
      return;
    }
    snapshot = next;
    listeners.forEach((fn) => fn());
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
