// Wrappers in src/wasm/index.ts against the real (MEMORY64) WASM module.
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyAffineTransform,
  applyPerspectiveTransform,
  computeHistogramRGBA,
  decodeDds,
  decodeDdsF32,
  decodeExr,
  decodeExrLayers,
  DdsFormat,
  DdsHeaderMode,
  encodeDds,
  encodeDdsF32,
  encodeExr,
  encodeExrLayers,
  floodFill,
  floodFillF32,
  flipIndexed,
  flipRgba,
  getDdsInfo,
  getPixelOps,
  getPixelOpsSync,
  grabCut,
  grabCutComputeBeta,
  grabCutKmeansInit,
  grabCutMincut,
  grabCutUpdateGmms,
  inpaintRegion,
  matchPaletteIndices,
  maxDdsMipLevels,
  quantize,
  resizeLayer,
  rotateIndexed,
  rotateRgba,
} from "@/wasm";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Deterministic RGBA8 image with every byte distinct-ish (incl. alpha). */
function patternRgba8(w: number, h: number, seed = 1): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  let s = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

function patternIndexed(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = (i * 37 + 11) % 256;
  return out;
}

/** Linear-light floats including HDR (> 1) values. */
function patternF32(w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = (i % 7) * 0.75; // up to 4.5
    out[i * 4 + 1] = (i % 5) / 4;
    out[i * 4 + 2] = i === 0 ? 1000 : (i % 3) * 0.125;
    out[i * 4 + 3] = (i % 4) / 3;
  }
  return out;
}

const solid = (w: number, h: number, c: readonly number[]): Uint8Array => {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set(c, i * 4);
  return out;
};

const px = (buf: Uint8Array | Float32Array, w: number, x: number, y: number): number[] =>
  Array.from(buf.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));

/** Reference 90° clockwise rotation (bpp bytes per pixel). */
function rotateCwRef(src: Uint8Array, w: number, h: number, bpp: number): Uint8Array {
  const out = new Uint8Array(src.length);
  // dst is h × w; dst(dx, dy) = src(dy, h - 1 - dx)
  for (let dy = 0; dy < w; dy++) {
    for (let dx = 0; dx < h; dx++) {
      const s = ((h - 1 - dx) * w + dy) * bpp;
      out.set(src.subarray(s, s + bpp), (dy * h + dx) * bpp);
    }
  }
  return out;
}

beforeAll(async () => {
  await getPixelOps();
});

// ─── Module loading ──────────────────────────────────────────────────────────

describe("getPixelOps", () => {
  it("is cached and exposed synchronously once loaded", async () => {
    const a = await getPixelOps();
    const b = await getPixelOps();
    expect(a).toBe(b);
    expect(getPixelOpsSync()).toBe(a);
  });

  it("returns Number pointers from the wrapped _malloc (wasm64 boundary)", async () => {
    const m = await getPixelOps();
    const p = m._malloc(64);
    try {
      expect(typeof p).toBe("number");
      expect(p).toBeGreaterThan(0);
      m.HEAPU8.set([1, 2, 3], p);
      expect(Array.from(m.HEAPU8.subarray(p, p + 3))).toEqual([1, 2, 3]);
    } finally {
      m._free(p);
    }
  });
});

// ─── Flood fill ──────────────────────────────────────────────────────────────

