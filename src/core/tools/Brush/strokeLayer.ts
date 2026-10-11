/**
 * The paint brush's per-stroke paint layer.
 *
 * Ordinary strokes write each dab straight into the layer: with one colour
 * and Normal mode that is exactly "stroke-start pixels, then the stroke
 * painted over them". Two things need more:
 *
 *  - Brush blend modes. Multiplying each dab into the already-multiplied
 *    pixels compounds within one stroke; the stroke must be blended once
 *    against what was there before it.
 *  - Colour that varies per dab (colour dynamics). The per-stroke coverage
 *    cap stops a dab from painting where earlier dabs already reached the
 *    ceiling, so newer colours never showed over older ones.
 *
 * So such strokes keep the layer's pixels at stroke start (canvas tiles of
 * 64×64, copied just before a stamp first covers them) and, for varying
 * colour, a per-pixel stroke colour. Every touched pixel is recomposited as
 * `blend(start pixel, stroke colour, stroke alpha)`; the stroke alpha is
 * the existing coverage buffer, and each dab goes "over" the stroke colour
 * so later dabs sit on top.
 *
 * Tiles live in the WASM heap (the kernel reads them through a pointer
 * table registered with `setBrushStrokeLayer`), or in JS memory when the
 * WASM module wasn't loaded at stroke start (then the stroke paints on the
 * JS path). The per-pixel logic below mirrors `stroke_pixel` /
 * `composite_stroke` in wasm/src/brush_stamp.cpp.
 */
import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { setBrushStrokeLayer } from "@/wasm";
import type { PixelOpsModule } from "@/wasm/types";
import {
  ditherBias,
  noteTouchedWrite,
  type SelMask,
  type TouchedBuffer,
} from "../_shared/primitives";
import { compositeStroke } from "./brushBlend";

const TILE_SHIFT = 6;
const TILE = 1 << TILE_SHIFT;
const TILE_PX = TILE * TILE;

/** Smallest 8-bit level ≥ x (with a little float slack). */
function ceilByte(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 255;
  return Math.min(255, Math.max(0, Math.ceil(x * 255 - 0.001)));
}

interface TileViews {
  orig: Uint8Array | Float32Array;
  color: Float32Array | null;
}

export class StrokeLayer {
  readonly tilesX: number;
  readonly tilesY: number;
  /** Keeps a per-pixel stroke colour (colour varies per dab). */
  readonly recolor: boolean;
  readonly isFloat: boolean;
  /** The module the tiles live in; null = JS memory (JS paint path). */
  readonly wasm: PixelOpsModule | null;
  private readonly canvasW: number;
  private readonly canvasH: number;
  private readonly tileBytes: number;
  /** WASM: heap pointer per tile (0 = none). */
  private readonly ptrs: number[];
  /** JS: tile buffers. */
  private readonly jsTiles: (ArrayBuffer | null)[];
  private tablePtr = 0;
  private views: (TileViews | null)[];
  private viewBuffer: ArrayBufferLike | null = null;

  constructor(
    canvasW: number,
    canvasH: number,
    isFloat: boolean,
    recolor: boolean,
    wasm: PixelOpsModule | null,
  ) {
    this.canvasW = canvasW;
    this.canvasH = canvasH;
    this.isFloat = isFloat;
    this.recolor = recolor;
    this.tilesX = Math.ceil(canvasW / TILE);
    this.tilesY = Math.ceil(canvasH / TILE);
    const n = this.tilesX * this.tilesY;
    this.tileBytes = TILE_PX * (isFloat ? 16 : 4) + (recolor ? TILE_PX * 12 : 0);
    this.ptrs = new Array<number>(n).fill(0);
    this.jsTiles = new Array<ArrayBuffer | null>(n).fill(null);
    this.views = new Array<TileViews | null>(n).fill(null);
    this.wasm = wasm;
    if (wasm) {
      try {
        this.tablePtr = wasm._malloc(n * 8);
        wasm.HEAPU8.fill(0, this.tablePtr, this.tablePtr + n * 8);
        setBrushStrokeLayer(wasm, this.tablePtr, this.tilesX, this.tilesY);
      } catch {
        // Out of heap: paint on the JS path instead.
        this.tablePtr = 0;
        this.wasm = null;
      }
    }
  }

  /**
   * Allocate (and snapshot from `layer`) every tile the canvas rect
   * [x0, x1] × [y0, y1] covers — before a stamp there paints. Tiled mode
   * wraps the rect around the canvas.
   */
  ensure(layer: GpuLayer, x0: number, y0: number, x1: number, y1: number, tiled: boolean): void {
    const cols = this.tileRange(x0, x1, this.canvasW, this.tilesX, tiled);
    const rows = this.tileRange(y0, y1, this.canvasH, this.tilesY, tiled);
    for (const ty of rows) {
      for (const tx of cols) {
        const t = ty * this.tilesX + tx;
        if (this.wasm ? this.ptrs[t] !== 0 : this.jsTiles[t] !== null) continue;
        this.allocTile(t);
        this.snapshot(layer, t, tx, ty);
      }
    }
  }

