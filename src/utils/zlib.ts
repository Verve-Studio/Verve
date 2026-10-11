/**
 * zlib / raw-deflate via the platform `CompressionStream` API — native,
 * async, no dependency. `format` is `"deflate"` (zlib-wrapped, what PNG,
 * PDF and ICC chunks need) or `"deflate-raw"` (no header / checksum).
 */

type DeflateFormat = "deflate" | "deflate-raw";

function pipe(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform);
  return new Response(stream).arrayBuffer().then((b) => new Uint8Array(b));
}

export function deflate(
  bytes: Uint8Array,
  format: DeflateFormat = "deflate",
): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream(format));
}

export function inflate(
  bytes: Uint8Array,
  format: DeflateFormat = "deflate",
): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream(format));
}