describe("floodFill (rgba8)", () => {
  // 5×3: a vertical wall at x = 2 splits two white regions.
  const W = 5;
  const H = 3;
  const white = [255, 255, 255, 255];
  const wall = [0, 0, 0, 255];
  function walled(): Uint8Array {
    const img = solid(W, H, white);
    for (let y = 0; y < H; y++) img.set(wall, (y * W + 2) * 4);
    return img;
  }

  it("fills only the contiguous region and leaves the rest untouched", async () => {
    const src = walled();
    const out = await floodFill(src, W, H, 0, 0, 10, 20, 30, 40);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const expected = x < 2 ? [10, 20, 30, 40] : x === 2 ? wall : white;
        expect(px(out, W, x, y)).toEqual(expected);
      }
    }
    // The wrapper returns a copy: input untouched.
    expect(src).toEqual(walled());
  });

  it("is a no-op when the seed is outside the image or already the fill colour", async () => {
    const src = walled();
    expect(await floodFill(src, W, H, -1, 0, 1, 2, 3, 4)).toEqual(src);
    expect(await floodFill(src, W, H, 0, 5, 1, 2, 3, 4)).toEqual(src);
    expect(await floodFill(src, W, H, 0, 0, 255, 255, 255, 255)).toEqual(src);
  });

  it("tolerance admits colours whose RGBA distance is <= 2 × tolerance", async () => {
    // Row: seed (100) | 104 (dist 4) | 106 (dist 6) on the red channel only.
    const src = new Uint8Array([100, 0, 0, 255, 104, 0, 0, 255, 106, 0, 0, 255]);
    const exact = await floodFill(src, 3, 1, 0, 0, 0, 0, 255, 255, 0);
    expect(px(exact, 3, 1, 0)).toEqual([104, 0, 0, 255]);
    const tol2 = await floodFill(src, 3, 1, 0, 0, 0, 0, 255, 255, 2);
    expect(px(tol2, 3, 1, 0)).toEqual([0, 0, 255, 255]);
    expect(px(tol2, 3, 2, 0)).toEqual([106, 0, 0, 255]);
    const tol3 = await floodFill(src, 3, 1, 0, 0, 0, 0, 255, 255, 3);
    expect(px(tol3, 3, 2, 0)).toEqual([0, 0, 255, 255]);
  });

  it("works on a 1×1 image", async () => {
    const out = await floodFill(new Uint8Array([1, 2, 3, 4]), 1, 1, 0, 0, 9, 8, 7, 6);
    expect(Array.from(out)).toEqual([9, 8, 7, 6]);
  });
});

describe("floodFillF32", () => {
  it("fills with HDR values unclamped and respects float tolerance", async () => {
    // 3×1: 0.5 | 0.52 | 0.9 (red channel)
    const src = new Float32Array([0.5, 0, 0, 1, 0.52, 0, 0, 1, 0.9, 0, 0, 1]);
    const out = await floodFillF32(src, 3, 1, 0, 0, 4.5, 2, 0.25, 1, 0.02);
    expect(Array.from(out.subarray(0, 4))).toEqual([4.5, 2, 0.25, 1]);
    expect(Array.from(out.subarray(4, 8))).toEqual([4.5, 2, 0.25, 1]);
    expect(out[8]).toBeCloseTo(0.9, 6);
    expect(out).toBeInstanceOf(Float32Array);
    // Input untouched.
    expect(src[0]).toBe(0.5);
  });

  it("does not leak across a wall of different HDR colour", async () => {
    const src = new Float32Array([0, 0, 0, 0, 5, 5, 5, 1, 0, 0, 0, 0]);
    const out = await floodFillF32(src, 3, 1, 0, 0, 1, 1, 1, 1, 0);
    expect(Array.from(out)).toEqual([1, 1, 1, 1, 5, 5, 5, 1, 0, 0, 0, 0]);
  });
});

// ─── Resize ──────────────────────────────────────────────────────────────────

