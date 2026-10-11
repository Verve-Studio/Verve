/**
 * Binary container for `.verve` documents.
 *
 * Earlier `.verve` files were one JSON string with every layer's pixels
 * inlined as base64. A 4096² rgba32f layer alone is ~341 MB of base64, so a
 * few of them push `JSON.stringify` past V8's maximum string length and the
 * document can't be saved (or re-opened) at all.
 *
 * Layout (little-endian):
 *
 *   [0..8)    magic "VERVEPK1"
 *   [8..12)   u32 byte length of the JSON header
 *   [12..)    UTF-8 JSON header (the same document object as before)
 *   padding   to an 8-byte boundary
 *   blobs     raw bytes, each starting on an 8-byte boundary
 *
 * Every binary payload (layer pixels in their native format, adjustment
 * masks, frame content, pixel brushes, the ICC profile) is stored as a blob
 * and referenced from the JSON as the string `"blob:<index>"`; the header's
 * `blobTable` holds each blob's `{ offset, length }` relative to the start
 * of the blob section, plus `deflated: true` when the blob is raw-deflate
 * compressed (8-bit data; float layers are stored raw so saving HDR
 * documents stays fast). Files without the magic are legacy JSON documents.
 */

import { deflate, inflate } from "@/utils/zlib";

const MAGIC = "VERVEPK1";
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
const BLOB_PREFIX = "blob:";

interface BlobTableEntry {
  offset: number;
  length: number;
  deflated?: boolean;
}

const align8 = (n: number): number => (n + 7) & ~7;

export function isVerveContainer(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC_BYTES.length + 4) return false;
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) return false;
  }
  return true;
}

/** Collects blobs while a document is being serialized. */
export class VerveBlobWriter {
  private readonly blobs: { bytes: Uint8Array; deflate: boolean }[] = [];

  /** Register a payload and return the string to store in the JSON. 8-bit
   *  payloads are deflated; Float32 payloads are stored raw. */
  add(data: Uint8Array | Float32Array): string {
    const isBytes = data instanceof Uint8Array;
    const bytes = isBytes
      ? data
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.blobs.push({ bytes, deflate: isBytes });
    return `${BLOB_PREFIX}${this.blobs.length - 1}`;
  }

  /** Serialize `doc` plus the registered blobs into one byte array. */
  async encode(doc: object): Promise<Uint8Array> {
    const stored = await Promise.all(
      this.blobs.map((b) => (b.deflate ? deflate(b.bytes, "deflate-raw") : b.bytes)),
    );
    const blobTable: BlobTableEntry[] = [];
    let blobSize = 0;
    stored.forEach((blob, i) => {
      blobTable.push({
        offset: blobSize,
        length: blob.byteLength,
        ...(this.blobs[i].deflate ? { deflated: true } : {}),
      });
      blobSize = align8(blobSize + blob.byteLength);
    });
    const json = new TextEncoder().encode(JSON.stringify({ ...doc, blobTable }));
    const blobStart = align8(MAGIC_BYTES.length + 4 + json.length);
    const out = new Uint8Array(blobStart + blobSize);
    out.set(MAGIC_BYTES, 0);
    new DataView(out.buffer).setUint32(MAGIC_BYTES.length, json.length, true);
    out.set(json, MAGIC_BYTES.length + 4);
    stored.forEach((blob, i) => {
      out.set(blob, blobStart + blobTable[i].offset);
    });
    return out;
  }
}

export interface DecodedVerveContainer<T> {
  doc: T;
  /** Resolve a `"blob:<n>"` reference to (a copy of) its bytes, inflating
   *  compressed blobs. Throws if the value isn't a blob reference. */
  blob: (ref: string) => Promise<Uint8Array>;
}

export function decodeVerveContainer<T>(
  bytes: Uint8Array,
): DecodedVerveContainer<T> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLen = view.getUint32(MAGIC_BYTES.length, true);
  const jsonStart = MAGIC_BYTES.length + 4;
  if (jsonStart + jsonLen > bytes.length) {
    throw new Error("The document is truncated (header exceeds file size).");
  }
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(jsonStart, jsonStart + jsonLen)),
  ) as T & { blobTable?: BlobTableEntry[] };
  const table = header.blobTable ?? [];
  const blobStart = align8(jsonStart + jsonLen);
  return {
    doc: header,
    blob: async (ref) => {
      if (!isBlobRef(ref)) throw new Error(`Not a blob reference: ${ref}`);
      const entry = table[Number(ref.slice(BLOB_PREFIX.length))];
      if (!entry) throw new Error(`The document references a missing blob (${ref}).`);
      const start = blobStart + entry.offset;
      if (start + entry.length > bytes.length) {
        throw new Error("The document is truncated (layer data exceeds file size).");
      }
      const stored = bytes.subarray(start, start + entry.length);
      // Raw blobs are copied: the result must own an aligned buffer
      // (Float32Array views need 4-byte alignment) and must not pin the
      // whole file in memory.
      return entry.deflated ? inflate(stored, "deflate-raw") : stored.slice();
    },
  };
}

export function isBlobRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(BLOB_PREFIX);
}
