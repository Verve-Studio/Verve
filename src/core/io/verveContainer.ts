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

/**
 * A payload read from live memory while the document is written (a layer's
 * pixels) instead of copied up front, so saving never holds a second copy
 * of every layer.
 */
export interface LiveBlobSource {
  readonly byteLength: number;
  /** Deflate this payload (8-bit data) or store it raw (float data). */
  readonly deflate: boolean;
  /** The payload's current bytes. Valid only until the next await (the
   *  backing memory may move). Throws {@link DocumentChangedError} once the
   *  source no longer matches what was registered. */
  view(): Uint8Array;
}

/** The document changed while it was being saved; the save was cancelled. */
export class DocumentChangedError extends Error {
  constructor() {
    super("The document changed while it was being saved. Save again.");
    this.name = "DocumentChangedError";
  }
}

/** Receives the container bytes in order. The chunk may be kept (it is
 *  never written to again). */
export type VerveByteSink = (chunk: Uint8Array) => Promise<void>;

/** Raw blobs are written in pieces of at most this many bytes. */
const WRITE_CHUNK_BYTES = 64 * 1024 * 1024;

type BlobPayload = Uint8Array | LiveBlobSource;

const isLive = (p: BlobPayload): p is LiveBlobSource => !(p instanceof Uint8Array);

/** A copy of `bytes[start, end)` the sink may keep, without copying when the
 *  range already is the whole buffer (IPC clones a view's entire buffer). */
function ownedRange(bytes: Uint8Array, start: number, end: number): Uint8Array {
  if (
    start === 0 &&
    end === bytes.byteLength &&
    bytes.byteOffset === 0 &&
    bytes.buffer.byteLength === end
  ) {
    return bytes;
  }
  return bytes.slice(start, end);
}

/** Collects blobs while a document is being serialized. */
export class VerveBlobWriter {
  private readonly blobs: { payload: BlobPayload; deflate: boolean }[] = [];

  /** Register a payload and return the string to store in the JSON. 8-bit
   *  payloads are deflated; Float32 payloads are stored raw; live sources
   *  say which. */
  add(data: Uint8Array | Float32Array | LiveBlobSource): string {
    if (data instanceof Uint8Array) {
      this.blobs.push({ payload: data, deflate: true });
    } else if (data instanceof Float32Array) {
      this.blobs.push({
        payload: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        deflate: false,
      });
    } else {
      this.blobs.push({ payload: data, deflate: data.deflate });
    }
    return `${BLOB_PREFIX}${this.blobs.length - 1}`;
  }

  /**
   * Serialize `doc` plus the registered blobs into `sink`, in file order:
   * header, then each blob. The bytes are identical to building the whole
   * container in one buffer, but only the compressed 8-bit blobs and one
   * bounded chunk of a raw blob exist at a time.
   *
   * Every deflated payload is snapshotted synchronously on entry (the
   * compressor copies its input before the first await), so they all
   * reflect the moment `write` is called. Raw payloads are read chunk by
   * chunk; a live source that changes meanwhile throws
   * {@link DocumentChangedError}, which the caller turns into a cancelled
   * save.
   */
  async write(doc: object, sink: VerveByteSink): Promise<void> {
    const compressed: (Promise<Uint8Array> | null)[] = this.blobs.map((b) => {
      if (!b.deflate) return null;
      const bytes = isLive(b.payload) ? b.payload.view() : b.payload;
      return deflate(bytes, "deflate-raw");
    });
    const stored: (Uint8Array | null)[] = await Promise.all(compressed);

    const blobTable: BlobTableEntry[] = [];
    let blobSize = 0;
    this.blobs.forEach((b, i) => {
      const length = stored[i]?.byteLength ?? b.payload.byteLength;
      blobTable.push({ offset: blobSize, length, ...(b.deflate ? { deflated: true } : {}) });
      blobSize = align8(blobSize + length);
    });
    const json = new TextEncoder().encode(JSON.stringify({ ...doc, blobTable }));
    const blobStart = align8(MAGIC_BYTES.length + 4 + json.length);
    const header = new Uint8Array(blobStart);
    header.set(MAGIC_BYTES, 0);
    new DataView(header.buffer).setUint32(MAGIC_BYTES.length, json.length, true);
    header.set(json, MAGIC_BYTES.length + 4);
    await sink(header);

    for (let i = 0; i < this.blobs.length; i++) {
      const { payload } = this.blobs[i];
      const length = blobTable[i].length;
      const packed = stored[i];
      stored[i] = null; // drop each compressed blob once it is written
      for (let at = 0; at < length; at += WRITE_CHUNK_BYTES) {
        const end = Math.min(length, at + WRITE_CHUNK_BYTES);
        // Re-derive the view per chunk: a WASM-heap layer's memory can
        // move across the await.
        const bytes = packed ?? (isLive(payload) ? payload.view() : payload);
        await sink(ownedRange(bytes, at, end));
      }
      const pad = align8(length) - length;
      // Every blob, the last included, is padded to 8 bytes.
      if (pad > 0) await sink(new Uint8Array(pad));
    }
  }
}

export interface DecodedVerveContainer<T> {
  doc: T;
  /** Resolve a `"blob:<n>"` reference to its bytes, inflating compressed
   *  blobs. A raw (float) blob is a read-only view into the file buffer, not
   *  a copy. Throws if the value isn't a blob reference. */
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
      if (entry.deflated) return inflate(stored, "deflate-raw");
      // Raw blobs (float layers, the bulk of an HDR file) are views into the
      // file buffer: copies coexisted with the file, doubling peak memory
      // while opening. Layer init copies each payload into its layer buffer
      // and drops it from the bundle, so the views keep the file alive only
      // until the document is loaded. Blobs sit on 8-byte boundaries, so a
      // Float32Array view is aligned unless the file buffer itself is
      // offset oddly — then copy.
      return (stored.byteOffset & 7) === 0 ? stored : stored.slice();
    },
  };
}

export function isBlobRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(BLOB_PREFIX);
}