describe("resizeLayer", () => {
  const rect = (w: number, h: number) => ({ x: 0, y: 0, width: w, height: h });

  it("scale 1 is an exact copy for rgba8 (nearest and bilinear)", async () => {
    const src = patternRgba8(7, 5);
    // Fully opaque so the premultiplied tent filter can't perturb colour.
    for (let i = 3; i < src.length; i += 4) src[i] = 255;
    for (const filter of ["nearest", "bilinear"] as const) {
      const out = await resizeLayer(
        { data: src, format: "rgba8", width: 7, height: 5, offsetX: 0, offsetY: 0 },
        7, 5, 1, 1, rect(7, 5), filter,
      );
      expect(out).toBeInstanceOf(Uint8Array);
      expect(out).toEqual(src);
    }
  });

  it("scale 1 keeps rgba32f HDR floats exactly", async () => {
    const src = patternF32(3, 2);
    for (let i = 3; i < src.length; i += 4) src[i] = 1;
    const out = await resizeLayer(
      { data: src, format: "rgba32f", width: 3, height: 2, offsetX: 0, offsetY: 0 },
      3, 2, 1, 1, rect(3, 2), "bilinear",
    );
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out)).toEqual(Array.from(src));
  });

  it("2× nearest upscale duplicates each pixel; indexed8 indices are copied", async () => {
    const src = new Uint8Array([1, 2, 3, 255]); // 2×2 indices
    const out = await resizeLayer(
      { data: src, format: "indexed8", width: 2, height: 2, offsetX: 0, offsetY: 0 },
      2, 2, 2, 2, rect(4, 4), "bilinear", // indexed8 is always nearest
    );
    expect(Array.from(out)).toEqual([
      1, 1, 2, 2,
      1, 1, 2, 2,
      3, 3, 255, 255,
      3, 3, 255, 255,
    ]);
  });

  it("2× downscale of a flat colour keeps the colour (rgba32f HDR)", async () => {
    const src = new Float32Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) src.set([3.5, 0.25, 0, 1], i * 4);
    const out = await resizeLayer(
      { data: src, format: "rgba32f", width: 4, height: 4, offsetX: 0, offsetY: 0 },
      4, 4, 0.5, 0.5, rect(2, 2), "bilinear",
    );
    for (let i = 0; i < 4; i++) {
      expect(out[i * 4]).toBeCloseTo(3.5, 5);
      expect(out[i * 4 + 1]).toBeCloseTo(0.25, 5);
      expect(out[i * 4 + 3]).toBeCloseTo(1, 5);
    }
  });
});

// ─── Quantize / histogram / palette matching ─────────────────────────────────

describe("quantize", () => {
  it("returns exactly the distinct colours when there are fewer than maxColors", async () => {
    const src = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255,
    ]);
    const { palette, count } = await quantize(src, 8);
    expect(count).toBe(3);
    expect(palette.length).toBe(12);
    const colours = new Set<string>();
    for (let i = 0; i < count; i++) colours.add(Array.from(palette.subarray(i * 4, i * 4 + 4)).join(","));
    expect(colours).toEqual(new Set(["255,0,0,255", "0,255,0,255", "0,0,255,255"]));
  });

  it("never returns more than maxColors entries", async () => {
    const { palette, count } = await quantize(patternRgba8(16, 16), 4);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(4);
    expect(palette.length).toBe(count * 4);
  });

  it("rejects float input instead of silently truncating it", async () => {
    await expect(
      quantize(new Float32Array(4) as unknown as Uint8Array, 4),
    ).rejects.toThrow(TypeError);
  });
});

describe("computeHistogramRGBA", () => {
  const img = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255,
  ]);

  it("counts every pixel per channel; the RGB histogram sums all three channels", async () => {
    const h = await computeHistogramRGBA(img, 2, 2);
    expect(h.red.length).toBe(256);
    expect(h.red[255]).toBe(2);
    expect(h.red[0]).toBe(2);
    expect(h.green[255]).toBe(1);
    expect(h.blue[255]).toBe(1);
    const sum = (a: Float32Array) => a.reduce((s, v) => s + v, 0);
    expect(sum(h.red)).toBe(4);
    expect(sum(h.rgb)).toBe(12);
  });

  it("weights pixels by a soft selection mask", async () => {
    const h = await computeHistogramRGBA(img, 2, 2, new Uint8Array([255, 0, 0, 128]));
    // The two red pixels have mask 255 and 128.
    expect(h.red[255]).toBeCloseTo(1 + 128 / 255, 5);
    expect(h.green[255]).toBe(0);
  });
});

describe("matchPaletteIndices", () => {
  const palette = [
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 },
    { r: 200, g: 0, b: 0, a: 255 },
  ];

  it("maps each pixel to the nearest palette colour and transparent pixels to transparentIdx", async () => {
    const rgba = new Uint8Array([
      10, 10, 10, 255, // → black
      250, 240, 245, 255, // → white
      180, 30, 20, 255, // → red
      200, 0, 0, 0, // transparent
    ]);
    expect(Array.from(await matchPaletteIndices(rgba, palette))).toEqual([0, 1, 2, 255]);
    expect(Array.from(await matchPaletteIndices(rgba, palette, 7))).toEqual([0, 1, 2, 7]);
  });

  it("maps exact palette colours to their own index", async () => {
    const rgba = new Uint8Array(palette.flatMap((c) => [c.r, c.g, c.b, c.a]));
    expect(Array.from(await matchPaletteIndices(rgba, palette))).toEqual([0, 1, 2]);
  });
});

