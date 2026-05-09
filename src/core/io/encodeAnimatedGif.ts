import { GIFEncoder, quantize, applyPalette } from "gifenc";

export interface EncodeAnimatedGifInput {
  /** Per-frame canvas-sized RGBA buffers (width × height × 4 bytes). */
  frames: readonly Uint8Array[];
  width: number;
  height: number;
  /** Frame rate. The GIF format stores delay in 1/100s units, so the
   *  closest integer is used (minimum 2/100s ≈ 50 fps cap on some
   *  decoders — we still emit smaller delays for higher rates). */
  fps: number;
  /** 0 = loop forever (default), -1 = play once, N = loop N times. */
  loop?: number;
}

/** Encode a sequence of RGBA frames into an animated GIF. Returns the
 *  raw GIF bytes ready to be written to disk. The encoder uses gifenc to
 *  build a per-frame palette (max 256 colours per frame), which is the
 *  right default for both indexed8 documents (where the source palette
 *  is already small) and full-colour rgba8 documents (gifenc's median-
 *  cut quantiser produces a clean reduction). */
export function encodeAnimatedGif(
  input: EncodeAnimatedGifInput,
): Uint8Array {
  const { frames, width, height, fps, loop = 0 } = input;
  const fpsSafe = Math.max(1, fps);
  const delayMs = Math.round(1000 / fpsSafe);

  const gif = GIFEncoder();
  for (const rgba of frames) {
    // `rgba4444` + `oneBitAlpha` keeps a transparency bit through the
    // quantizer so fully-transparent canvas pixels collapse to a single
    // palette slot. We then locate that slot and pass it as the GIF's
    // transparent index — without this, GIF (which has no alpha channel)
    // would render those pixels as black.
    const palette = quantize(rgba, 256, {
      format: "rgba4444",
      oneBitAlpha: true,
    });
    let transparentIndex = -1;
    for (let i = 0; i < palette.length; i++) {
      const c = palette[i] as [number, number, number, number];
      if (c.length >= 4 && c[3] === 0) {
        transparentIndex = i;
        break;
      }
    }
    const indexed = applyPalette(rgba, palette, "rgba4444");
    gif.writeFrame(indexed, width, height, {
      palette,
      delay: delayMs,
      repeat: loop,
      transparent: transparentIndex >= 0,
      transparentIndex: transparentIndex >= 0 ? transparentIndex : 0,
    });
  }
  gif.finish();
  return gif.bytes();
}