  /** Tile indices covering [a, b] along one axis. */
  private tileRange(a: number, b: number, size: number, tiles: number, tiled: boolean): number[] {
    const out: number[] = [];
    if (!tiled) {
      const t0 = Math.max(0, Math.floor(a) >> TILE_SHIFT);
      const t1 = Math.min(tiles - 1, Math.floor(b) >> TILE_SHIFT);
      for (let t = t0; t <= t1; t++) out.push(t);
      return out;
    }
    if (b - a + 1 >= size) {
      for (let t = 0; t < tiles; t++) out.push(t);
      return out;
    }
    const seen = new Set<number>();
    for (let v = Math.floor(a); ; v = Math.min(v + TILE, Math.floor(b))) {
      const w = ((v % size) + size) % size;
      seen.add(w >> TILE_SHIFT);
      if (v >= Math.floor(b)) break;
    }
    // A wrapped span can straddle a tile boundary between samples.
    const wa = ((Math.floor(a) % size) + size) % size;
    const wb = ((Math.floor(b) % size) + size) % size;
    seen.add(wa >> TILE_SHIFT);
    seen.add(wb >> TILE_SHIFT);
    return [...seen];
  }

  private allocTile(t: number): void {
    if (this.wasm) {
      const ptr = this.wasm._malloc(this.tileBytes);
      this.ptrs[t] = ptr;
      new DataView(this.wasm.HEAPU8.buffer).setBigUint64(this.tablePtr + t * 8, BigInt(ptr), true);
    } else {
      this.jsTiles[t] = new ArrayBuffer(this.tileBytes);
    }
    this.views[t] = null;
  }

  /** Copy the layer's current pixels for tile (tx, ty) into its snapshot. */
  private snapshot(layer: GpuLayer, t: number, tx: number, ty: number): void {
    const v = this.tileViews(t)!;
    const orig = v.orig;
    orig.fill(0);
    const src = layer.data;
    const cx0 = tx << TILE_SHIFT;
    const cy0 = ty << TILE_SHIFT;
    for (let j = 0; j < TILE; j++) {
      const ly = cy0 + j - layer.offsetY;
      if (ly < 0 || ly >= layer.layerHeight) continue;
      const lx0 = Math.max(0, cx0 - layer.offsetX);
      const lx1 = Math.min(layer.layerWidth, cx0 + TILE - layer.offsetX);
      if (lx1 <= lx0) continue;
      const s = (ly * layer.layerWidth + lx0) * 4;
      const d = (j * TILE + (lx0 + layer.offsetX - cx0)) * 4;
      orig.set(src.subarray(s, s + (lx1 - lx0) * 4), d);
    }
  }

  /** Views of tile `t` (null if not allocated); re-bound after heap growth. */
  tileViews(t: number): TileViews | null {
    if (this.wasm) {
      const buf = this.wasm.HEAPU8.buffer;
      if (buf !== this.viewBuffer) {
        this.views.fill(null);
        this.viewBuffer = buf;
      }
      const ptr = this.ptrs[t];
      if (ptr === 0) return null;
      let v = this.views[t];
      if (!v) {
        v = this.makeViews(buf, ptr);
        this.views[t] = v;
      }
      return v;
    }
    const b = this.jsTiles[t];
    if (!b) return null;
    let v = this.views[t];
    if (!v) {
      v = this.makeViews(b, 0);
      this.views[t] = v;
    }
    return v;
  }

  private makeViews(buf: ArrayBufferLike, off: number): TileViews {
    const origBytes = TILE_PX * (this.isFloat ? 16 : 4);
    return {
      orig: this.isFloat
        ? new Float32Array(buf, off, TILE_PX * 4)
        : new Uint8Array(buf, off, TILE_PX * 4),
      color: this.recolor ? new Float32Array(buf, off + origBytes, TILE_PX * 3) : null,
    };
  }

  /** Drop every snapshot: the layer as it is now becomes the stroke start
   *  (airbrush build-up starts each tick's dose from the current pixels). */
  commit(): void {
    for (let t = 0; t < this.ptrs.length; t++) this.freeTile(t);
  }

  private freeTile(t: number): void {
    if (this.wasm) {
      if (this.ptrs[t] !== 0) {
        this.wasm._free(this.ptrs[t]);
        this.ptrs[t] = 0;
        new DataView(this.wasm.HEAPU8.buffer).setBigUint64(this.tablePtr + t * 8, 0n, true);
      }
    } else {
      this.jsTiles[t] = null;
    }
    this.views[t] = null;
  }

  /** Free everything and unregister from the kernel. */
  dispose(): void {
    this.commit();
    if (this.wasm && this.tablePtr !== 0) {
      setBrushStrokeLayer(this.wasm, 0, 0, 0);
      this.wasm._free(this.tablePtr);
      this.tablePtr = 0;
    }
  }
}