// ─── Affine / perspective transforms ─────────────────────────────────────────

describe("affine / perspective transforms", () => {
  const ID_AFFINE = new Float32Array([1, 0, 0, 0, 1, 0]);
  const ID_H = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  it("identity (nearest) is a no-op for rgba8 and rgba32f incl. HDR", async () => {
    const u8 = patternRgba8(5, 3);
    expect(await applyAffineTransform(u8, 5, 3, 5, 3, ID_AFFINE, 0)).toEqual(u8);
    expect(await applyPerspectiveTransform(u8, 5, 3, 5, 3, ID_H, 0)).toEqual(u8);

    const f32 = patternF32(5, 3);
    const outF = await applyAffineTransform(f32, 5, 3, 5, 3, ID_AFFINE, 0);
    expect(outF).toBeInstanceOf(Float32Array);
    expect(Array.from(outF)).toEqual(Array.from(f32));
    expect(Array.from(await applyPerspectiveTransform(f32, 5, 3, 5, 3, ID_H, 0))).toEqual(
      Array.from(f32),
    );
  });

  it("integer translation (nearest) moves pixels exactly and clears uncovered pixels", async () => {
    const src = patternRgba8(4, 4);
    // dst(x, y) samples src(x - 1, y): shift right by one.
    const out = await applyAffineTransform(src, 4, 4, 4, 4, new Float32Array([1, 0, -1, 0, 1, 0]), 0);
    for (let y = 0; y < 4; y++) {
      for (let x = 1; x < 4; x++) expect(px(out, 4, x, y)).toEqual(px(src, 4, x - 1, y));
    }
  });

  it("a 90° rotation matrix (nearest) matches the exact rotate kernel", async () => {
    const w = 4;
    const h = 3;
    const src = patternRgba8(w, h);
    // 90° CW: dst is h × w, dst(x, y) = src(y, h - 1 - x).
    const inv = new Float32Array([0, 1, 0, -1, 0, h - 1]);
    const viaAffine = await applyAffineTransform(src, w, h, h, w, inv, 0);
    expect(viaAffine).toEqual(await rotateRgba(src, w, h, 0));
  });

  it("identity transform with bilinear interpolation is a no-op", async () => {
    const src = solid(3, 3, [200, 100, 50, 255]);
    const out = await applyAffineTransform(src, 3, 3, 3, 3, ID_AFFINE, 1);
    expect(out).toEqual(src);
  });

  it("identity transform with bicubic interpolation is a no-op", async () => {
    const src = patternRgba8(4, 4);
    for (let i = 3; i < src.length; i += 4) src[i] = 255;
    const out = await applyAffineTransform(src, 4, 4, 4, 4, ID_AFFINE, 2);
    expect(out).toEqual(src);
  });

  it("bilinear keeps HDR values above 1 for rgba32f", async () => {
    const src = new Float32Array(16 * 4);
    for (let i = 0; i < 16; i++) src.set([8, 2, 0.5, 1], i * 4);
    // Interior pixel (2, 2) of a flat image is unaffected by edge handling.
    const out = await applyAffineTransform(src, 4, 4, 4, 4, ID_AFFINE, 1);
    expect(px(out, 4, 2, 2)).toEqual([8, 2, 0.5, 1]);
  });

  it("maps out-of-source pixels to transparent", async () => {
    const src = solid(2, 2, [9, 9, 9, 255]);
    const out = await applyAffineTransform(src, 2, 2, 2, 2, new Float32Array([1, 0, 50, 0, 1, 50]), 0);
    expect(out).toEqual(new Uint8Array(16));
  });
});

// ─── Rotate / flip ───────────────────────────────────────────────────────────

