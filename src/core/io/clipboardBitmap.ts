// Raw-bitmap transfer for the system clipboard.
//
// The main process moves clipboard images as Electron `nativeImage` raw
// bitmaps (Skia N32: premultiplied, BGRA byte order on desktop platforms)
// instead of PNG, so it never PNG-encodes/decodes a multi-megapixel image
// synchronously on its event loop. The swizzle and (un)premultiply happen
// here, in the renderer.

/** Premultiplied BGRA → straight-alpha RGBA (new buffer). */
export function bgraPremulToRgba(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 0) continue;
    if (a === 255) {
      out[i] = src[i + 2];
      out[i + 1] = src[i + 1];
      out[i + 2] = src[i];
    } else {
      const k = 255 / a;
      out[i] = Math.min(255, Math.round(src[i + 2] * k));
      out[i + 1] = Math.min(255, Math.round(src[i + 1] * k));
      out[i + 2] = Math.min(255, Math.round(src[i] * k));
    }
    out[i + 3] = a;
  }
  return out;
}

/** Straight-alpha RGBA → premultiplied BGRA (new buffer). */
export function rgbaToBgraPremul(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 0) continue;
    if (a === 255) {
      out[i] = src[i + 2];
      out[i + 1] = src[i + 1];
      out[i + 2] = src[i];
    } else {
      const k = a / 255;
      out[i] = Math.round(src[i + 2] * k);
      out[i + 1] = Math.round(src[i + 1] * k);
      out[i + 2] = Math.round(src[i] * k);
    }
    out[i + 3] = a;
  }
  return out;
}