/** Per-stamp inputs of `strokePixel` (one scratch object, set per stamp). */
export interface StrokeStamp {
  layer: StrokeLayer;
  blendMode: number;
  /** Colour alpha × deposit opacity, 0..1 (alpha at coverage 1). */
  srcAlphaScale: number;
  /** Colour alpha × Opacity ceiling, 0..1; < 0 = full flow (no cap). */
  capAlphaScale: number;
  /** Dab colour in the layer's value space. */
  color: [number, number, number];
  ditherSeed: number;
}

const startPx = [0, 0, 0];
const paint = [0, 0, 0];
const outPx = [0, 0, 0, 0];

/**
 * JS-path stroke-layer paint of canvas pixel (px, py) with tip `coverage`
 * (before selection). Mirrors `stroke_pixel` in brush_stamp.cpp.
 */
export function strokePixel(
  st: StrokeStamp,
  layer: GpuLayer,
  touched: TouchedBuffer,
  sel: SelMask | undefined,
  canvasW: number,
  canvasH: number,
  px: number,
  py: number,
  coverage: number,
  tiled: boolean,
): void {
  if (tiled) {
    px = ((px % canvasW) + canvasW) % canvasW;
    py = ((py % canvasH) + canvasH) % canvasH;
  }
  if (px < 0 || py < 0 || px >= canvasW || py >= canvasH) return;
  let selF = 1;
  if (sel) {
    const v = sel.mask[py * sel.width + px];
    if (v === 0) return;
    if (v !== 255) {
      selF = v / 255;
      coverage *= selF;
    }
  }
  const lx = px - layer.offsetX;
  const ly = py - layer.offsetY;
  if (lx < 0 || ly < 0 || lx >= layer.layerWidth || ly >= layer.layerHeight) return;
  const sl = st.layer;
  const views = sl.tileViews((py >> TILE_SHIFT) * sl.tilesX + (px >> TILE_SHIFT));
  if (!views) return;
  const ti = ((py & (TILE - 1)) << TILE_SHIFT) | (px & (TILE - 1));

  const key = py * touched.width + px;
  const oldByte = touched.data[key];
  const aOld = oldByte / 255;
  const srcA = st.srcAlphaScale * coverage;
  if (srcA <= 0) return;
  const bias = ditherBias(px, py, st.ditherSeed);
  let newByte = oldByte;
  if (st.capAlphaScale >= 0) {
    const capA = st.capAlphaScale * selF;
    if (aOld < capA) {
      const upgrade = aOld < 1 ? (capA - aOld) / (1 - aOld) : 0;
      const b = srcA < upgrade ? srcA : upgrade;
      if (b > 0) {
        newByte =
          srcA >= upgrade
            ? ceilByte(capA)
            : Math.min(255, ((aOld + b * (1 - aOld)) * 255 + bias) | 0);
      }
    }
  } else if (srcA > aOld) {
    newByte = ceilByte(srcA);
  }
  if (newByte < oldByte) newByte = oldByte;
  if (newByte === oldByte && !sl.recolor) return;
  touched.data[key] = newByte;
  noteTouchedWrite(touched, px, py);

  paint[0] = st.color[0];
  paint[1] = st.color[1];
  paint[2] = st.color[2];
  const col = views.color;
  if (col) {
    const c = ti * 3;
    if (aOld > 0) {
      const keep = aOld * (1 - srcA);
      const den = srcA + keep;
      if (den > 1e-7) {
        paint[0] = (st.color[0] * srcA + col[c] * keep) / den;
        paint[1] = (st.color[1] * srcA + col[c + 1] * keep) / den;
        paint[2] = (st.color[2] * srcA + col[c + 2] * keep) / den;
      }
    }
    col[c] = paint[0];
    col[c + 1] = paint[1];
    col[c + 2] = paint[2];
  }

  const o = views.orig;
  const oi = ti * 4;
  const scale = sl.isFloat ? 1 : 1 / 255;
  startPx[0] = o[oi] * scale;
  startPx[1] = o[oi + 1] * scale;
  startPx[2] = o[oi + 2] * scale;
  compositeStroke(st.blendMode, startPx, o[oi + 3] * scale, paint, newByte / 255, outPx);

  const d = layer.data;
  const i = (ly * layer.layerWidth + lx) * 4;
  if (sl.isFloat) {
    d[i] = outPx[0];
    d[i + 1] = outPx[1];
    d[i + 2] = outPx[2];
    d[i + 3] = outPx[3];
  } else {
    const q = (v: number): number => Math.max(0, Math.min(255, (v * 255 + bias) | 0));
    d[i] = q(outPx[0]);
    d[i + 1] = q(outPx[1]);
    d[i + 2] = q(outPx[2]);
    d[i + 3] = q(outPx[3]);
  }
}
