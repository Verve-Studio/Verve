// Radiance RGBE (.hdr) codec and the .hdr exporter / loader path.
import { describe, expect, it } from "vitest";
import { decodeRgbe, encodeRgbe } from "@/core/io/hdrCodec";
import { exportHdr } from "@/core/io/exportHdr";
import { loadImageBytes } from "@/core/io/imageLoader";

/** HDR test image: values from 0 to well above 1. */
function hdrImage(w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out.set([(i % 9) * 0.37, 1 + (i % 4) * 10, i === 0 ? 0 : 1 / (i + 1), 1], i * 4);
  }
  return out;
}

/** RGBE stores an 8-bit mantissa per channel with a shared exponent, so each
 *  channel is accurate to ~1/128 of the pixel's largest channel. */
function expectRgbeClose(got: Float32Array, want: Float32Array): void {
  expect(got.length).toBe(want.length);
  for (let p = 0; p < want.length; p += 4) {
    const max = Math.max(want[p], want[p + 1], want[p + 2]);
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(got[p + c] - want[p + c])).toBeLessThanOrEqual(max / 128 + 1e-30);
    }
    expect(got[p + 3]).toBe(1); // RGBE has no alpha
  }
}

/** A view of `bytes` that throws on any read past the end, so a decoder
 *  that would run off the end of a truncated file fails instead of looping. */
function guarded(bytes: Uint8Array): Uint8Array {
  return new Proxy(bytes, {
    get(t, p) {
      if (typeof p === "string" && /^\d+$/.test(p) && Number(p) >= t.length) {
        throw new RangeError(`read past end of file (${p})`);
      }
      const v = Reflect.get(t, p, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

describe("encodeRgbe / decodeRgbe", () => {
  it("writes the Radiance header and resolution line", () => {
    const bytes = encodeRgbe(hdrImage(8, 2), 8, 2);
    const head = new TextDecoder().decode(bytes.subarray(0, 60));
    expect(head.startsWith("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 8\n")).toBe(true);
  });

  it("round-trips HDR values within RGBE precision (widths >= 8)", () => {
    for (const [w, h] of [
      [8, 1],
      [9, 3],
      [64, 5],
      [300, 2],
    ] as const) {
      const src = hdrImage(w, h);
      const out = decodeRgbe(encodeRgbe(src, w, h));
      expect([out.width, out.height]).toEqual([w, h]);
      expectRgbeClose(out.pixels, src);
    }
  });

  it("keeps very large and very small magnitudes; black stays black", () => {
    const src = new Float32Array([
      65504, 1000, 0.5, 1, 1e-6, 2e-6, 0, 1, 0, 0, 0, 1, 1e-40, 0, 0, 1,
      0.18, 0.18, 0.18, 1, 4, 0, 0, 1, 0, 4, 0, 1, 0, 0, 4, 1,
    ]);
    const out = decodeRgbe(encodeRgbe(src, 8, 1));
    expectRgbeClose(out.pixels, src);
    expect(Array.from(out.pixels.subarray(8, 12))).toEqual([0, 0, 0, 1]);
  });

  it("run-length encodes flat scanlines", () => {
    const w = 512;
    const flat = new Float32Array(w * 4);
    for (let i = 0; i < w; i++) flat.set([0.5, 0.25, 2, 1], i * 4);
    const bytes = encodeRgbe(flat, w, 1);
    expect(bytes.length).toBeLessThan(100); // vs 2 KB uncompressed
    expectRgbeClose(decodeRgbe(bytes).pixels, flat);
  });

  it("decodes flat (uncompressed) scanlines of narrow images", () => {
    // 2×1, old-style raw RGBE: (128, 64, 0, e=129) → (1, 0.5, 0), then black.
    const header = new TextEncoder().encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n");
    const bytes = new Uint8Array([...header, 128, 64, 0, 129, 0, 0, 0, 0]);
    const out = decodeRgbe(bytes);
    expect(Array.from(out.pixels)).toEqual([1, 0.5, 0, 1, 0, 0, 0, 1]);
  });

  it("exportHdr is the RGBE encoder", () => {
    const src = hdrImage(10, 2);
    expect(exportHdr(src, 10, 2)).toEqual(encodeRgbe(src, 10, 2));
  });

  it("loads .hdr through loadImageBytes as an HDR float image", async () => {
    const src = hdrImage(12, 3);
    const out = await loadImageBytes(encodeRgbe(src, 12, 3), "image/vnd.radiance");
    expect(out.isHdr).toBe(true);
    expect([out.width, out.height]).toEqual([12, 3]);
    expect(out.data).toBeInstanceOf(Float32Array);
    expectRgbeClose(out.data as Float32Array, src);
  });

  it("rejects non-RGBE input and bad resolution / scanline headers", async () => {
    expect(() => decodeRgbe(new TextEncoder().encode("#?RADIANCE\nFORMAT=32-bit_rle_xyze\n\n-Y 1 +X 1\n"))).toThrow(
      /unsupported format/,
    );
    expect(() => decodeRgbe(new TextEncoder().encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n+Y 1 -X 1\n"))).toThrow(
      /bad resolution/,
    );
    const good = encodeRgbe(hdrImage(8, 1), 8, 1);
    const bad = good.slice();
    const at = bad.indexOf(2, new TextDecoder().decode(good).indexOf("+X 8\n") + 5);
    bad[at + 3] = 9; // scanline header claims width 9
    expect(() => decodeRgbe(bad)).toThrow(/bad scanline width/);
    await expect(loadImageBytes(new Uint8Array([1, 2, 3]), "image/vnd.radiance")).rejects.toThrow(
      /Failed to decode HDR/,
    );
  });

  it("round-trips images narrower than 8 pixels (1×1, 5×3)", () => {
    for (const [w, h] of [
      [1, 1],
      [5, 3],
    ] as const) {
      const src = hdrImage(w, h);
      expectRgbeClose(decodeRgbe(encodeRgbe(src, w, h)).pixels, src);
    }
  });

  it("clamps negative scene-linear values to 0 instead of flipping their sign", () => {
    const src = new Float32Array(8 * 4);
    for (let i = 0; i < 8; i++) src.set([-0.5, 1, 0, 1], i * 4);
    const out = decodeRgbe(encodeRgbe(src, 8, 1)).pixels;
    expect(out[0]).toBe(0);
  });

  it("writes NaN as 0 and +Infinity as the largest RGBE value", () => {
    const src = new Float32Array(8 * 4);
    for (let i = 0; i < 8; i++) src.set([NaN, Infinity, 0.5, 1], i * 4);
    const out = decodeRgbe(encodeRgbe(src, 8, 1)).pixels;
    expect(out[0]).toBe(0);
    expect(out[1]).toBeGreaterThan(1e38);
    expect(Number.isFinite(out[1])).toBe(true);
    expect(out[2]).toBe(0); // 0.5 is far below the shared exponent's precision
  });

  // A truncated file must fail with an "HDR: …" error; the guarded view turns
  // any read past the end into an exception instead.
  it("decodes a complete file without reading past its end (guard sanity check)", () => {
    const src = hdrImage(16, 4);
    expectRgbeClose(decodeRgbe(guarded(encodeRgbe(src, 16, 4))).pixels, src);
  });

  it("rejects a file truncated inside a scanline without reading past the end", () => {
    const bytes = encodeRgbe(hdrImage(16, 4), 16, 4);
    const cut = bytes.slice(0, bytes.length - 10);
    expect(() => decodeRgbe(guarded(cut))).toThrow(/^HDR/);
  });
});
