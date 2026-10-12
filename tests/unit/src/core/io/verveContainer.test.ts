// `.verve` binary container: framing, blob storage and error handling.
import { describe, expect, it } from "vitest";
import {
  decodeVerveContainer,
  DocumentChangedError,
  isBlobRef,
  isVerveContainer,
  VerveBlobWriter,
  type LiveBlobSource,
} from "@/core/io/verveContainer";

const MAGIC = "VERVEPK1";

/** Run the writer into one buffer, keeping the chunk boundaries too. */
async function writeAll(
  writer: VerveBlobWriter,
  doc: object,
): Promise<{ bytes: Uint8Array; chunks: Uint8Array[] }> {
  const chunks: Uint8Array[] = [];
  await writer.write(doc, async (c) => {
    chunks.push(c);
  });
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { bytes, chunks };
}

function headerOf(bytes: Uint8Array): {
  json: Record<string, unknown> & { blobTable: { offset: number; length: number; deflated?: boolean }[] };
  jsonLen: number;
  blobStart: number;
} {
  const jsonLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + jsonLen)));
  return { json, jsonLen, blobStart: (12 + jsonLen + 7) & ~7 };
}

/** A live source over a buffer, like the canvas exposes layer pixels. */
function live(data: Uint8Array | Float32Array, deflate: boolean): LiveBlobSource {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return { byteLength: bytes.byteLength, deflate, view: () => bytes };
}

const compressible = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i >> 6) & 0xff;
  return out;
};

describe("isVerveContainer", () => {
  it("recognises the magic and rejects legacy JSON and short input", () => {
    const ok = new Uint8Array(16);
    ok.set(new TextEncoder().encode(MAGIC));
    expect(isVerveContainer(ok)).toBe(true);
    expect(isVerveContainer(new TextEncoder().encode('{"version":6,"layers":[]}'))).toBe(false);
    expect(isVerveContainer(new TextEncoder().encode(MAGIC))).toBe(false); // no length field
    expect(isVerveContainer(new Uint8Array(0))).toBe(false);
  });
});

