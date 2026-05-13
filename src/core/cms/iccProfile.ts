// ─── ICC profile passthrough ─────────────────────────────────────────────────
//
// Tier-1 ICC support: extract the embedded ICC profile from a PNG/JPEG/TIFF
// file, embed one back on export, and read the profile's human-readable
// description for display. This module deliberately does **not** interpret
// the profile or perform any colour math — that lives in the (future) lcms2
// wrapper. The single goal here is round-trip preservation: a profile that
// arrived embedded must leave embedded, unchanged.
//
// Format details:
//   * PNG    — chunk type "iCCP" between IHDR and IDAT. Profile bytes are
//              zlib-deflated. We use the platform CompressionStream API so
//              no new dep is needed.
//   * JPEG   — APP2 marker(s) carrying "ICC_PROFILE\0" + seq + total + chunk.
//              Profiles >65519 bytes are split across multiple segments.
//   * TIFF   — tag 34675 (ICCProfile), type 7 (UNDEFINED), raw bytes. The
//              tag's value field is an offset to the profile elsewhere in
//              the file.
//
// On embed, any pre-existing profile chunk/marker/tag is stripped first so
// we never write a file with two competing profiles.

// ─── PNG CRC-32 ──────────────────────────────────────────────────────────────

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ─── zlib via platform CompressionStream (PNG iCCP only) ─────────────────────

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ─── PNG iCCP ────────────────────────────────────────────────────────────────

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false;
  return true;
}

function readUint32BE(b: Uint8Array, off: number): number {
  return (
    ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0
  );
}

export async function extractIccFromPng(
  png: Uint8Array,
): Promise<Uint8Array | null> {
  if (!isPng(png)) return null;
  let off = 8;
  while (off + 12 <= png.length) {
    const len = readUint32BE(png, off);
    const type = String.fromCharCode(
      png[off + 4], png[off + 5], png[off + 6], png[off + 7],
    );
    const dataOff = off + 8;
    if (type === "iCCP") {
      // Skip the null-terminated profile name (1-79 ASCII bytes).
      let nameEnd = dataOff;
      while (nameEnd < dataOff + len && png[nameEnd] !== 0) nameEnd++;
      if (nameEnd >= dataOff + len) return null;
      // After the null: 1 byte compression method (always 0), then deflated.
      if (png[nameEnd + 1] !== 0) return null;
      const compressed = png.subarray(nameEnd + 2, dataOff + len);
      try {
        return await inflate(compressed);
      } catch {
        return null;
      }
    }
    // IDAT/IEND mark the end of the metadata region — no profile present.
    if (type === "IDAT" || type === "IEND") return null;
    off = dataOff + len + 4; // skip data + CRC
  }
  return null;
}

export async function embedIccInPng(
  png: Uint8Array,
  profile: Uint8Array,
): Promise<Uint8Array> {
  if (!isPng(png)) return png;

  // Build the iCCP chunk data: name (ASCII) + null + compMethod=0 + deflated.
  const nameStr = "ICC Profile";
  const nameBytes = new Uint8Array(nameStr.length + 2);
  for (let i = 0; i < nameStr.length; i++) nameBytes[i] = nameStr.charCodeAt(i);
  // nameBytes[nameStr.length] = 0 (null terminator) — already zero
  // nameBytes[nameStr.length + 1] = 0 (compression method) — already zero
  const compressed = await deflate(profile);
  const data = concat([nameBytes, compressed]);

  // Chunk = length(4) + type(4) + data + CRC(4); CRC covers type + data.
  const typeAndData = new Uint8Array(4 + data.length);
  typeAndData[0] = 0x69; // 'i'
  typeAndData[1] = 0x43; // 'C'
  typeAndData[2] = 0x43; // 'C'
  typeAndData[3] = 0x50; // 'P'
  typeAndData.set(data, 4);
  const crc = crc32(typeAndData);
  const chunk = new Uint8Array(4 + 4 + data.length + 4);
  new DataView(chunk.buffer).setUint32(0, data.length, false);
  chunk.set(typeAndData, 4);
  new DataView(chunk.buffer).setUint32(4 + 4 + data.length, crc, false);

  // Walk chunks: strip existing iCCP/sRGB (our new iCCP supersedes both),
  // insert the new iCCP immediately after IHDR. Other chunks pass through.
  const out: Uint8Array[] = [png.subarray(0, 8)];
  let off = 8;
  let iccInserted = false;
  while (off + 12 <= png.length) {
    const len = readUint32BE(png, off);
    const type = String.fromCharCode(
      png[off + 4], png[off + 5], png[off + 6], png[off + 7],
    );
    const chunkEnd = off + 8 + len + 4;
    if (type === "iCCP" || type === "sRGB") {
      off = chunkEnd;
      continue;
    }
    out.push(png.subarray(off, chunkEnd));
    if (!iccInserted && type === "IHDR") {
      out.push(chunk);
      iccInserted = true;
    }
    off = chunkEnd;
  }
  if (!iccInserted) return png; // malformed PNG, give up cleanly
  return concat(out);
}

