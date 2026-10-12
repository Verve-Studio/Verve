// Browser-encoder exporters (PNG / JPEG / WebP) and their ICC embedding.
// Node has no OffscreenCanvas, so a small software fake stands in for the
// canvas (test/fakes/ioOffscreenCanvas.ts): these tests cover what the
// exporters ask of the encoder (pixels, background compositing, quality) and
// the post-encode ICC step — not the browser's codecs themselves.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractIccFromJpeg, extractIccFromPng } from "@/core/cms/iccProfile";
import { encodeWithCanvas } from "@/core/io/canvasEncode";
import { exportJpeg } from "@/core/io/exportJpeg";
import { exportPng } from "@/core/io/exportPng";
import { exportWebp } from "@/core/io/exportWebp";
import { decodePng } from "@/core/io/pngCodec";
import {
  decodeFakeEncoded,
  decodeTestPng,
  FakeImageData,
  FakeOffscreenCanvas,
} from "@tests/fakes/ioOffscreenCanvas";

beforeEach(() => {
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  vi.stubGlobal("ImageData", FakeImageData);
});

function rgba8(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < out.length; i++) out[i] = (i * 41 + 9) & 0xff;
  return out;
}

const ICC = new Uint8Array(500).map((_, i) => (i * 7) & 255);

describe("encodeWithCanvas", () => {
  it("hands the encoder exactly the given pixels when no background is set", async () => {
    const src = rgba8(5, 3);
    const png = await decodeTestPng(await encodeWithCanvas(src, 5, 3, "image/png"));
    expect([png.width, png.height]).toEqual([5, 3]);
    expect(png.rgba).toEqual(src);
  });

  it("reads only width × height × 4 bytes from a view into a larger buffer", async () => {
    const host = new Uint8Array(4 + 2 * 2 * 4 + 8).fill(77);
    const view = host.subarray(4, 4 + 16);
    view.set(rgba8(2, 2));
    const png = await decodeTestPng(await encodeWithCanvas(view, 2, 2, "image/png"));
    expect(png.rgba).toEqual(rgba8(2, 2));
  });
});

describe("exportPng", () => {
  // exportPng encodes directly (pngCodec.ts), not through the canvas, so it
  // is checked with the real decoder.
  const chunkTypes = (png: Uint8Array): string[] => {
    const types: string[] = [];
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    for (let p = 8; p + 8 <= png.length; p += 12 + dv.getUint32(p)) {
      types.push(new TextDecoder().decode(png.subarray(p + 4, p + 8)));
    }
    return types;
  };

  it("is lossless (bit-exact incl. alpha) for odd sizes and 1×1", async () => {
    for (const [w, h] of [
      [1, 1],
      [7, 3],
    ] as const) {
      const src = rgba8(w, h);
      expect((await decodePng(await exportPng(src, w, h))).data).toEqual(src);
    }
  });

  it("embeds an ICC profile as an iCCP chunk that extracts back unchanged", async () => {
    const src = rgba8(3, 2);
    const png = await exportPng(src, 3, 2, { iccProfile: ICC });
    const chunks = chunkTypes(png);
    expect(chunks).toContain("iCCP");
    expect(chunks.indexOf("iCCP")).toBeLessThan(chunks.indexOf("IDAT"));
    expect((await decodePng(png)).data).toEqual(src);
    expect(await extractIccFromPng(png)).toEqual(ICC);
    expect(await extractIccFromPng(await exportPng(src, 3, 2))).toBeNull();
  });
});

describe("exportJpeg", () => {
  it("composites transparency over the background and maps quality 0–100 → 0–1", async () => {
    const src = new Uint8Array([255, 255, 255, 128, 0, 0, 255, 255, 9, 9, 9, 0]);
    const out = decodeFakeEncoded(await exportJpeg(src, 3, 1, { quality: 80, background: "#ff0000" }));
    expect(out.type).toBe("image/jpeg");
    expect(out.quality).toBeCloseTo(0.8, 10);
    expect(Array.from(out.rgba)).toEqual([255, 128, 128, 255, 0, 0, 255, 255, 255, 0, 0, 255]);
  });

  it("defaults to quality 92 on white and clamps out-of-range quality", async () => {
    const src = new Uint8Array([0, 0, 0, 0]);
    const def = decodeFakeEncoded(await exportJpeg(src, 1, 1));
    expect(def.quality).toBeCloseTo(0.92, 10);
    expect(Array.from(def.rgba)).toEqual([255, 255, 255, 255]);
    expect(decodeFakeEncoded(await exportJpeg(src, 1, 1, { quality: 150, background: "#000000" })).quality).toBe(1);
    expect(decodeFakeEncoded(await exportJpeg(src, 1, 1, { quality: -5, background: "#000000" })).quality).toBe(0);
  });

  it("embeds an ICC profile as APP2 segments", async () => {
    const jpeg = await exportJpeg(rgba8(2, 2), 2, 2, { quality: 90, background: "#ffffff", iccProfile: ICC });
    expect(extractIccFromJpeg(jpeg)).toEqual(ICC);
    expect(decodeFakeEncoded(jpeg).rgba.length).toBe(16);
  });
});

describe("exportWebp", () => {
  it("keeps alpha (no background) and maps quality", async () => {
    const src = rgba8(3, 3);
    const out = decodeFakeEncoded(await exportWebp(src, 3, 3, { quality: 55 }));
    expect(out.type).toBe("image/webp");
    expect(out.quality).toBeCloseTo(0.55, 10);
    expect(out.rgba).toEqual(src);
    expect(decodeFakeEncoded(await exportWebp(src, 3, 3)).quality).toBeCloseTo(0.9, 10);
  });
});
