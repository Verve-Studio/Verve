import type { EffectRuntime } from "@/graphics/webgpu/EffectRuntime";
import { destroyTrackedTexture } from "@/core/store/memoryStore";

/**
 * Cross-frame cache for an effect's scratch textures, keyed by whatever
 * decides their shape (size, format, quality…).
 *
 * Replaces the old single-slot `texCache` pattern, which had two problems:
 *  - Two layers of the same effect with different keys (e.g. Bloom at Full
 *    and Quarter quality) made the second `encode` destroy textures the first
 *    had already recorded into the same, unsubmitted command encoder, so
 *    every `queue.submit` failed validation.
 *  - Eviction on "not encoded this frame" freed the textures on almost every
 *    frame, because the executor's output cache skips encoding most frames.
 *
 * Here every key gets its own entry. Entries idle for longer than `idleMs`
 * are released in `onFrameEnd` (which runs after submit, so destroying is
 * safe). When more than `maxEntries` keys are live, the least-recently-used
 * one is dropped from the map during encode and its textures are handed to
 * `runtime.pendingDestroyTextures`, which is flushed after submit.
 */
export class TextureSetCache<T extends Record<string, GPUTexture>> {
  private readonly entries = new Map<string, { set: T; lastUsed: number }>();

  constructor(
    private readonly idleMs = 10_000,
    private readonly maxEntries = 4,
  ) {}

  get(runtime: EffectRuntime, key: string, create: () => T): T {
    const now = performance.now();
    const hit = this.entries.get(key);
    if (hit) {
      hit.lastUsed = now;
      // Re-insert so Map iteration order is least- to most-recently used.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.set;
    }
    const set = create();
    this.entries.set(key, { set, lastUsed: now });
    while (this.entries.size > this.maxEntries) {
      const [oldestKey, oldest] = this.entries.entries().next().value as [
        string,
        { set: T; lastUsed: number },
      ];
      this.entries.delete(oldestKey);
      for (const tex of Object.values(oldest.set)) {
        runtime.pendingDestroyTextures.push(tex);
      }
    }
    return set;
  }

  /** Release entries unused for `idleMs`. Call from the effect's `onFrameEnd`. */
  onFrameEnd(): void {
    const cutoff = performance.now() - this.idleMs;
    for (const [key, entry] of this.entries) {
      if (entry.lastUsed >= cutoff) continue;
      for (const tex of Object.values(entry.set)) destroyTrackedTexture(tex);
      this.entries.delete(key);
    }
  }

  /** Release everything. Call from the effect's `onDestroy`. */
  destroyAll(): void {
    for (const entry of this.entries.values()) {
      for (const tex of Object.values(entry.set)) destroyTrackedTexture(tex);
    }
    this.entries.clear();
  }
}
