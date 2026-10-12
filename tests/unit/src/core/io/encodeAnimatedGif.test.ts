// Animated GIF encoder (gifenc), verified with an independent decoder.
import { describe, expect, it } from "vitest";
import { encodeAnimatedGif } from "@/core/io/encodeAnimatedGif";
import { decodeGif } from "@tests/fakes/ioGifDecoder";

/** A frame using only a handful of exact (rgba4444-representable) colours. */
function frame(w: number, h: number, shift: number, transparentEvery = 0): Uint8Array {
  const colours = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 255],
    [0, 0, 0],
  ];
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (transparentEvery && i % transparentEvery === 0) continue; // alpha 0
    const c = colours[(i + shift) % colours.length];
    out.set([c[0], c[1], c[2], 255], i * 4);
  }
  return out;
}

describe("encodeAnimatedGif", () => {
  it("encodes every frame losslessly when there are few colours", () => {
    const w = 7;
    const h = 5;
    const frames = [frame(w, h, 0), frame(w, h, 1), frame(w, h, 2)];
    const gif = decodeGif(encodeAnimatedGif({ frames, width: w, height: h, fps: 10 }));
    expect([gif.width, gif.height]).toEqual([w, h]);
    expect(gif.frames).toHaveLength(3);
    gif.frames.forEach((f, i) => {
      expect([f.left, f.top, f.width, f.height]).toEqual([0, 0, w, h]);
      expect(f.rgba).toEqual(frames[i]);
    });
  });

  it("maps fully transparent pixels to the frame's transparent index", () => {
    const w = 6;
    const h = 4;
    const src = frame(w, h, 0, 3);
    const gif = decodeGif(encodeAnimatedGif({ frames: [src], width: w, height: h, fps: 12 }));
    const f = gif.frames[0];
    expect(f.transparentIndex).not.toBeNull();
    for (let i = 0; i < w * h; i++) {
      expect(f.indices[i] === f.transparentIndex).toBe(i % 3 === 0);
    }
    expect(f.rgba).toEqual(src);
  });

  it("an all-transparent frame stays transparent (not black)", () => {
    const gif = decodeGif(encodeAnimatedGif({ frames: [new Uint8Array(3 * 2 * 4)], width: 3, height: 2, fps: 1 }));
    expect(gif.frames[0].transparentIndex).not.toBeNull();
    expect(gif.frames[0].rgba).toEqual(new Uint8Array(3 * 2 * 4));
  });

  it("writes frame delays in 1/100 s and the loop count", () => {
    const one = [frame(2, 2, 0)];
    const at = (fps: number, loop?: number) => decodeGif(encodeAnimatedGif({ frames: one, width: 2, height: 2, fps, loop }));
    expect(at(10).frames[0].delayCs).toBe(10);
    expect(at(25).frames[0].delayCs).toBe(4);
    expect(at(0).frames[0].delayCs).toBe(100); // fps clamps to >= 1
    expect(at(10).loopCount).toBe(0); // forever by default
    expect(at(10, 3).loopCount).toBe(3);
    expect(at(10, -1).loopCount).toBeNull(); // play once: no NETSCAPE block
  });

  it("handles a 1×1 frame", () => {
    const px = new Uint8Array([0, 0, 255, 255]);
    const gif = decodeGif(encodeAnimatedGif({ frames: [px], width: 1, height: 1, fps: 30 }));
    expect(Array.from(gif.frames[0].rgba)).toEqual([0, 0, 255, 255]);
  });

  it("quantises many-colour frames to at most 256 colours with bounded error", () => {
    const w = 32;
    const h = 32;
    const src = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) src.set([x * 8, y * 8, (x + y) * 4, 255], (y * w + x) * 4);
    }
    const f = decodeGif(encodeAnimatedGif({ frames: [src], width: w, height: h, fps: 10 })).frames[0];
    expect(f.palette.length).toBeLessThanOrEqual(256);
    let err = 0;
    for (let i = 0; i < src.length; i++) if (i % 4 !== 3) err += Math.abs(f.rgba[i] - src[i]);
    expect(err / (w * h * 3)).toBeLessThan(12);
    for (let i = 3; i < src.length; i += 4) expect(f.rgba[i]).toBe(255);
  });
});
