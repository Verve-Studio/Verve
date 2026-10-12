import { describe, expect, it } from "vitest";
import {
  SNAP_TILE,
  materializeSnapshot,
  snapTileCount,
  snapshotFull,
  snapshotIncremental,
  snapshotLayer,
  snapshotMatches,
  writeSnapshotTiles,
} from "@/core/store/tiledSnapshot";

type Buf = Uint8Array | Float32Array;

/** Deterministic, position-dependent fill so every tile is distinct. */
function makeBuffer(
  kind: "u8" | "f32",
  width: number,
  height: number,
  channels: 1 | 4,
  seed = 1,
): Buf {
  const n = width * height * channels;
  if (kind === "f32") {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = ((i * 7 + seed) % 1013) / 97 - 3; // HDR + negatives
    return out;
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed * 17) & 0xff;
  return out;
}

const FORMATS = [
  { name: "rgba8", kind: "u8" as const, channels: 4 as const },
  { name: "rgba32f", kind: "f32" as const, channels: 4 as const },
  { name: "indexed8", kind: "u8" as const, channels: 1 as const },
];

/** Sizes covering exact multiples, one-past, sub-tile and odd widths. */
const SIZES: [number, number][] = [
  [1, 1],
  [3, 5],
  [SNAP_TILE, SNAP_TILE],
  [SNAP_TILE + 1, 3],
  [2 * SNAP_TILE + 37, SNAP_TILE + 1],
  [257, 300],
];

/** Bitwise equality of two pixel buffers (fast; toEqual is slow on MB arrays). */
function sameBytes(a: Buf, b: Buf): boolean {
  if (a.constructor !== b.constructor || a.length !== b.length) return false;
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  );
}

/** Index of the tile containing pixel (x, y). */
function tileIndexOf(x: number, y: number, width: number): number {
  return Math.floor(y / SNAP_TILE) * snapTileCount(width) + Math.floor(x / SNAP_TILE);
}

describe("snapTileCount", () => {
  it("is ceil(size / 256) with a minimum of one tile", () => {
    expect(snapTileCount(0)).toBe(1);
    expect(snapTileCount(1)).toBe(1);
    expect(snapTileCount(SNAP_TILE)).toBe(1);
    expect(snapTileCount(SNAP_TILE + 1)).toBe(2);
    expect(snapTileCount(10 * SNAP_TILE)).toBe(10);
  });
});

describe("snapshotFull / materializeSnapshot round trip", () => {
  for (const f of FORMATS) {
    for (const [w, h] of SIZES) {
      it(`${f.name} ${w}×${h} materializes to the source bytes`, () => {
        const src = makeBuffer(f.kind, w, h, f.channels);
        const snap = snapshotFull(src, w, h, f.channels);
        expect(snap.width).toBe(w);
        expect(snap.height).toBe(h);
        expect(snap.channels).toBe(f.channels);
        expect(snap.float).toBe(f.kind === "f32");
        expect(snap.tilesX).toBe(snapTileCount(w));
        expect(snap.tilesY).toBe(snapTileCount(h));
        expect(snap.tiles.length).toBe(snap.tilesX * snap.tilesY);
        const out = materializeSnapshot(snap);
        expect(sameBytes(out, src)).toBe(true);
      });
    }
  }

  it("edge tiles are cropped to the layer size", () => {
    const w = SNAP_TILE + 10;
    const h = SNAP_TILE + 3;
    const snap = snapshotFull(makeBuffer("u8", w, h, 4), w, h, 4);
    expect(snap.tiles[0].length).toBe(SNAP_TILE * SNAP_TILE * 4);
    expect(snap.tiles[1].length).toBe(10 * SNAP_TILE * 4);
    expect(snap.tiles[2].length).toBe(SNAP_TILE * 3 * 4);
    expect(snap.tiles[3].length).toBe(10 * 3 * 4);
  });

  it("is immutable with respect to later edits of the source", () => {
    const src = makeBuffer("u8", 20, 20, 4);
    const before = src.slice();
    const snap = snapshotFull(src, 20, 20, 4);
    src.fill(0);
    expect(sameBytes(materializeSnapshot(snap), before)).toBe(true);
  });

  it("preserves float bit patterns (HDR values, -0, NaN)", () => {
    const src = new Float32Array([1e6, -0, Number.NaN, 0.1, 42, -1, 3.5, 0]);
    const snap = snapshotFull(src, 2, 1, 4);
    const out = materializeSnapshot(snap) as Float32Array;
    expect(new Uint32Array(out.buffer)).toEqual(new Uint32Array(src.buffer));
  });
});