describe("VerveBlobWriter / decodeVerveContainer", () => {
  it("round-trips the document and every blob kind exactly", async () => {
    const u8 = compressible(1000);
    const f32 = new Float32Array([0, 1, 2.5, 1e6, -0, Number.MIN_VALUE, 65504, 0.1]);
    const liveRaw = new Float32Array([3.25, 4, 5, 6]);
    const liveDeflated = new Uint8Array([9, 8, 7, 6, 5]);
    const empty = new Uint8Array(0);

    const w = new VerveBlobWriter();
    const refs = {
      u8: w.add(u8),
      f32: w.add(f32),
      liveRaw: w.add(live(liveRaw, false)),
      liveDeflated: w.add(live(liveDeflated, true)),
      empty: w.add(empty),
    };
    expect(Object.values(refs)).toEqual(["blob:0", "blob:1", "blob:2", "blob:3", "blob:4"]);
    for (const r of Object.values(refs)) expect(isBlobRef(r)).toBe(true);

    const doc = { version: 7, name: "Ünïcode ✓", refs, nested: { list: [1, 2, 3] } };
    const { bytes } = await writeAll(w, doc);
    expect(isVerveContainer(bytes)).toBe(true);

    const decoded = decodeVerveContainer<typeof doc>(bytes);
    expect(decoded.doc.version).toBe(7);
    expect(decoded.doc.name).toBe("Ünïcode ✓");
    expect(decoded.doc.nested).toEqual({ list: [1, 2, 3] });

    expect(await decoded.blob(refs.u8)).toEqual(u8);
    const f = await decoded.blob(refs.f32);
    expect(Array.from(new Float32Array(f.buffer, f.byteOffset, f.byteLength / 4))).toEqual(Array.from(f32));
    expect(Object.is(new Float32Array(f.buffer, f.byteOffset, 8)[4], -0)).toBe(true);
    const lr = await decoded.blob(refs.liveRaw);
    expect(Array.from(new Float32Array(lr.buffer, lr.byteOffset, 4))).toEqual([3.25, 4, 5, 6]);
    expect(await decoded.blob(refs.liveDeflated)).toEqual(liveDeflated);
    expect((await decoded.blob(refs.empty)).byteLength).toBe(0);
  });

  it("frames the file as magic | u32 LE json length | json | 8-aligned blobs", async () => {
    const w = new VerveBlobWriter();
    w.add(new Float32Array([1, 2, 3])); // 12 bytes raw → padded to 16
    w.add(compressible(4096)); // deflated
    w.add(new Float32Array([4])); // 4 bytes raw
    const { bytes } = await writeAll(w, { a: 1 });

    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe(MAGIC);
    const { json, blobStart } = headerOf(bytes);
    expect(json.a).toBe(1);
    expect(blobStart % 8).toBe(0);
    const table = json.blobTable;
    expect(table).toHaveLength(3);
    expect(table[0]).toEqual({ offset: 0, length: 12 });
    expect(table[1].offset).toBe(16);
    expect(table[1].deflated).toBe(true);
    // 8-bit data is compressed; float data is stored raw.
    expect(table[1].length).toBeLessThan(4096);
    expect(table[2].deflated).toBeUndefined();
    for (const e of table) expect(e.offset % 8).toBe(0);
    // Every blob, including the last, is padded to 8 bytes.
    const last = table[2];
    expect(bytes.length).toBe(blobStart + ((last.offset + last.length + 7) & ~7));
    // The raw float blob sits verbatim in the file.
    const raw = bytes.slice(blobStart, blobStart + 12);
    expect(Array.from(new Float32Array(raw.buffer))).toEqual([1, 2, 3]);
  });

  it("returns raw blobs as zero-copy views into an aligned file buffer", async () => {
    const w = new VerveBlobWriter();
    const ref = w.add(new Float32Array([1, 2]));
    const { bytes } = await writeAll(w, {});
    const view = await decodeVerveContainer(bytes).blob(ref);
    expect(view.buffer).toBe(bytes.buffer);
    expect(view.byteOffset % 8).toBe(0);
  });

  it("copies raw blobs when the file buffer is oddly offset, so Float32 views stay valid", async () => {
    const w = new VerveBlobWriter();
    const ref = w.add(new Float32Array([7.5, -1]));
    const { bytes } = await writeAll(w, {});
    const host = new Uint8Array(bytes.length + 3);
    host.set(bytes, 3);
    const shifted = host.subarray(3);
    const blob = await decodeVerveContainer(shifted).blob(ref);
    expect(blob.byteOffset % 4).toBe(0);
    expect(Array.from(new Float32Array(blob.buffer, blob.byteOffset, 2))).toEqual([7.5, -1]);
  });

  it("writes an empty document (no blobs)", async () => {
    const { bytes } = await writeAll(new VerveBlobWriter(), { layers: [] });
    const d = decodeVerveContainer<{ layers: unknown[]; blobTable: unknown[] }>(bytes);
    expect(d.doc.layers).toEqual([]);
    expect(d.doc.blobTable).toEqual([]);
    expect(bytes.length % 8).toBe(0);
  });

  it("is byte-identical across writes of the same input", async () => {
    const make = () => {
      const w = new VerveBlobWriter();
      w.add(compressible(300));
      w.add(new Float32Array([1, 2, 3]));
      return w;
    };
    const a = await writeAll(make(), { x: 1 });
    const b = await writeAll(make(), { x: 1 });
    expect(a.bytes).toEqual(b.bytes);
  });

  it("snapshots deflated live payloads when write() starts", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const w = new VerveBlobWriter();
    const ref = w.add(live(data, true));
    const chunks: Uint8Array[] = [];
    const done = w.write({}, async (c) => {
      chunks.push(c.slice());
    });
    data.fill(0); // mutate after write() was called
    await done;
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    expect(Array.from(await decodeVerveContainer(bytes).blob(ref))).toEqual([1, 2, 3, 4]);
  });

  it("propagates DocumentChangedError from a live source and stops writing", async () => {
    const w = new VerveBlobWriter();
    w.add(new Uint8Array([1]));
    w.add({
      byteLength: 8,
      deflate: false,
      view: () => {
        throw new DocumentChangedError();
      },
    });
    const sunk: Uint8Array[] = [];
    await expect(w.write({}, async (c) => void sunk.push(c))).rejects.toBeInstanceOf(DocumentChangedError);
    // Header and the first blob may have gone out; the raw blob never did.
    const written = sunk.reduce((n, c) => n + c.length, 0);
    const { blobStart } = headerOf(sunk[0]);
    expect(written).toBeLessThanOrEqual(blobStart + 16);
  });

  it("propagates sink failures", async () => {
    const w = new VerveBlobWriter();
    w.add(new Float32Array(4));
    await expect(
      w.write({}, async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
  });

  it("never stores pixel payloads as base64 / data URLs in the header", async () => {
    const w = new VerveBlobWriter();
    const pixels = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7919) & 0xff;
    const ref = w.add(pixels);
    const { bytes } = await writeAll(w, { layers: [{ id: "a", pixels: { data: ref } }] });
    const { json, jsonLen } = headerOf(bytes);
    expect(jsonLen).toBeLessThan(200);
    const text = JSON.stringify(json);
    expect(text).not.toMatch(/data:|base64|[A-Za-z0-9+/]{64,}/);
  });
});

describe("decodeVerveContainer errors", () => {
  async function sample(): Promise<{ bytes: Uint8Array; refs: string[] }> {
    const w = new VerveBlobWriter();
    const refs = [w.add(compressible(2000)), w.add(new Float32Array(64))];
    return { bytes: (await writeAll(w, { v: 1 })).bytes, refs };
  }

  it("rejects a header length that runs past the end of the file", async () => {
    const { bytes } = await sample();
    const cut = bytes.slice(0, 20);
    expect(() => decodeVerveContainer(cut)).toThrow(/truncated/);
  });

  it("rejects truncated blob data when the blob is read", async () => {
    const { bytes, refs } = await sample();
    const { blobStart, json } = headerOf(bytes);
    const end = blobStart + json.blobTable[1].offset + 10;
    const d = decodeVerveContainer(bytes.slice(0, end));
    await expect(d.blob(refs[1])).rejects.toThrow(/truncated/);
  });

  it("rejects references to missing blobs and non-references", async () => {
    const { bytes } = await sample();
    const d = decodeVerveContainer(bytes);
    await expect(d.blob("blob:99")).rejects.toThrow(/missing blob/);
    await expect(d.blob("blob:-1")).rejects.toThrow(/missing blob/);
    await expect(d.blob("iVBORw0KGgo=")).rejects.toThrow(/Not a blob reference/);
  });

  it("rejects corrupt compressed data", async () => {
    const { bytes, refs } = await sample();
    const { blobStart, json } = headerOf(bytes);
    const bad = bytes.slice();
    const e = json.blobTable[0];
    bad.fill(0xff, blobStart + e.offset, blobStart + e.offset + e.length);
    await expect(decodeVerveContainer(bad).blob(refs[0])).rejects.toThrow();
  });

  it("rejects a corrupt JSON header", async () => {
    const { bytes } = await sample();
    const bad = bytes.slice();
    bad[12] = "!".charCodeAt(0);
    expect(() => decodeVerveContainer(bad)).toThrow(SyntaxError);
  });
});
