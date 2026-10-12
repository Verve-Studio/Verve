// Minimal GIF89a decoder for verifying encoder output in tests (no
// interlacing, no disposal compositing: each frame is returned as written).

export interface DecodedGifFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Frame delay in 1/100 s (Graphic Control Extension). */
  delayCs: number;
  transparentIndex: number | null;
  palette: Array<[number, number, number]>;
  /** One palette index per pixel. */
  indices: Uint8Array;
  /** Frame pixels as RGBA (transparent index → 0,0,0,0). */
  rgba: Uint8Array;
}

export interface DecodedGif {
  width: number;
  height: number;
  /** NETSCAPE2.0 loop count (0 = forever), null when absent. */
  loopCount: number | null;
  frames: DecodedGifFrame[];
}

function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = [];
    dict[eoi] = [];
    codeSize = minCodeSize + 1;
  };
  reset();
  let bitPos = 0;
  let prev: number[] | null = null;
  let o = 0;
  const totalBits = data.length * 8;
  while (bitPos + codeSize <= totalBits) {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const bit = (data[(bitPos + i) >> 3] >> ((bitPos + i) & 7)) & 1;
      code |= bit << i;
    }
    bitPos += codeSize;
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error("GIF: bad LZW code");
    for (const v of entry) if (o < pixelCount) out[o++] = v;
    if (prev) {
      dict.push([...prev, entry[0]]);
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  if (o !== pixelCount) throw new Error(`GIF: decoded ${o} of ${pixelCount} pixels`);
  return out;
}

export function decodeGif(bytes: Uint8Array): DecodedGif {
  const sig = new TextDecoder().decode(bytes.subarray(0, 6));
  if (sig !== "GIF89a" && sig !== "GIF87a") throw new Error("GIF: bad signature");
  const u16 = (o: number) => bytes[o] | (bytes[o + 1] << 8);
  const width = u16(6);
  const height = u16(8);
  const flags = bytes[10];
  let p = 13;
  const readPalette = (size: number): Array<[number, number, number]> => {
    const pal: Array<[number, number, number]> = [];
    for (let i = 0; i < size; i++) pal.push([bytes[p + i * 3], bytes[p + i * 3 + 1], bytes[p + i * 3 + 2]]);
    p += size * 3;
    return pal;
  };
  const globalPalette = flags & 0x80 ? readPalette(2 << (flags & 7)) : [];
  const readSubBlocks = (): Uint8Array => {
    const parts: number[] = [];
    while (bytes[p] !== 0) {
      const n = bytes[p++];
      for (let i = 0; i < n; i++) parts.push(bytes[p + i]);
      p += n;
    }
    p++;
    return Uint8Array.from(parts);
  };

  const frames: DecodedGifFrame[] = [];
  let loopCount: number | null = null;
  let delayCs = 0;
  let transparentIndex: number | null = null;
  for (;;) {
    const block = bytes[p++];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      const label = bytes[p++];
      const body = readSubBlocks();
      if (label === 0xf9) {
        delayCs = body[1] | (body[2] << 8);
        transparentIndex = body[0] & 1 ? body[3] : null;
      } else if (label === 0xff && new TextDecoder().decode(body.subarray(0, 11)) === "NETSCAPE2.0") {
        loopCount = body[12] | (body[13] << 8);
      }
      continue;
    }
    if (block !== 0x2c) throw new Error(`GIF: unexpected block 0x${block.toString(16)}`);
    const left = u16(p);
    const top = u16(p + 2);
    const w = u16(p + 4);
    const h = u16(p + 6);
    const iflags = bytes[p + 8];
    p += 9;
    if (iflags & 0x40) throw new Error("GIF: interlaced frames not supported");
    const palette = iflags & 0x80 ? readPalette(2 << (iflags & 7)) : globalPalette;
    const minCode = bytes[p++];
    const indices = lzwDecode(readSubBlocks(), minCode, w * h);
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const idx = indices[i];
      if (idx === transparentIndex) continue;
      const c = palette[idx] ?? [0, 0, 0];
      rgba.set([c[0], c[1], c[2], 255], i * 4);
    }
    frames.push({ left, top, width: w, height: h, delayCs, transparentIndex, palette, indices, rgba });
    delayCs = 0;
    transparentIndex = null;
  }
  return { width, height, loopCount, frames };
}
