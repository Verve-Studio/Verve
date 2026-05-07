/**
 * Tracks the running totals of bytes allocated by the parts of the app that
 * we directly control, split into two buckets:
 *
 *   - **CPU bucket** — typed arrays (layer pixel buffers, history snapshots,
 *     anything we allocate on the JS heap via `allocUint8`/`allocFloat32`).
 *     Always lives in main system RAM.
 *
 *   - **GPU bucket** — GPU textures owned by our renderer (layer textures,
 *     ping-pong, cache textures, encoder scratch textures, etc), allocated
 *     via `createTrackedTexture`. On dedicated-VRAM systems these live in
 *     VRAM and don't affect main-RAM pressure. On unified-memory systems
 *     (Apple Silicon, integrated GPUs) they share the same physical RAM.
 *
 * It does NOT track:
 * - WebGPU driver/internal allocations,
 * - DOM / canvas backing stores,
 * - JS heap not under our control (React tree, fibers, closures),
 * - Third-party WASM heap.
 *
 * ── Cap enforcement ─────────────────────────────────────────────────────────
 * One user-configured cap (`bufferMemoryBytes`) governs the budget. How it
 * applies depends on `unifiedMemory`:
 *
 *   - **Unified** (`unifiedMemory = true`, default on macOS / integrated
 *     GPUs): the cap covers `cpu + gpu` summed, because both compete for
 *     the same physical pool.
 *
 *   - **Discrete** (`unifiedMemory = false`, default on Windows/Linux):
 *     the cap covers only the CPU bucket. GPU textures are still tracked
 *     for diagnostics, but allocating one cannot exhaust the RAM budget
 *     because it lives in VRAM. We cannot know the true VRAM size from
 *     WebGPU, so we don't cap GPU allocations.
 *
 * ── Auto-release ────────────────────────────────────────────────────────────
 * Typed arrays are tracked via FinalizationRegistry so we automatically
 * reclaim bytes when the array is GC'd. GPU textures must be destroyed
 * explicitly via `destroyTrackedTexture`; we also register them with a
 * FinalizationRegistry as a safety net in case `.destroy()` is forgotten.
 */
import { preferencesStore } from "./preferencesStore";
import { useSyncExternalStore } from "react";

export type MemoryBucket = "cpu" | "gpu";

