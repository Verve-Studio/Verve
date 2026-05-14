/**
 * Linked-layer rasteriser — paints the cached source image into a canvas-
 * sized buffer with the layer's `centerX/Y + scaleX/Y + rotation` transform
 * applied at draw time. The source file on disk is never modified; the
 * transform lives purely in the LinkedLayerState.
 *
 * Two-phase contract (mirrors `frameRasterizer`):
 *
 *   1. **`ensureLinkedDecoded(state, onReady)`** — reads the source file
 *      from disk if it isn't already cached, builds an `ImageBitmap`,
 *      and stashes it under `path:refreshNonce`. Calls `onReady` once the
 *      decode completes so the caller can re-rasterise.
 *   2. **`rasterizeLinkedToLayer(state, layer, format, swatches, cw, ch)`** —
 *      synchronous; reads the cached bitmap (or paints a checkerboard
 *      placeholder when nothing is cached yet) and writes pixels into
 *      `layer.data`.
 *
 * Bumping `refreshNonce` makes the rasteriser miss the cache on its next
 * pass — the freshly-decoded bitmap then replaces the stale entry.
 */
import type { LinkedLayerState, PixelFormat, RGBAColor } from "@/types";
import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { loadImagePixels, EXT_TO_MIME } from "@/core/io/imageLoader";
import {
  convertRgba8ToF32,
  convertF32ToRgba8,
} from "@/utils/pixelFormatConvert";
import { matchPaletteIndices } from "@/wasm";

// ─── Shared offscreen canvas ──────────────────────────────────────────────────

let _canvas: HTMLCanvasElement | null = null;
let _ctx: CanvasRenderingContext2D | null = null;

function getRasterCtx(w: number, h: number): CanvasRenderingContext2D {
  if (!_canvas) _canvas = document.createElement("canvas");
  if (_canvas.width !== w) _canvas.width = w;
  if (_canvas.height !== h) _canvas.height = h;
  if (!_ctx) _ctx = _canvas.getContext("2d", { willReadFrequently: true })!;
  return _ctx;
}

// ─── Decoded-source cache ─────────────────────────────────────────────────────

interface CacheEntry {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

interface CacheError {
  errorMessage: string;
}

/** Keyed by `${absolutePath}|${refreshNonce}`. A nonce bump invalidates the
 *  cached bitmap by virtue of changing the key. Stale entries are pruned
 *  on each successful decode for the same path. */
const _bitmapCache = new Map<string, CacheEntry>();
const _errorCache = new Map<string, CacheError>();
const _pendingDecodes = new Map<string, Promise<void>>();

function cacheKey(ls: LinkedLayerState): string {
  return `${ls.source.absolutePath}|${ls.refreshNonce}`;
}

function fileExtFromPath(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot).toLowerCase() : "";
}

/** Drop every cache entry for `path` whose nonce does NOT match `keepNonce`.
 *  Called after a successful decode so a refresh doesn't leak prior bitmaps. */
function pruneStale(path: string, keepNonce: number): void {
  const prefix = `${path}|`;
  for (const key of _bitmapCache.keys()) {
    if (key.startsWith(prefix) && key !== `${prefix}${keepNonce}`) {
      _bitmapCache.get(key)?.bitmap.close?.();
      _bitmapCache.delete(key);
    }
  }
  for (const key of _errorCache.keys()) {
    if (key.startsWith(prefix) && key !== `${prefix}${keepNonce}`) {
      _errorCache.delete(key);
    }
  }
}

/** Returns the cached decoded bitmap, or null if not ready yet. */
export function tryGetDecodedLinkedSource(
  ls: LinkedLayerState,
): CacheEntry | null {
  return _bitmapCache.get(cacheKey(ls)) ?? null;
}

/** Returns a cached load-error for this layer (set when a previous
 *  `ensureLinkedDecoded` failed), or null if there was none. The caller
 *  uses this to surface a user notification while still showing the
 *  placeholder. */
export function tryGetLinkedSourceError(
  ls: LinkedLayerState,
): CacheError | null {
  return _errorCache.get(cacheKey(ls)) ?? null;
}

/** Kick off a source-file decode for this linked layer if one isn't already
 *  cached. Call `onReady` when the bitmap becomes available; the caller is
 *  then expected to re-invoke `rasterizeLinkedToLayer`. Idempotent. */
