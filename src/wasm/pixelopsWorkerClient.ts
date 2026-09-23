/**
 * Off-main-thread versions of the long-running WASM operations. Content-Aware
 * Fill (PatchMatch), whole-image GrabCut and palette quantization used to run
 * on the UI thread and froze the app for their whole duration.
 *
 * One worker (with its own pixelops instance) is started on first use and
 * terminated after a minute without work — which also returns its WASM heap
 * to the OS (a WASM heap only ever grows while its instance lives).
 *
 * Inputs are copied into the worker (the caller keeps its buffers); results
 * are transferred back without a copy.
 */
import type { PixelopsWorkerJob } from "./pixelopsWorker";

const IDLE_TERMINATE_MS = 60_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function failAll(err: Error): void {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./pixelopsWorker.ts", import.meta.url), {
    type: "module",
  });
  w.onmessage = (
    e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>,
  ) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.result);
    else p.reject(new Error(e.data.error ?? "Image operation failed"));
    scheduleIdleTerminate();
  };
  w.onerror = (e) => {
    // A crashed worker (e.g. the WASM module aborted) is replaced on the
    // next request.
    worker = null;
    w.terminate();
    failAll(new Error(e.message || "The image-processing worker stopped"));
  };
  worker = w;
  return w;
}

function scheduleIdleTerminate(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (pending.size > 0 || !worker) return;
    worker.terminate();
    worker = null;
  }, IDLE_TERMINATE_MS);
}

function run<T>(job: PixelopsWorkerJob): Promise<T> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const w = getWorker();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    w.postMessage({ id, job });
  });
}

/** `inpaintRegion` in the worker. */
export function inpaintRegionOffThread(
  pixels: Uint8Array,
  width: number,
  height: number,
  mask: Uint8Array,
  sourceMask?: Uint8Array,
): Promise<Uint8Array> {
  return run({ op: "inpaint", pixels, width, height, mask, sourceMask });
}

/** `quantize` in the worker. */
export function quantizeOffThread(
  pixels: Uint8Array,
  maxColors: number,
): Promise<{ palette: Uint8Array; count: number }> {
  return run({ op: "quantize", pixels, maxColors });
}

/** `grabCut` (all-WASM path) in the worker. */
export function grabCutOffThread(
  pixels: Uint8Array,
  width: number,
  height: number,
  trimap: Uint8Array,
  iterations = 3,
  k = 5,
): Promise<Uint8Array> {
  return run({ op: "grabcut", pixels, width, height, trimap, iterations, k });
}