export class MemoryLimitError extends Error {
  constructor(
    public bucket: MemoryBucket,
    public requestedBytes: number,
    public currentBytes: number,
    public capBytes: number,
  ) {
    super(
      `Out of buffer memory: this allocation (${formatBytes(requestedBytes)}) would push ` +
        `total tracked memory past the ${formatBytes(capBytes)} limit ` +
        `(currently using ${formatBytes(currentBytes)}). ` +
        `Increase the limit in Preferences → Memory or enable “Max Out”.`,
    );
    this.name = "MemoryLimitError";
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

class MemoryStore {
  private cpu = 0;
  private gpu = 0;
  private listeners = new Set<() => void>();

  getCpu(): number {
    return this.cpu;
  }
  getGpu(): number {
    return this.gpu;
  }
  /** Bytes that count against the cap (cpu + gpu when unified, else cpu only). */
  getCapped(): number {
    return preferencesStore.get().unifiedMemory
      ? this.cpu + this.gpu
      : this.cpu;
  }

  /**
   * Reserve `n` bytes against the relevant cap. Returns true if the
   * allocation fits (or Max Out is enabled / bucket isn't capped). On true
   * the caller MUST follow through with the allocation; on false they MUST
   * NOT allocate.
   */
  tryAlloc(bucket: MemoryBucket, n: number): boolean {
    if (n <= 0) return true;
    if (this.fits(bucket, n)) {
      this.add(bucket, n);
      return true;
    }
    return false;
  }

  /** Reserve `n` bytes; throws `MemoryLimitError` if it doesn't fit. */
  alloc(bucket: MemoryBucket, n: number): void {
    if (n <= 0) return;
    if (!this.fits(bucket, n)) {
      const prefs = preferencesStore.get();
      throw new MemoryLimitError(
        bucket,
        n,
        this.getCapped(),
        prefs.bufferMemoryBytes,
      );
    }
    this.add(bucket, n);
  }

  release(bucket: MemoryBucket, n: number): void {
    if (n <= 0) return;
    if (bucket === "cpu") this.cpu = Math.max(0, this.cpu - n);
    else this.gpu = Math.max(0, this.gpu - n);
    this.notify();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private fits(bucket: MemoryBucket, n: number): boolean {
    const prefs = preferencesStore.get();
    if (prefs.bufferMemoryMaxOut) return true;
    // On discrete-GPU systems the GPU bucket is uncapped (we don't know the
    // real VRAM size, and the user's RAM cap shouldn't gate VRAM use).
    if (bucket === "gpu" && !prefs.unifiedMemory) return true;
    const projected = prefs.unifiedMemory
      ? this.cpu + this.gpu + n
      : this.cpu + n;
    return projected <= prefs.bufferMemoryBytes;
  }

  private add(bucket: MemoryBucket, n: number): void {
    if (bucket === "cpu") this.cpu += n;
    else this.gpu += n;
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }
}

export const memoryStore = new MemoryStore();

// ─── Auto-release tracking via FinalizationRegistry ──────────────────────────

interface ArrayHeld {
  bucket: MemoryBucket;
  bytes: number;
}
const arrayFinalizer = new FinalizationRegistry<ArrayHeld>(
  ({ bucket, bytes }) => {
    memoryStore.release(bucket, bytes);
  },
);

const textureBytesMap = new WeakMap<GPUTexture, number>();
const textureFinalizer = new FinalizationRegistry<number>((bytes) => {
  // Safety net only: if the caller forgot to call destroyTrackedTexture(),
  // the bytes still come back to us when the texture is GC'd. The actual
  // GPU memory is freed by WebGPU's own GC of unreferenced textures.
  memoryStore.release("gpu", bytes);
});

// ─── Typed array allocation helpers ──────────────────────────────────────────

/**
 * Allocate a Uint8Array under the CPU memory cap. Throws `MemoryLimitError`
 * if the allocation would exceed the cap. Auto-released on GC — callers
 * do not need to call `release()` manually.
 */
export function allocUint8(length: number): Uint8Array {
  memoryStore.alloc("cpu", length);
  let buf: Uint8Array;
  try {
    buf = new Uint8Array(length);
  } catch (e) {
    memoryStore.release("cpu", length);
    throw e;
  }
  arrayFinalizer.register(buf, { bucket: "cpu", bytes: length });
  return buf;
}

export function allocFloat32(length: number): Float32Array {
  const bytes = length * 4;
  memoryStore.alloc("cpu", bytes);
  let buf: Float32Array;
  try {
    buf = new Float32Array(length);
  } catch (e) {
    memoryStore.release("cpu", bytes);
    throw e;
  }
  arrayFinalizer.register(buf, { bucket: "cpu", bytes });
  return buf;
}

// ─── GPU texture helpers ─────────────────────────────────────────────────────

/** Bytes per pixel for a GPU texture format we use. */
function textureBytesPerPixel(format: GPUTextureFormat): number {
  switch (format) {
    case "rgba32float":
      return 16;
    case "rgba16float":
      return 8;
    case "rgba8unorm":
      return 4;
    case "rgba8snorm":
      return 4;
    case "r32float":
      return 4;
    case "rg32float":
      return 8;
    case "r8unorm":
      return 1;
    case "r16float":
      return 2;
    default:
      return 4;
  }
}

/** Compute byte size of a GPU texture (single mip, single layer). */
export function textureBytes(
  width: number,
  height: number,
  format: GPUTextureFormat,
): number {
  return (
    Math.max(0, width) * Math.max(0, height) * textureBytesPerPixel(format)
  );
}

/**
 * Create a GPU texture under the GPU memory cap. Throws `MemoryLimitError`
 * if the allocation would exceed the cap (only meaningful on unified-memory
 * systems — see `MemoryStore.fits` for the rule).
 */
export function createTrackedTexture(
  device: GPUDevice,
  desc: GPUTextureDescriptor,
): GPUTexture {
  const size = desc.size as GPUExtent3DDictStrict;
  const w = size.width ?? 0;
  const h = size.height ?? 1;
  const bytes = textureBytes(w, h, desc.format);

  memoryStore.alloc("gpu", bytes);
  let tex: GPUTexture;
  try {
    tex = device.createTexture(desc);
  } catch (e) {
    memoryStore.release("gpu", bytes);
    throw e;
  }
  textureBytesMap.set(tex, bytes);
  textureFinalizer.register(tex, bytes, tex);
  return tex;
}

/**
 * Destroy a tracked GPU texture and release its bytes from the budget.
 * Safe to call on an untracked texture (just calls `.destroy()`).
 */
export function destroyTrackedTexture(
  tex: GPUTexture | null | undefined,
): void {
  if (!tex) return;
  const bytes = textureBytesMap.get(tex);
  if (bytes !== undefined) {
    textureBytesMap.delete(tex);
    textureFinalizer.unregister(tex);
    memoryStore.release("gpu", bytes);
  }
  tex.destroy();
}

// ─── React hooks ─────────────────────────────────────────────────────────────

/**
 * Subscribe to the memory totals. Returns both buckets so consumers can
 * decide how to display them based on `unifiedMemory`.
 */
export function useTrackedMemory(): { cpu: number; gpu: number } {
  // Stable snapshot tuple via a ref-cached object so React's
  // useSyncExternalStore doesn't tear on every notify.
  return useSyncExternalStore(
    (cb) => memoryStore.subscribe(cb),
    snapshotMemory,
    snapshotMemory,
  );
}

let _lastCpu = -1;
let _lastGpu = -1;
let _lastSnap = { cpu: 0, gpu: 0 };
function snapshotMemory(): { cpu: number; gpu: number } {
  const cpu = memoryStore.getCpu();
  const gpu = memoryStore.getGpu();
  if (cpu !== _lastCpu || gpu !== _lastGpu) {
    _lastCpu = cpu;
    _lastGpu = gpu;
    _lastSnap = { cpu, gpu };
  }
  return _lastSnap;
}

/** Legacy alias — returns the capped total (cpu+gpu when unified, else cpu). */
export function useTrackedMemoryBytes(): number {
  return useSyncExternalStore(
    (cb) => memoryStore.subscribe(cb),
    () => memoryStore.getCapped(),
  );
}