// ─── JPEG APP2 (ICC_PROFILE) ─────────────────────────────────────────────────

const ICC_HEADER = new TextEncoder().encode("ICC_PROFILE\0"); // 12 bytes

function isJpegSoi(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

export function extractIccFromJpeg(jpeg: Uint8Array): Uint8Array | null {
  if (!isJpegSoi(jpeg)) return null;
  const segments: { seq: number; data: Uint8Array }[] = [];
  let off = 2;
  while (off + 4 <= jpeg.length) {
    if (jpeg[off] !== 0xff) return null;
    const marker = jpeg[off + 1];
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
    if (marker >= 0xd0 && marker <= 0xd7) {
      off += 2; // RST markers have no length
      continue;
    }
    const segLen = (jpeg[off + 2] << 8) | jpeg[off + 3];
    if (segLen < 2) return null;
    const dataStart = off + 4;
    const dataEnd = off + 2 + segLen;
    if (marker === 0xe2 && dataEnd - dataStart >= ICC_HEADER.length + 2) {
      let isIcc = true;
      for (let i = 0; i < ICC_HEADER.length; i++) {
        if (jpeg[dataStart + i] !== ICC_HEADER[i]) {
          isIcc = false;
          break;
        }
      }
      if (isIcc) {
        const seq = jpeg[dataStart + ICC_HEADER.length];
        segments.push({
          seq,
          data: jpeg.subarray(dataStart + ICC_HEADER.length + 2, dataEnd),
        });
      }
    }
    off = dataEnd;
  }
  if (segments.length === 0) return null;
  segments.sort((a, b) => a.seq - b.seq);
  return concat(segments.map((s) => s.data));
}

export function embedIccInJpeg(
  jpeg: Uint8Array,
  profile: Uint8Array,
): Uint8Array {
  if (!isJpegSoi(jpeg)) return jpeg;

  // Build APP2 segments. Each segment carries marker(2) + length(2) +
  // header(12) + seq(1) + total(1) + chunk; segment length field is uint16,
  // so max chunk per segment = 65535 - 2 - 12 - 2 = 65519.
  const MAX_CHUNK = 65519;
  const total = Math.max(1, Math.ceil(profile.length / MAX_CHUNK));
  if (total > 255) return jpeg; // profile too large to legally embed
  const newSegments: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const chunk = profile.subarray(
      i * MAX_CHUNK,
      Math.min((i + 1) * MAX_CHUNK, profile.length),
    );
    const segLen = 2 + ICC_HEADER.length + 2 + chunk.length;
    const seg = new Uint8Array(2 + segLen);
    seg[0] = 0xff;
    seg[1] = 0xe2;
    seg[2] = (segLen >> 8) & 0xff;
    seg[3] = segLen & 0xff;
    seg.set(ICC_HEADER, 4);
    seg[4 + ICC_HEADER.length] = i + 1; // 1-based seq
    seg[4 + ICC_HEADER.length + 1] = total;
    seg.set(chunk, 4 + ICC_HEADER.length + 2);
    newSegments.push(seg);
  }

  // Walk existing markers: copy them through, strip any existing ICC APP2
  // segments, insert the new APP2 segments just before the first non-APP
  // marker (SOF/DQT/etc) — keeps any leading APP0 (JFIF) intact.
  const out: Uint8Array[] = [jpeg.subarray(0, 2)]; // SOI
  let off = 2;
  let iccInserted = false;
  while (off + 4 <= jpeg.length) {
    if (jpeg[off] !== 0xff) break;
    const marker = jpeg[off + 1];
    if (marker >= 0xd0 && marker <= 0xd7) {
      out.push(jpeg.subarray(off, off + 2));
      off += 2;
      continue;
    }
    const segLen = (jpeg[off + 2] << 8) | jpeg[off + 3];
    const segEnd = off + 2 + segLen;
    // Strip existing ICC APP2.
    if (marker === 0xe2 && segEnd - (off + 4) >= ICC_HEADER.length) {
      let isIcc = true;
      for (let i = 0; i < ICC_HEADER.length; i++) {
        if (jpeg[off + 4 + i] !== ICC_HEADER[i]) {
          isIcc = false;
          break;
        }
      }
      if (isIcc) {
        off = segEnd;
        continue;
      }
    }
    // Insert new segments before the first non-APPn marker.
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (!isApp && !iccInserted) {
      for (const s of newSegments) out.push(s);
      iccInserted = true;
    }
    out.push(jpeg.subarray(off, segEnd));
    if (marker === 0xda) {
      // SOS — everything after is entropy-coded scan data.
      out.push(jpeg.subarray(segEnd));
      off = jpeg.length;
      break;
    }
    off = segEnd;
  }
  if (!iccInserted) {
    for (const s of newSegments) out.push(s);
  }
  return concat(out);
}

