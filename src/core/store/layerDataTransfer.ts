/**
 * In-process transfer store for rgba32f layer data during canvas remount.
 * Avoids the base64 encode/decode cycle (~576 MB of intermediaries for a 4K layer).
 * Entries are consumed once (take() deletes after reading).
 */
const pending = new Map<string, Float32Array>()

export const f32TransferStore = {
  set(layerId: string, data: Float32Array): void {
    pending.set(layerId, data)
  },
  take(layerId: string): Float32Array | undefined {
    const v = pending.get(layerId)
    pending.delete(layerId)
    return v
  },
  clear(): void {
    pending.clear()
  },
}