export function ensureLinkedDecoded(
  ls: LinkedLayerState,
  readFileBase64: (path: string) => Promise<string>,
  onReady: () => void,
): void {
  const key = cacheKey(ls);
  if (_bitmapCache.has(key) || _errorCache.has(key)) return;
  const existing = _pendingDecodes.get(key);
  if (existing) {
    existing.then(onReady).catch(() => onReady());
    return;
  }
  const promise = (async (): Promise<void> => {
    const path = ls.source.absolutePath;
    try {
      const ext = fileExtFromPath(path);
      const mime = EXT_TO_MIME[ext] ?? "image/png";
      const base64 = await readFileBase64(path);
      const loaded = await loadImagePixels(
        `data:${mime};base64,${base64}`,
      );
      const u8 =
        loaded.isHdr
          ? convertF32ToRgba8(loaded.data as Float32Array)
          : (loaded.data as Uint8Array);
      const clamped = new Uint8ClampedArray(u8.length);
      clamped.set(u8);
      const imageData = new ImageData(clamped, loaded.width, loaded.height);
      const bitmap = await createImageBitmap(imageData);
      _bitmapCache.set(key, {
        bitmap,
        width: loaded.width,
        height: loaded.height,
      });
      pruneStale(path, ls.refreshNonce);
    } catch (e) {
      _errorCache.set(key, {
        errorMessage: `Linked source not found at ${path}: ${(e as Error).message ?? String(e)}`,
      });
    }
  })();
  _pendingDecodes.set(key, promise);
  promise.finally(() => {
    _pendingDecodes.delete(key);
    onReady();
  });
}

// ─── Placeholder ──────────────────────────────────────────────────────────────

function fillPlaceholder(
  data: Uint8Array | Float32Array,
  width: number,
  height: number,
  format: PixelFormat,
): void {
  if (format === "indexed8") {
    (data as Uint8Array).fill(255);
    return;
  }
  const CELL = 16;
  const a = format === "rgba32f" ? 1.0 : 255;
  const lightR = format === "rgba32f" ? 0.95 : 240;
  const lightG = format === "rgba32f" ? 0.6 : 150;
  const lightB = format === "rgba32f" ? 0.6 : 150;
  const darkR = format === "rgba32f" ? 0.7 : 180;
  const darkG = format === "rgba32f" ? 0.35 : 90;
  const darkB = format === "rgba32f" ? 0.35 : 90;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const isDark = (((x / CELL) | 0) + ((y / CELL) | 0)) & 1;
      const o = (y * width + x) * 4;
      data[o] = isDark ? darkR : lightR;
      data[o + 1] = isDark ? darkG : lightG;
      data[o + 2] = isDark ? darkB : lightB;
      data[o + 3] = a;
    }
  }
}

// ─── Rasterise ────────────────────────────────────────────────────────────────

/**
 * Synchronously paint the cached source bitmap (or a placeholder, if the
 * decode hasn't completed yet / failed) into the layer's canvas-sized
 * buffer with the layer's transform applied.
 */
export async function rasterizeLinkedToLayer(
  ls: LinkedLayerState,
  layer: GpuLayer,
  pixelFormat: PixelFormat,
  swatches: readonly RGBAColor[],
  canvasW: number,
  canvasH: number,
): Promise<void> {
  // Look up the bitmap for this exact (path, nonce). On a refresh-nonce bump
  // the new key misses while the new decode is in flight — fall back to the
  // most recent cached entry for the same path so the user sees the previous
  // pixels rather than a pink-checker flash. The placeholder is only painted
  // if there is genuinely no bitmap at all (e.g. very first layer creation
  // before the initial decode finishes, or the source file is missing).
  let entry = _bitmapCache.get(cacheKey(ls));
  if (!entry) {
    const prefix = `${ls.source.absolutePath}|`;
    for (const [key, value] of _bitmapCache) {
      if (key.startsWith(prefix)) {
        entry = value;
        break;
      }
    }
  }
  if (!entry) {
    fillPlaceholder(layer.data, canvasW, canvasH, pixelFormat);
    return;
  }

  // Paint into the offscreen 2D context with the transform applied.
  const ctx = getRasterCtx(canvasW, canvasH);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvasW, canvasH);
  ctx.translate(ls.centerX, ls.centerY);
  ctx.rotate((ls.rotation * Math.PI) / 180);
  ctx.scale(ls.scaleX, ls.scaleY);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(entry.bitmap, -entry.width / 2, -entry.height / 2);
  const rgba = ctx.getImageData(0, 0, canvasW, canvasH).data;

  // Format-convert into the layer buffer.
  if (pixelFormat === "rgba32f") {
    (layer.data as Float32Array).set(
      convertRgba8ToF32(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)),
    );
  } else if (pixelFormat === "indexed8") {
    const u8 = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    const indices = await matchPaletteIndices(
      u8,
      swatches as RGBAColor[],
      255,
    );
    (layer.data as Uint8Array).set(indices);
  } else {
    (layer.data as Uint8Array).set(
      new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    );
  }
}