// ─── PSD Image Resource 1039 (ICC Profile) ───────────────────────────────────
//
// The PSD format stores the document profile as one entry in the Image
// Resources block. ag-psd doesn't surface this resource in its typed API
// (it round-trips the bytes internally under a debug flag), so we walk
// the binary layout directly. Layout:
//
//   Header (26 bytes): "8BPS" + ... + uint16 mode
//   Color Mode Data:   uint32 len + bytes
//   Image Resources:   uint32 totalLen + resources[]
//
// Each resource: "8BIM" + uint16 id + pascalString name (padded to even,
// length-prefixed) + uint32 size + bytes (padded to even). ID 1039 holds
// the raw ICC profile bytes.

export function extractIccFromPsd(psd: Uint8Array): Uint8Array | null {
  if (
    psd.length < 26 ||
    psd[0] !== 0x38 || psd[1] !== 0x42 || psd[2] !== 0x50 || psd[3] !== 0x53
  ) return null; // not "8BPS"
  const view = new DataView(psd.buffer, psd.byteOffset, psd.byteLength);
  // Skip header (26 bytes) + Color Mode Data (uint32 length + bytes).
  let off = 26;
  if (off + 4 > psd.length) return null;
  const colorModeLen = view.getUint32(off, false);
  off += 4 + colorModeLen;
  if (off + 4 > psd.length) return null;
  const resourcesLen = view.getUint32(off, false);
  off += 4;
  const resourcesEnd = off + resourcesLen;
  if (resourcesEnd > psd.length) return null;
  while (off + 8 <= resourcesEnd) {
    // "8BIM" signature.
    if (
      psd[off] !== 0x38 || psd[off + 1] !== 0x42 ||
      psd[off + 2] !== 0x49 || psd[off + 3] !== 0x4d
    ) return null;
    const id = view.getUint16(off + 4, false);
    off += 6;
    // Pascal string (length byte + name), padded so total is even.
    const nameLen = psd[off];
    const nameBytes = 1 + nameLen;
    const namePadded = nameBytes + (nameBytes & 1 ? 1 : 0);
    off += namePadded;
    if (off + 4 > resourcesEnd) return null;
    const dataLen = view.getUint32(off, false);
    off += 4;
    if (off + dataLen > resourcesEnd) return null;
    if (id === 1039) return psd.slice(off, off + dataLen);
    // Data block is padded to even length.
    off += dataLen + (dataLen & 1 ? 1 : 0);
  }
  return null;
}

// ─── TIFF tag 34675 ──────────────────────────────────────────────────────────

function tiffEndianness(tiff: Uint8Array): boolean | null {
  if (tiff.length < 8) return null;
  if (tiff[0] === 0x49 && tiff[1] === 0x49) return true; // little-endian "II"
  if (tiff[0] === 0x4d && tiff[1] === 0x4d) return false; // big-endian "MM"
  return null;
}

export function extractIccFromTiff(tiff: Uint8Array): Uint8Array | null {
  const le = tiffEndianness(tiff);
  if (le === null) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (view.getUint16(2, le) !== 42) return null;
  const ifdOff = view.getUint32(4, le);
  if (ifdOff + 2 > tiff.length) return null;
  const entryCount = view.getUint16(ifdOff, le);
  for (let i = 0; i < entryCount; i++) {
    const e = ifdOff + 2 + i * 12;
    if (e + 12 > tiff.length) return null;
    if (view.getUint16(e, le) !== 34675) continue;
    const count = view.getUint32(e + 4, le);
    const dataOff = view.getUint32(e + 8, le);
    if (dataOff + count > tiff.length) return null;
    return tiff.slice(dataOff, dataOff + count);
  }
  return null;
}

