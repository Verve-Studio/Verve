// ─── Tiled layer snapshots (history) ─────────────────────────────────────────
//
// A history entry stores each layer as immutable SNAP_TILE × SNAP_TILE tiles.
// Consecutive entries share every tile that didn't change — a small dab on a
// large layer copies only the handful of tiles it touched instead of the whole
// layer (a 278 MB copy per dab on an A1 rgba8 layer, and the 4 GB history cap
// then held ~14 undo steps). Tiles are never mutated after creation, so
// sharing them across entries (and tabs' memory accounting) is safe.
//
// Baseline invariant (see LayerTextureStore's history tracking): each live
// layer has a "history base" snapshot. The layer's pixels equal the base
// except in the tiles flagged since the base was set. Capture sets the base to
// the snapshot it produced; restore sets it to the snapshot it wrote. When the
// store can't vouch for that (new layer, grow, remount, format change) it
// reports "all" and the capture falls back to a content comparison.

import type { LayerHistoryChange } from "@/graphics/webgpu/layers/LayerTextureStore";

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

/** Tiles across / down for a layer of `size` pixels. */
export function snapTileCount(size: number): number {
  return Math.max(1, Math.ceil(size / SNAP_TILE));
}

/** Whether `snap` has the given geometry and element layout. */
export function snapshotMatches(
  snap: TiledLayerSnapshot | null | undefined,
  width: number,
  height: number,
  channels: 1 | 4,
  float: boolean,
): snap is TiledLayerSnapshot {
  return (
    !!snap &&
    snap.width === width &&
    snap.height === height &&
    snap.channels === channels &&
    snap.float === float
  );
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

function u32View(a: Uint8Array | Float32Array): Uint32Array | null {
  if (a.byteOffset % 4 !== 0) return null;
  return new Uint32Array(a.buffer, a.byteOffset, a.byteLength >>> 2);
}

/** Bitwise comparison of tile (tx, ty) of `src` with `tile`. */
function tileEquals(
  src: Uint8Array | Float32Array,
  src32: Uint32Array | null,
  width: number,
  height: number,
  channels: number,
  tx: number,
  ty: number,
  tile: Uint8Array | Float32Array,
): boolean {
  const x0 = tx * SNAP_TILE;
  const y0 = ty * SNAP_TILE;
  const tw = Math.min(SNAP_TILE, width - x0);
  const th = Math.min(SNAP_TILE, height - y0);
  const rowLen = tw * channels;
  if (tile.length !== rowLen * th) return false;
  const bpe = src.BYTES_PER_ELEMENT;
  const rowBytes = rowLen * bpe;
  // Word-wise compare when every row starts on a 4-byte boundary (always
  // true for rgba8 / rgba32f); bytes otherwise (odd-width indexed8).
  const tile32 = src32 && rowBytes % 4 === 0 ? u32View(tile) : null;
  for (let y = 0; y < th; y++) {
    const s = ((y0 + y) * width + x0) * channels;
    if (tile32 && src32) {
      const sw = (s * bpe) >>> 2;
      const tw32 = (y * rowBytes) >>> 2;
      const n = rowBytes >>> 2;
      for (let i = 0; i < n; i++) {
        if (src32[sw + i] !== tile32[tw32 + i]) return false;
      }
    } else {
      const t = y * rowLen;
      for (let i = 0; i < rowLen; i++) {
        // Float tiles never take this path (rows are 4-byte aligned).
        if (src[s + i] !== tile[t + i]) return false;
      }
    }
  }
  return true;
}

/**
 * Snapshot every tile of `src` (layer-local, `width × height × channels`).
 * With `reuse` (same geometry and layout), tiles whose pixels are bitwise
 * equal to `reuse`'s are shared instead of copied — so a capture after a
 * remount or a wholesale replace that didn't actually change pixels costs a
 * comparison, not a second copy of the layer in history.
 */
export function snapshotFull(
  src: Uint8Array | Float32Array,
  width: number,
  height: number,
  channels: 1 | 4,
  reuse?: TiledLayerSnapshot | null,
): TiledLayerSnapshot {
  const float = src instanceof Float32Array;
  const tilesX = snapTileCount(width);
  const tilesY = snapTileCount(height);
  const base = snapshotMatches(reuse, width, height, channels, float)
    ? reuse
    : null;
  const src32 = base ? u32View(src) : null;
  const tiles: (Uint8Array | Float32Array)[] = [];
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const old = base?.tiles[ty * tilesX + tx];
      tiles.push(
        old && tileEquals(src, src32, width, height, channels, tx, ty, old)
          ? old
          : copyTile(src, width, height, channels, tx, ty),
      );
    }
  }
  return { width, height, channels, float, tilesX, tilesY, tiles };
}