describe("rotate / flip", () => {
  const W = 5;
  const H = 3;

  it("rotateRgba 90° CW matches a reference, on an odd-sized image", async () => {
    const src = patternRgba8(W, H);
    expect(await rotateRgba(src, W, H, 0)).toEqual(rotateCwRef(src, W, H, 4));
  });

  it("rotateIndexed 90° CW matches a reference", async () => {
    const src = patternIndexed(W, H);
    expect(await rotateIndexed(src, W, H, 0)).toEqual(rotateCwRef(src, W, H, 1));
  });

  it("four 90° rotations are the identity (rgba and indexed)", async () => {
    let rgba = patternRgba8(W, H);
    let idx = patternIndexed(W, H);
    let w = W;
    let h = H;
    for (let i = 0; i < 4; i++) {
      rgba = await rotateRgba(rgba, w, h, 0);
      idx = await rotateIndexed(idx, w, h, 0);
      [w, h] = [h, w];
    }
    expect(rgba).toEqual(patternRgba8(W, H));
    expect(idx).toEqual(patternIndexed(W, H));
  });

  it("180° = two 90° and 270° = three 90°", async () => {
    const src = patternRgba8(W, H);
    const r90 = await rotateRgba(src, W, H, 0);
    const r180 = await rotateRgba(r90, H, W, 0);
    const r270 = await rotateRgba(r180, W, H, 0);
    expect(await rotateRgba(src, W, H, 1)).toEqual(r180);
    expect(await rotateRgba(src, W, H, 2)).toEqual(r270);
    const isrc = patternIndexed(W, H);
    const i90 = await rotateIndexed(isrc, W, H, 0);
    const i180 = await rotateIndexed(i90, H, W, 0);
    expect(await rotateIndexed(isrc, W, H, 1)).toEqual(i180);
    expect(await rotateIndexed(isrc, W, H, 2)).toEqual(await rotateIndexed(i180, W, H, 0));
  });

  it("flips mirror rows / columns and are involutions", async () => {
    const src = patternRgba8(W, H);
    const fh = await flipRgba(src, W, H, 0);
    expect(px(fh, W, 0, 1)).toEqual(px(src, W, W - 1, 1));
    const fv = await flipRgba(src, W, H, 1);
    expect(px(fv, W, 2, 0)).toEqual(px(src, W, 2, H - 1));
    expect(await flipRgba(fh, W, H, 0)).toEqual(src);
    expect(await flipRgba(fv, W, H, 1)).toEqual(src);
    // horizontal + vertical flip = 180° rotation
    expect(await flipRgba(fh, W, H, 1)).toEqual(await rotateRgba(src, W, H, 1));

    const isrc = patternIndexed(W, H);
    const ih = await flipIndexed(isrc, W, H, 0);
    expect(ih[0]).toBe(isrc[W - 1]);
    expect(await flipIndexed(ih, W, H, 0)).toEqual(isrc);
    expect(await flipIndexed(await flipIndexed(isrc, W, H, 1), W, H, 0)).toEqual(
      await rotateIndexed(isrc, W, H, 1),
    );
  });

  it("handles 1×1 images", async () => {
    const one = new Uint8Array([1, 2, 3, 4]);
    expect(Array.from(await rotateRgba(one, 1, 1, 0))).toEqual([1, 2, 3, 4]);
    expect(Array.from(await flipRgba(one, 1, 1, 1))).toEqual([1, 2, 3, 4]);
    expect(Array.from(await rotateIndexed(new Uint8Array([7]), 1, 1, 2))).toEqual([7]);
  });
});

// ─── Inpainting ──────────────────────────────────────────────────────────────

