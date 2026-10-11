import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";

/** Tile edge in pixels (power of two: indexing uses shifts). */
const TILE_SHIFT = 7;
const TILE = 1 << TILE_SHIFT;

/**
 * A stroke-start view of a layer's pixels that copies only what the stroke
 * overwrites (copy-on-write), for tools that sample the layer they paint
 * (Clone Stamp / Healing Brush within one layer).
 *
 * Before a write lands, the caller passes its canvas-space write box to
 * {@link protect}; every tile it overlaps that wasn't copied yet is copied from
 * the live layer, so it still holds the stroke-start pixels. A tile the stroke
 * never wrote is still identical in the live layer, so sampling reads it there.
 * This replaces a full `layer.data.slice()` per stroke (1 GiB for an 8000²
 * rgba32f layer) with a few tiles around the stroke.
 *
 * Geometry is the layer's at construction: a mid-stroke `growLayerToFit`
 * keeps the old content at a shifted position, which {@link refresh}
 * re-resolves (it also re-binds `layer.data` after a WASM heap growth).
 * Pixels outside the stroke-start bounds sample as missing, as with a copy.
 *
 * With `copyOnWrite = false` it is a plain live view (a source layer the
 * stroke doesn't modify).
 *
 * Supports the 4-channel formats (rgba8 / rgba32f); sampling returns RGBA.
 */
export class CowLayerSnapshot {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
  readonly isFloat: boolean;
  private readonly layer: GpuLayer;
  private readonly copyOnWrite: boolean;
  private readonly tilesX: number;
  private readonly tiles: Array<Uint8Array | Float32Array | null>;
  private data: Uint8Array | Float32Array;
  /** Stroke-start-local → live-local offset (non-zero after a grow). */
  private dx = 0;
  private dy = 0;
  private liveW = 0;

  constructor(layer: GpuLayer, copyOnWrite: boolean) {
    this.layer = layer;
    this.copyOnWrite = copyOnWrite;
    this.offsetX = layer.offsetX;
    this.offsetY = layer.offsetY;
    this.width = layer.layerWidth;
    this.height = layer.layerHeight;
    this.isFloat = layer.data instanceof Float32Array;
    this.tilesX = Math.ceil(this.width / TILE);
    const tilesY = Math.ceil(this.height / TILE);
    this.tiles = copyOnWrite
      ? new Array<Uint8Array | Float32Array | null>(this.tilesX * tilesY).fill(
          null,
        )
      : [];
    this.data = layer.data;
    this.refresh();
  }

  /** Re-bind the live buffer and geometry (after a grow / heap growth). */
  refresh(): void {
    const l = this.layer;
    this.data = l.data;
    this.dx = this.offsetX - l.offsetX;
    this.dy = this.offsetY - l.offsetY;
    this.liveW = l.layerWidth;
  }

  /**
   * Preserve the stroke-start pixels of the canvas-space box
   * [x0, x1] × [y0, y1] (inclusive). Call before writing into it.
   */
  protect(x0: number, y0: number, x1: number, y1: number): void {
    if (!this.copyOnWrite) return;
    const lx0 = Math.max(0, Math.floor(x0) - this.offsetX);
    const ly0 = Math.max(0, Math.floor(y0) - this.offsetY);
    const lx1 = Math.min(this.width - 1, Math.ceil(x1) - this.offsetX);
    const ly1 = Math.min(this.height - 1, Math.ceil(y1) - this.offsetY);
    if (lx0 > lx1 || ly0 > ly1) return;
    this.refresh();
    const tx0 = lx0 >> TILE_SHIFT;
    const tx1 = lx1 >> TILE_SHIFT;
    const ty0 = ly0 >> TILE_SHIFT;
    const ty1 = ly1 >> TILE_SHIFT;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const ti = ty * this.tilesX + tx;
        if (!this.tiles[ti]) this.tiles[ti] = this.copyTile(tx, ty);
      }
    }
  }

  /**
   * {@link protect} for a write that wraps modulo the canvas (tiled mode):
   * the box is split into its wrapped pieces in [0, tiledW) × [0, tiledH).
   */
  protectWrapped(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    tiledW: number,
    tiledH: number,
  ): void {
    if (!this.copyOnWrite) return;
    const xs = wrapIntervals(Math.floor(x0), Math.ceil(x1), tiledW);
    const ys = wrapIntervals(Math.floor(y0), Math.ceil(y1), tiledH);
    for (let j = 0; j < ys.length; j += 2) {
      for (let i = 0; i < xs.length; i += 2) {
        this.protect(xs[i], ys[j], xs[i + 1], ys[j + 1]);
      }
    }
  }

  /**
   * Read the stroke-start RGBA at stroke-start-local (lx, ly) into `out`.
   * Returns false when outside the stroke-start bounds.
   */
  sampleLocal(lx: number, ly: number, out: Float64Array): boolean {
    const w = this.width;
    if (lx < 0 || ly < 0 || lx >= w || ly >= this.height) return false;
    if (this.copyOnWrite) {
      const tx = lx >> TILE_SHIFT;
      const ty = ly >> TILE_SHIFT;
      const tile = this.tiles[ty * this.tilesX + tx];
      if (tile) {
        const bx = tx << TILE_SHIFT;
        const tw = Math.min(TILE, w - bx);
        const i = (((ly - (ty << TILE_SHIFT)) * tw) + (lx - bx)) * 4;
        out[0] = tile[i];
        out[1] = tile[i + 1];
        out[2] = tile[i + 2];
        out[3] = tile[i + 3];
        return true;
      }
    }
    const d = this.data;
    const i = ((ly + this.dy) * this.liveW + (lx + this.dx)) * 4;
    out[0] = d[i];
    out[1] = d[i + 1];
    out[2] = d[i + 2];
    out[3] = d[i + 3];
    return true;
  }

  private copyTile(tx: number, ty: number): Uint8Array | Float32Array {
    const bx = tx << TILE_SHIFT;
    const by = ty << TILE_SHIFT;
    const tw = Math.min(TILE, this.width - bx);
    const th = Math.min(TILE, this.height - by);
    const rowLen = tw * 4;
    const src = this.data;
    const out =
      src instanceof Float32Array
        ? new Float32Array(rowLen * th)
        : new Uint8Array(rowLen * th);
    const liveX = bx + this.dx;
    for (let r = 0; r < th; r++) {
      const start = ((by + r + this.dy) * this.liveW + liveX) * 4;
      (out as Uint8Array).set(
        src.subarray(start, start + rowLen) as ArrayLike<number>,
        r * rowLen,
      );
    }
    return out;
  }
}

/** Split the inclusive integer interval [a, b] into its pieces modulo `n`,
 *  as a flat [start, end, start, end…] list. */
function wrapIntervals(a: number, b: number, n: number): number[] {
  if (b - a + 1 >= n) return [0, n - 1];
  const s = ((a % n) + n) % n;
  const e = s + (b - a);
  return e < n ? [s, e] : [s, n - 1, 0, e - n];
}
