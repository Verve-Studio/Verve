/**
 * Base64 for the few JSON files that embed small binary payloads (brush
 * libraries: `pixel-brushes.json`, `.pxbrush`, `.vbrush`). Use it only at
 * that file boundary: in memory, in `.verve` documents and over IPC, binary
 * data stays a typed array.
 */

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Throws on malformed input. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