describe("snapshotFull with reuse (content de-dup)", () => {
  for (const f of FORMATS) {
    it(`${f.name}: shares unchanged tiles, copies changed ones`, () => {
      const w = 2 * SNAP_TILE + 8;
      const h = SNAP_TILE + 2;
      const src = makeBuffer(f.kind, w, h, f.channels);
      const first = snapshotFull(src, w, h, f.channels);

      // Change one pixel in the tile at (1, 1).
      const px = SNAP_TILE + 3;
      const py = SNAP_TILE + 1;
      const i = (py * w + px) * f.channels;
      src[i] = src[i] + 1;
      const second = snapshotFull(src, w, h, f.channels, first);

      const changed = tileIndexOf(px, py, w);
      const shared = second.tiles.map((tile, t) => tile === first.tiles[t]);
      expect(shared).toEqual(second.tiles.map((_, t) => t !== changed));
      expect(sameBytes(materializeSnapshot(second), src)).toBe(true);
      // The earlier snapshot is untouched.
      src[i] = src[i] - 1;
      expect(sameBytes(materializeSnapshot(first), src)).toBe(true);
    });
  }

  it("ignores a reuse snapshot with a different geometry or format", () => {
    const a = makeBuffer("u8", 10, 10, 4);
    const prev = snapshotFull(a, 10, 10, 4);
    // Same bytes reinterpreted as 20×5: no sharing allowed.
    const other = snapshotFull(a, 20, 5, 4, prev);
    expect(other.tiles[0]).not.toBe(prev.tiles[0]);
    expect(sameBytes(materializeSnapshot(other), a)).toBe(true);
    // Float vs byte with matching geometry: no sharing.
    const f = new Float32Array(10 * 10 * 4);
    const fsnap = snapshotFull(f, 10, 10, 4, prev);
    expect(fsnap.float).toBe(true);
    expect(fsnap.tiles[0]).not.toBe(prev.tiles[0]);
  });

  it("works on an unaligned subarray source (byte-compare fallback)", () => {
    const backing = new Uint8Array(1 + 7 * 3);
    const src = backing.subarray(1); // byteOffset 1 → no u32 view
    for (let i = 0; i < src.length; i++) src[i] = i * 3;
    const prev = snapshotFull(src, 7, 3, 1);
    const again = snapshotFull(src, 7, 3, 1, prev);
    expect(again.tiles[0]).toBe(prev.tiles[0]);
    src[5] ^= 0xff;
    const changed = snapshotFull(src, 7, 3, 1, prev);
    expect(changed.tiles[0]).not.toBe(prev.tiles[0]);
    expect(sameBytes(materializeSnapshot(changed), src.slice())).toBe(true);
  });
});

describe("snapshotIncremental", () => {
  for (const f of FORMATS) {
    it(`${f.name}: copies only flagged tiles that actually changed`, () => {
      const w = 3 * SNAP_TILE - 4;
      const h = 2 * SNAP_TILE + 1;
      const src = makeBuffer(f.kind, w, h, f.channels);
      const base = snapshotFull(src, w, h, f.channels);
      const tilesX = base.tilesX;

      // Edit tile (2, 0) and flag it; also flag tile (0, 1) without editing.
      const ex = 2 * SNAP_TILE + 1;
      const ei = ex * f.channels; // row 0
      src[ei] = src[ei] + 2;
      const dirty = new Uint8Array(base.tiles.length);
      dirty[2] = 1;
      dirty[tilesX] = 1;

      const next = snapshotIncremental(base, src, dirty);
      // Only tile 2 is new; tile (0, 1) was flagged but is bitwise equal.
      const shared = next.tiles.map((tile, t) => tile === base.tiles[t]);
      expect(shared).toEqual(next.tiles.map((_, t) => t !== 2));
      expect(sameBytes(materializeSnapshot(next), src)).toBe(true);
      expect(next.width).toBe(base.width);
      expect(next.tiles !== base.tiles).toBe(true); // not.toBe deep-compares every tile
    });
  }
});

describe("snapshotLayer", () => {
  const w = SNAP_TILE + 9;
  const h = 7;

  it("kind 'none' returns the base snapshot itself", () => {
    const src = makeBuffer("u8", w, h, 4);
    const base = snapshotFull(src, w, h, 4);
    expect(snapshotLayer(src, w, h, 4, { kind: "none", base })).toBe(base);
  });

  it("kind 'tiles' re-snapshots only the flagged tiles", () => {
    const src = makeBuffer("u8", w, h, 4);
    const base = snapshotFull(src, w, h, 4);
    src[(SNAP_TILE + 1) * 4] ^= 0xff;
    const tiles = new Uint8Array([0, 1]);
    const snap = snapshotLayer(src, w, h, 4, { kind: "tiles", base, tiles });
    expect(snap.tiles[0]).toBe(base.tiles[0]);
    expect(snap.tiles[1]).not.toBe(base.tiles[1]);
    expect(sameBytes(materializeSnapshot(snap), src)).toBe(true);
  });

  it("kind 'all' snapshots everything, de-duplicating against the fallback", () => {
    const src = makeBuffer("f32", w, h, 4);
    const fallback = snapshotFull(src, w, h, 4);
    const snap = snapshotLayer(src, w, h, 4, { kind: "all" }, fallback);
    expect(snap.tiles[0]).toBe(fallback.tiles[0]);
    expect(snap.tiles[1]).toBe(fallback.tiles[1]);
    const noFallback = snapshotLayer(src, w, h, 4, { kind: "all" });
    expect(noFallback.tiles[0]).not.toBe(fallback.tiles[0]);
    expect(sameBytes(materializeSnapshot(noFallback), src)).toBe(true);
  });

  it("a base with stale geometry falls back to a full capture", () => {
    const src = makeBuffer("u8", w, h, 4);
    const staleBase = snapshotFull(makeBuffer("u8", 4, 4, 4), 4, 4, 4);
    const snap = snapshotLayer(src, w, h, 4, { kind: "none", base: staleBase });
    expect(snap).not.toBe(staleBase);
    expect(snap.width).toBe(w);
    expect(sameBytes(materializeSnapshot(snap), src)).toBe(true);
  });

  it("a base of the wrong format (byte vs float) is not trusted", () => {
    const src = makeBuffer("f32", 4, 4, 4);
    const byteBase = snapshotFull(new Uint8Array(4 * 4 * 4), 4, 4, 4);
    const snap = snapshotLayer(src, 4, 4, 4, { kind: "none", base: byteBase });
    expect(snap.float).toBe(true);
    expect(sameBytes(materializeSnapshot(snap), src)).toBe(true);
  });
});

