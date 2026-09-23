/**
 * In-process transfer store for rgba32f layer data during canvas remount.
 * Avoids the base64 encode/decode cycle (~576 MB of intermediaries for a 4K layer).
 * Entries are consumed once (take() deletes after reading).
 */
const pending = new Map<string, Float32Array>();

export const f32TransferStore = {
  set(layerId: string, data: Float32Array): void {
    pending.set(layerId, data);
  },
  take(layerId: string): Float32Array | undefined {
    const v = pending.get(layerId);
    pending.delete(layerId);
    return v;
  },
  clear(): void {
    pending.clear();
  },
  /** Drop every entry whose key starts with `prefix` (e.g. a closed tab's `${tabId}:`). */
  dropPrefix(prefix: string): void {
    for (const key of pending.keys()) {
      if (key.startsWith(prefix)) pending.delete(key);
    }
  },
};

/**
 * In-process transfer store for rgba8 layer data during canvas remount.
 * Same purpose as f32TransferStore — skips the PNG encode/decode round-trip.
 * Entries are consumed once (take() deletes after reading).
 */
const pendingU8 = new Map<string, Uint8Array>();

export const u8TransferStore = {
  set(layerId: string, data: Uint8Array): void {
    pendingU8.set(layerId, data);
  },
  take(layerId: string): Uint8Array | undefined {
    const v = pendingU8.get(layerId);
    pendingU8.delete(layerId);
    return v;
  },
  clear(): void {
    pendingU8.clear();
  },
  /** Drop every entry whose key starts with `prefix` (e.g. a closed tab's `${tabId}:`). */
  dropPrefix(prefix: string): void {
    for (const key of pendingU8.keys()) {
      if (key.startsWith(prefix)) pendingU8.delete(key);
    }
  },
};