describe("inpaintRegion", () => {
  it("fills a hole in a flat image with the surrounding colour and keeps the rest", async () => {
    const W = 24;
    const H = 24;
    const bg = [40, 120, 200, 255];
    const img = solid(W, H, bg);
    const mask = new Uint8Array(W * H);
    for (let y = 10; y < 14; y++) {
      for (let x = 10; x < 14; x++) {
        img.set([255, 0, 0, 255], (y * W + x) * 4);
        mask[y * W + x] = 255;
      }
    }
    const out = await inpaintRegion(img, W, H, mask);
    expect(out).toEqual(solid(W, H, bg));
  });

  it("returns an unchanged copy for an empty mask", async () => {
    const img = patternRgba8(8, 8);
    const out = await inpaintRegion(img, 8, 8, new Uint8Array(64));
    expect(out).toEqual(img);
    expect(out).not.toBe(img);
  });

  it("only samples from the source mask when one is given", async () => {
    // Left half green, right half blue; fill a hole in the right half but
    // allow only green source pixels → the hole becomes green.
    const W = 24;
    const H = 16;
    const img = new Uint8Array(W * H * 4);
    const source = new Uint8Array(W * H);
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        img.set(x < 12 ? [0, 255, 0, 255] : [0, 0, 255, 255], (y * W + x) * 4);
        if (x < 12) source[y * W + x] = 1;
        if (x >= 16 && x < 20 && y >= 6 && y < 10) {
          mask[y * W + x] = 255;
          img.set([255, 0, 0, 255], (y * W + x) * 4);
        }
      }
    }
    const out = await inpaintRegion(img, W, H, mask, source);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (mask[i]) expect(px(out, W, x, y)).toEqual([0, 255, 0, 255]);
        else expect(px(out, W, x, y)).toEqual(px(img, W, x, y));
      }
    }
  });
});

// ─── GrabCut ─────────────────────────────────────────────────────────────────

describe("grabCut", () => {
  // 16×8: left half dark red, right half bright cyan. Column 0 is definite
  // background, column 15 definite foreground, the rest unknown.
  const W = 16;
  const H = 8;
  const img = new Uint8Array(W * H * 4);
  const trimap = new Uint8Array(W * H).fill(128);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      img.set(x < 8 ? [120, 10, 10, 255] : [10, 230, 230, 255], (y * W + x) * 4);
    }
    trimap[y * W] = 0;
    trimap[y * W + W - 1] = 255;
  }
  const expected = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 8; x < W; x++) expected[y * W + x] = 255;

  it("segments a two-colour image along the colour edge", async () => {
    const alpha = await grabCut(img, W, H, trimap, 2, 2);
    expect(alpha).toEqual(expected);
  });

  it("step-wise API: beta, k-means init, GMM update and min-cut", async () => {
    const k = 2;
    const beta = await grabCutComputeBeta(img, W, H);
    expect(Number.isFinite(beta)).toBe(true);
    expect(beta).toBeGreaterThan(0);

    const params = await grabCutKmeansInit(img, W, H, trimap, k);
    expect(params.length).toBe(2 * k * 20);
    expect(params.every(Number.isFinite)).toBe(true);

    const label = new Uint8Array(W * H);
    for (let i = 0; i < label.length; i++) label[i] = trimap[i] >= 128 ? 1 : 0;
    const updated = await grabCutUpdateGmms(img, W, H, label, k, params);
    expect(updated.length).toBe(params.length);
    expect(updated.every(Number.isFinite)).toBe(true);
  });

  it("min-cut follows the t-links and hard trimap constraints", async () => {
    // 4×1, no n-links: x >= 2 strongly source (FG), x < 2 strongly sink (BG).
    const capS = new Float32Array([0, 0, 10, 10]);
    const capT = new Float32Array([10, 10, 0, 0]);
    const hW = new Float32Array(3);
    const vW = new Float32Array(0);
    const free = new Uint8Array([128, 128, 128, 128]);
    expect(Array.from(await grabCutMincut(capS, capT, hW, vW, free, 4, 1))).toEqual([0, 0, 1, 1]);
    // Hard constraints override the t-links.
    const forced = new Uint8Array([255, 128, 128, 0]);
    expect(Array.from(await grabCutMincut(capS, capT, hW, vW, forced, 4, 1))).toEqual([1, 0, 1, 0]);
  });
});

// ─── EXR ─────────────────────────────────────────────────────────────────────

