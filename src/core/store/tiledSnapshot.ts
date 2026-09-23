// ─── Tiled layer snapshots (history) ─────────────────────────────────────────
//
// A history entry stores each layer as immutable SNAP_TILE × SNAP_TILE tiles.
// Consecutive entries share every tile that didn't change — a small dab on a
// large layer copies only the handful of tiles it touched instead of the whole
// layer (a 278 MB copy per dab on an A1 rgba8 layer, and the 4 GB history cap
// then held ~14 undo steps). Tiles are never mutated after creation, so
// sharing them across entries (and tabs' memory accounting) is safe.

export const SNAP_TILE = 256;

export interface TiledLayerSnapshot {
  readonly width: number;
  readonly height: number;
  /** Elements per pixel: 4 (rgba8 / rgba32f) or 1 (indexed8). */
  readonly channels: 1 | 4;
  readonly float: boolean;
  readonly tilesX: number;
  readonly tilesY: number;
  /** Row-major tiles; edge tiles are cropped to the layer size. */
  readonly tiles: ReadonlyArray<Uint8Array | Float32Array>;
}

/** Layer-local rect, exclusive right/bottom. */
export interface SnapshotRect {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
}

function copyTile(
  src: Uint8Array | Float32Array,
  width: number,
  height: number,
  channels: number,
  tx: number,
  ty: number,
): Uint8Array | Float32Array {
  const x0 = tx * SNAP_TILE;
  const y0 = ty * SNAP_TILE;
  const tw = Math.min(SNAP_TILE, width - x0);
  const th = Math.min(SNAP_TILE, height - y0);
  const rowLen = tw * channels;
  const out =
    src instanceof Float32Array
      ? new Float32Array(rowLen * th)
      : new Uint8Array(rowLen * th);
  for (let y = 0; y < th; y++) {
    const s = ((y0 + y) * width + x0) * channels;
    out.set(src.subarray(s, s + rowLen), y * rowLen);
  }
  return out;
}

/** Snapshot every tile of `src` (layer-local, `width × height × channels`). */
export function snapshotFull(
  src: Uint8Array | Float32Array,
  width: number,
  height: number,
  channels: 1 | 4,
): TiledLayerSnapshot {
  const tilesX = Math.max(1, Math.ceil(width / SNAP_TILE));
  const tilesY = Math.max(1, Math.ceil(height / SNAP_TILE));
  const tiles: (Uint8Array | Float32Array)[] = [];
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      tiles.push(copyTile(src, width, height, channels, tx, ty));
    }
  }
  return {
    width,
    height,
    channels,
    float: src instanceof Float32Array,
    tilesX,
    tilesY,
    tiles,
  };
}

/**
 * New snapshot that shares `prev`'s tiles except those intersecting `dirty`,
 * which are copied from `src`. The caller guarantees that `prev` described
 * the layer exactly as it was before the changes covered by `dirty`, with the
 * same geometry and format.
 */
export function snapshotIncremental(
  prev: TiledLayerSnapshot,
  src: Uint8Array | Float32Array,
  dirty: SnapshotRect,
): TiledLayerSnapshot {
  const { width, height, channels, tilesX, tilesY } = prev;
  const tiles = prev.tiles.slice();
  const tx0 = Math.max(0, Math.floor(dirty.lx / SNAP_TILE));
  const ty0 = Math.max(0, Math.floor(dirty.ly / SNAP_TILE));
  const tx1 = Math.min(tilesX - 1, Math.floor((dirty.rx - 1) / SNAP_TILE));
  const ty1 = Math.min(tilesY - 1, Math.floor((dirty.ry - 1) / SNAP_TILE));
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      tiles[ty * tilesX + tx] = copyTile(src, width, height, channels, tx, ty);
    }
  }
  return { ...prev, tiles };
}

/** Assemble the full layer buffer from a snapshot (fresh allocation). */
export function materializeSnapshot(
  snap: TiledLayerSnapshot,
): Uint8Array | Float32Array {
  const { width, height, channels, tilesX } = snap;
  const out = snap.float
    ? new Float32Array(width * height * channels)
    : new Uint8Array(width * height * channels);
  for (let i = 0; i < snap.tiles.length; i++) {
    const tx = i % tilesX;
    const ty = (i - tx) / tilesX;
    const x0 = tx * SNAP_TILE;
    const y0 = ty * SNAP_TILE;
    const tw = Math.min(SNAP_TILE, width - x0);
    const th = Math.min(SNAP_TILE, height - y0);
    const rowLen = tw * channels;
    const tile = snap.tiles[i];
    for (let y = 0; y < th; y++) {
      (out as Uint8Array).set(
        (tile as Uint8Array).subarray(y * rowLen, (y + 1) * rowLen),
        ((y0 + y) * width + x0) * channels,
      );
    }
  }
  return out;
}

/** Materialize every snapshot in a history entry's layer map. */
export function materializeLayerPixels(
  layerPixels: ReadonlyMap<string, TiledLayerSnapshot>,
): Map<string, Uint8Array | Float32Array> {
  const out = new Map<string, Uint8Array | Float32Array>();
  for (const [id, snap] of layerPixels) out.set(id, materializeSnapshot(snap));
  return out;
}