/**
 * New snapshot that shares `prev`'s tiles except those flagged in
 * `dirtyTiles` (row-major, `prev.tilesX × prev.tilesY`), which are copied
 * from `src`. The caller guarantees that `src` equals `prev` in every
 * unflagged tile, with the same geometry and format.
 */
export function snapshotIncremental(
  prev: TiledLayerSnapshot,
  src: Uint8Array | Float32Array,
  dirtyTiles: Uint8Array,
): TiledLayerSnapshot {
  const { width, height, channels, tilesX } = prev;
  const tiles = prev.tiles.slice();
  for (let i = 0; i < tiles.length; i++) {
    if (!dirtyTiles[i]) continue;
    const tx = i % tilesX;
    tiles[i] = copyTile(src, width, height, channels, tx, (i - tx) / tilesX);
  }
  return { ...prev, tiles };
}

/**
 * Snapshot a live layer for a history entry from what its history tracking
 * reports (`change`, taken from the layer's texture store). `fallback` (the
 * previous entry's snapshot of the layer) is only used for content de-dup
 * when the tracking can't vouch for a base.
 */
export function snapshotLayer(
  src: Uint8Array | Float32Array,
  width: number,
  height: number,
  channels: 1 | 4,
  change: LayerHistoryChange,
  fallback?: TiledLayerSnapshot | null,
): TiledLayerSnapshot {
  const float = src instanceof Float32Array;
  if (
    change.kind !== "all" &&
    snapshotMatches(change.base, width, height, channels, float)
  ) {
    if (change.kind === "none") return change.base;
    return snapshotIncremental(change.base, src, change.tiles);
  }
  const reuse = change.kind !== "all" ? change.base : fallback;
  return snapshotFull(src, width, height, channels, reuse);
}

/**
 * Write tiles of `snap` into `dst` (same geometry, `width × height ×
 * channels`). `only(i)` selects tiles (all when omitted). Returns the bounding
 * rect of what was written, or null when nothing was.
 */
export function writeSnapshotTiles(
  snap: TiledLayerSnapshot,
  dst: Uint8Array | Float32Array,
  only?: (tileIndex: number) => boolean,
): SnapshotRect | null {
  const { width, height, channels, tilesX } = snap;
  let rect: SnapshotRect | null = null;
  for (let i = 0; i < snap.tiles.length; i++) {
    if (only && !only(i)) continue;
    const tx = i % tilesX;
    const ty = (i - tx) / tilesX;
    const x0 = tx * SNAP_TILE;
    const y0 = ty * SNAP_TILE;
    const tw = Math.min(SNAP_TILE, width - x0);
    const th = Math.min(SNAP_TILE, height - y0);
    const rowLen = tw * channels;
    const tile = snap.tiles[i];
    for (let y = 0; y < th; y++) {
      (dst as Uint8Array).set(
        (tile as Uint8Array).subarray(y * rowLen, (y + 1) * rowLen),
        ((y0 + y) * width + x0) * channels,
      );
    }
    if (!rect) rect = { lx: x0, ly: y0, rx: x0 + tw, ry: y0 + th };
    else {
      if (x0 < rect.lx) rect.lx = x0;
      if (y0 < rect.ly) rect.ly = y0;
      if (x0 + tw > rect.rx) rect.rx = x0 + tw;
      if (y0 + th > rect.ry) rect.ry = y0 + th;
    }
  }
  return rect;
}

/** Assemble the full layer buffer from a snapshot (fresh allocation). */
export function materializeSnapshot(
  snap: TiledLayerSnapshot,
): Uint8Array | Float32Array {
  const { width, height, channels } = snap;
  const out = snap.float
    ? new Float32Array(width * height * channels)
    : new Uint8Array(width * height * channels);
  writeSnapshotTiles(snap, out);
  return out;
}