describe("writeSnapshotTiles", () => {
  it("writes only the selected tiles and returns their bounding rect", () => {
    const w = 2 * SNAP_TILE + 3;
    const h = SNAP_TILE + 4;
    const src = makeBuffer("u8", w, h, 4);
    const snap = snapshotFull(src, w, h, 4);
    const dst = new Uint8Array(src.length);
    const rect = writeSnapshotTiles(snap, dst, (i) => i === 2 || i === 4);
    // tile 2 = (2,0): x 512..515, y 0..256 ; tile 4 = (1,1): x 256..512, y 256..260
    expect(rect).toEqual({ lx: SNAP_TILE, ly: 0, rx: w, ry: h });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = tileIndexOf(x, y, w);
        const i = (y * w + x) * 4;
        const expected = t === 2 || t === 4 ? src[i] : 0;
        if (dst[i] !== expected) throw new Error(`mismatch at ${x},${y}`);
      }
    }
  });

  it("returns null when no tile is selected", () => {
    const snap = snapshotFull(new Uint8Array(16), 2, 2, 4);
    const dst = new Uint8Array(16).fill(9);
    expect(writeSnapshotTiles(snap, dst, () => false)).toBeNull();
    expect(dst.every((v) => v === 9)).toBe(true);
  });

  it("restores a float layer exactly", () => {
    const src = makeBuffer("f32", 300, 3, 4);
    const snap = snapshotFull(src, 300, 3, 4);
    const dst = new Float32Array(src.length);
    expect(writeSnapshotTiles(snap, dst)).toEqual({ lx: 0, ly: 0, rx: 300, ry: 3 });
    expect(sameBytes(dst, src)).toBe(true);
  });
});

describe("snapshotMatches", () => {
  it("checks geometry, channels and float-ness", () => {
    const snap = snapshotFull(new Uint8Array(3 * 2), 3, 2, 1);
    expect(snapshotMatches(snap, 3, 2, 1, false)).toBe(true);
    expect(snapshotMatches(snap, 2, 3, 1, false)).toBe(false);
    expect(snapshotMatches(snap, 3, 2, 4, false)).toBe(false);
    expect(snapshotMatches(snap, 3, 2, 1, true)).toBe(false);
    expect(snapshotMatches(null, 3, 2, 1, false)).toBe(false);
    expect(snapshotMatches(undefined, 3, 2, 1, false)).toBe(false);
  });
});

// Indexed8 layers wider than one tile whose width is not a multiple of 4:
// the first tile's rows are 256 bytes (a multiple of 4), so `tileEquals`
// takes the word-compare path, but the source row stride (`width` bytes) is
// not 4-aligned. `sw = (s * bpe) >>> 2` then truncates and the comparison
// reads the source shifted by (y * width) % 4 bytes.
describe("odd-width indexed8 tile comparison", () => {
  it("snapshotIncremental keeps an edit in a 257-wide indexed8 layer", () => {
    const w = 257;
    const h = 2;
    const src = new Uint8Array(w * h);
    const base = snapshotFull(src, w, h, 1);
    src[w + 255] = 1; // row 1, x 255 → tile 0
    const next = snapshotIncremental(base, src, new Uint8Array([1, 1]));
    expect(materializeSnapshot(next)[w + 255]).toBe(1);
  });

  it("snapshotFull(reuse) keeps an edit in a 257-wide indexed8 layer", () => {
    const w = 257;
    const h = 2;
    const src = new Uint8Array(w * h);
    const prev = snapshotFull(src, w, h, 1);
    src[w + 255] = 1;
    const next = snapshotFull(src, w, h, 1, prev);
    expect(materializeSnapshot(next)[w + 255]).toBe(1);
  });

  it("round-trips odd-width indexed8 without a reuse base", () => {
    const w = 2 * SNAP_TILE + 5;
    const h = SNAP_TILE + 2;
    const src = makeBuffer("u8", w, h, 1);
    expect(sameBytes(materializeSnapshot(snapshotFull(src, w, h, 1)), src)).toBe(true);
  });
});