describe("EXR encode / decode", () => {
  it("round-trips 32-bit float pixels bit-exactly, incl. HDR and zero alpha", async () => {
    const W = 5;
    const H = 3;
    const src = patternF32(W, H);
    for (const compression of [0, 1, 2, 3]) {
      const bytes = await encodeExr(src, W, H, compression, 0);
      const out = await decodeExr(bytes);
      expect(out.width).toBe(W);
      expect(out.height).toBe(H);
      expect(Array.from(out.pixels)).toEqual(Array.from(src));
    }
  });

  it("half-float output keeps values within half precision", async () => {
    const src = patternF32(4, 2);
    const out = await decodeExr(await encodeExr(src, 4, 2, 1, 1));
    for (let i = 0; i < src.length; i++) {
      expect(Math.abs(out.pixels[i] - src[i])).toBeLessThanOrEqual(Math.abs(src[i]) * 1e-3 + 1e-4);
    }
  });

  it("round-trips a 1×1 image", async () => {
    const src = new Float32Array([65000, 0.001, 0, 0.5]);
    const out = await decodeExr(await encodeExr(src, 1, 1));
    expect(Array.from(out.pixels)).toEqual(Array.from(src));
  });

  it("multi-layer round trip keeps names (UTF-8), order and pixels", async () => {
    const W = 3;
    const H = 2;
    const a = patternF32(W, H);
    const b = new Float32Array(W * H * 4).fill(0.25);
    const bytes = await encodeExrLayers(
      [
        { name: "Background", pixels: a },
        { name: "Glöw", pixels: b },
      ],
      W,
      H,
      1,
      0,
    );
    const out = await decodeExrLayers(bytes);
    expect(out.canvasWidth).toBe(W);
    expect(out.canvasHeight).toBe(H);
    expect(out.layers.map((l) => l.name)).toEqual(["Background", "Glöw"]);
    for (const l of out.layers) {
      expect([l.width, l.height, l.offsetX, l.offsetY]).toEqual([W, H, 0, 0]);
    }
    expect(Array.from(out.layers[0].pixels)).toEqual(Array.from(a));
    expect(Array.from(out.layers[1].pixels)).toEqual(Array.from(b));
  });

  it("decodeExrLayers reads a single-part RGBA file as one layer", async () => {
    const src = patternF32(2, 2);
    const out = await decodeExrLayers(await encodeExr(src, 2, 2));
    expect(out.layers.length).toBe(1);
    expect(Array.from(out.layers[0].pixels)).toEqual(Array.from(src));
  });

  it("encodeExrLayers rejects empty input and wrongly sized layers", async () => {
    await expect(encodeExrLayers([], 2, 2)).rejects.toThrow(/no layers/);
    await expect(
      encodeExrLayers([{ name: "x", pixels: new Float32Array(3) }], 2, 2),
    ).rejects.toThrow(/expected 16/);
  });

  it("rejects garbage instead of returning pixels", async () => {
    await expect(decodeExr(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toThrow();
    await expect(decodeExrLayers(new Uint8Array(16))).rejects.toThrow();
  });
});

// ─── DDS ─────────────────────────────────────────────────────────────────────

describe("DDS encode / decode", () => {
  /** Smooth diagonal ramp whose colours lie on one line in RGB (what a
   *  BC1-style block endpoint pair can represent), with constant alpha. */
  function gradient(w: number, h: number, alpha = 255): Uint8Array {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = (x + y) / (w + h - 2);
        out.set([Math.round(t * 255), Math.round(64 + t * 128), Math.round(200 - t * 150), alpha], (y * w + x) * 4);
      }
    }
    return out;
  }
  const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
    let m = 0;
    for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m;
  };

  const meanDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  };

  // Block compression is lossy: bound the mean error tightly and the worst
  // pixel more loosely (BC1/BC3 store 5:6:5 endpoints, 4 levels per block).
  for (const [name, fmt, meanTol, maxTol] of [
    ["BC1", DdsFormat.BC1, 4, 20],
    ["BC3", DdsFormat.BC3, 4, 20],
    ["BC7", DdsFormat.BC7, 2, 8],
  ] as const) {
    it(`${name} round trip is close to the source and reports its format`, async () => {
      const src = gradient(16, 8);
      const bytes = await encodeDds(src, 16, 8, fmt);
      const info = await getDdsInfo(bytes);
      expect(info).toEqual({ width: 16, height: 8, fmt, mipLevels: 1 });
      const out = await decodeDds(bytes);
      expect([out.width, out.height]).toEqual([16, 8]);
      expect(meanDiff(out.pixels, src)).toBeLessThanOrEqual(meanTol);
      expect(maxDiff(out.pixels, src)).toBeLessThanOrEqual(maxTol);
    });
  }

  it("BC3 / BC7 keep alpha", async () => {
    const src = gradient(8, 8, 77);
    for (const fmt of [DdsFormat.BC3, DdsFormat.BC7]) {
      const out = await decodeDds(await encodeDds(src, 8, 8, fmt));
      for (let i = 3; i < out.pixels.length; i += 4) expect(Math.abs(out.pixels[i] - 77)).toBeLessThanOrEqual(6);
    }
  });

  it("encodes non-multiple-of-4 sizes (odd, 1×1)", async () => {
    for (const [w, h] of [[5, 3], [1, 1]] as const) {
      const src = solid(w, h, [10, 200, 90, 255]);
      const out = await decodeDds(await encodeDds(src, w, h, DdsFormat.BC7));
      expect([out.width, out.height]).toEqual([w, h]);
      expect(maxDiff(out.pixels, src)).toBeLessThanOrEqual(4);
    }
  });

  it("writes the requested mip count, with DX9 and DX10 headers", async () => {
    const src = gradient(64, 32);
    const dx9 = await encodeDds(src, 64, 32, DdsFormat.BC1, 3, DdsHeaderMode.DX9);
    const dx10 = await encodeDds(src, 64, 32, DdsFormat.BC1, 3, DdsHeaderMode.DX10);
    expect((await getDdsInfo(dx9)).mipLevels).toBe(3);
    expect((await getDdsInfo(dx10)).mipLevels).toBe(3);
    // The DX10 extension header is 20 bytes.
    expect(dx10.length - dx9.length).toBe(20);
    // BC1: 8 bytes per 4×4 block; 64×32 + 32×16 + 16×8 = 128 + 32 + 8 blocks.
    expect(dx9.length).toBe(128 + (128 + 32 + 8) * 8);
  });

  it("RGBA32F round trip is lossless, incl. HDR values", async () => {
    const src = patternF32(5, 3);
    const bytes = await encodeDdsF32(src, 5, 3, DdsFormat.RGBA32F);
    expect((await getDdsInfo(bytes)).fmt).toBe(DdsFormat.RGBA32F);
    const out = await decodeDdsF32(bytes);
    expect(Array.from(out.pixels)).toEqual(Array.from(src));
  });

  it("BC6H keeps HDR magnitudes approximately", async () => {
    const W = 8;
    const H = 8;
    const src = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) src.set([4, 1, 0.25, 1], i * 4);
    const bytes = await encodeDdsF32(src, W, H, DdsFormat.BC6H);
    expect((await getDdsInfo(bytes)).fmt).toBe(DdsFormat.BC6H);
    const out = await decodeDdsF32(bytes);
    for (let i = 0; i < W * H; i++) {
      expect(out.pixels[i * 4]).toBeCloseTo(4, 1);
      expect(out.pixels[i * 4 + 1]).toBeCloseTo(1, 1);
      expect(out.pixels[i * 4 + 2]).toBeCloseTo(0.25, 1);
    }
  });

  it("rejects unsupported encode formats and invalid files", async () => {
    await expect(encodeDds(solid(4, 4, [0, 0, 0, 255]), 4, 4, DdsFormat.BC6H)).rejects.toThrow(/DDS/);
    await expect(getDdsInfo(new Uint8Array(10))).rejects.toThrow(/DDS: invalid file/);
    await expect(decodeDds(new Uint8Array(128))).rejects.toThrow(/DDS/);
  });

  it("maxDdsMipLevels stops before the smaller side drops under minDim", async () => {
    expect(await maxDdsMipLevels(1024, 512, 128)).toBe(3);
    expect(await maxDdsMipLevels(100, 100, 128)).toBe(1);
    expect(await maxDdsMipLevels(0, 100, 128)).toBe(1);
    expect(await maxDdsMipLevels(256, 256, 1)).toBe(9);
  });
});