export function embedIccInTiff(
  tiff: Uint8Array,
  profile: Uint8Array,
): Uint8Array {
  const le = tiffEndianness(tiff);
  if (le === null) return tiff;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (view.getUint16(2, le) !== 42) return tiff;
  const ifdOff = view.getUint32(4, le);
  if (ifdOff + 2 > tiff.length) return tiff;
  const entryCount = view.getUint16(ifdOff, le);
  if (ifdOff + 2 + entryCount * 12 + 4 > tiff.length) return tiff;

  type Entry = { tagId: number; type: number; count: number; value: Uint8Array };
  const entries: Entry[] = [];
  for (let i = 0; i < entryCount; i++) {
    const e = ifdOff + 2 + i * 12;
    const tagId = view.getUint16(e, le);
    if (tagId === 34675) continue; // strip existing ICC
    entries.push({
      tagId,
      type: view.getUint16(e + 2, le),
      count: view.getUint32(e + 4, le),
      value: tiff.slice(e + 8, e + 12),
    });
  }
  // Add new ICC entry; its value field is the offset where we append the
  // profile bytes, written below once the layout is known.
  entries.push({
    tagId: 34675,
    type: 7, // UNDEFINED
    count: profile.length,
    value: new Uint8Array(4),
  });
  entries.sort((a, b) => a.tagId - b.tagId);

  // Append a fresh IFD and the profile bytes at end-of-file, then rewrite
  // the header's IFD-offset to point at the new IFD. The original IFD
  // bytes stay in place (dead weight, fine for a one-shot post-process);
  // values referenced by surviving entries via external offsets keep
  // pointing at their existing locations because we never moved them.
  const newIfdSize = 2 + entries.length * 12 + 4;
  const ifdStart = (tiff.length + 1) & ~1; // align to even
  const profileStart = ifdStart + newIfdSize;
  const out = new Uint8Array(profileStart + profile.length);
  out.set(tiff, 0);
  const outView = new DataView(out.buffer);

  outView.setUint32(4, ifdStart, le);
  outView.setUint16(ifdStart, entries.length, le);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const eOff = ifdStart + 2 + i * 12;
    outView.setUint16(eOff, e.tagId, le);
    outView.setUint16(eOff + 2, e.type, le);
    outView.setUint32(eOff + 4, e.count, le);
    if (e.tagId === 34675) {
      outView.setUint32(eOff + 8, profileStart, le);
    } else {
      out.set(e.value, eOff + 8);
    }
  }
  outView.setUint32(ifdStart + 2 + entries.length * 12, 0, le); // next IFD = 0
  out.set(profile, profileStart);
  return out;
}

// ─── Profile description (for the Info panel) ────────────────────────────────
//
// The ICC profile header is 128 bytes; the magic 'acsp' lives at offset 36.
// At offset 128 is the tag table: count(uint32 BE) + entries(12 bytes each:
// signature(4) + offset(4) + size(4), all BE).
// We look up the 'desc' tag and parse its body:
//   * ICC v2 'desc' type: 'desc' + reserved(4) + asciiLen(u32) + ascii bytes
//   * ICC v4 'mluc' type: multi-localised — return the first record (UTF-16BE)

export function parseProfileDescription(profile: Uint8Array): string | null {
  if (profile.length < 128 + 4) return null;
  if (
    profile[36] !== 0x61 || profile[37] !== 0x63 ||
    profile[38] !== 0x73 || profile[39] !== 0x70
  ) return null; // not 'acsp'
  const view = new DataView(
    profile.buffer, profile.byteOffset, profile.byteLength,
  );
  const tagCount = view.getUint32(128, false);
  for (let i = 0; i < tagCount; i++) {
    const e = 132 + i * 12;
    if (e + 12 > profile.length) return null;
    if (
      profile[e] !== 0x64 || profile[e + 1] !== 0x65 ||
      profile[e + 2] !== 0x73 || profile[e + 3] !== 0x63
    ) continue; // not 'desc'
    const off = view.getUint32(e + 4, false);
    const size = view.getUint32(e + 8, false);
    if (off + size > profile.length || off + 16 > profile.length) return null;
    const type = String.fromCharCode(
      profile[off], profile[off + 1], profile[off + 2], profile[off + 3],
    );
    if (type === "desc") {
      const asciiLen = view.getUint32(off + 8, false);
      if (asciiLen === 0 || off + 12 + asciiLen > profile.length) return null;
      let end = off + 12 + asciiLen;
      while (end > off + 12 && profile[end - 1] === 0) end--;
      return new TextDecoder("ascii").decode(profile.subarray(off + 12, end));
    }
    if (type === "mluc") {
      const count = view.getUint32(off + 8, false);
      if (count === 0) return null;
      const recOff = off + 16;
      if (recOff + 12 > profile.length) return null;
      const len = view.getUint32(recOff + 4, false);
      const strOff = view.getUint32(recOff + 8, false);
      if (len === 0 || off + strOff + len > profile.length) return null;
      const bytes = profile.subarray(off + strOff, off + strOff + len);
      return new TextDecoder("utf-16be").decode(bytes).replace(/\0+$/, "");
    }
    return null;
  }
  return null;
}
