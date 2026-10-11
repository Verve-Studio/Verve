import type {
  WebGPURenderer,
  GpuLayer,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import { srgbToLinearChannel } from "@/utils/pixelFormatConvert";
import { allocUint8 } from "@/core/store/memoryStore";
import type { RGBAColor } from "@/types";

// Selection mask shorthand used by draw/erase helpers.
export type SelMask = { mask: Uint8Array; width: number };

/**
 * Per-stroke "max-coverage-so-far" buffer keyed by canvas pixel index.
 *
 * Replaces the prior `Map<number, number>` representation. The Map became
 * a hot bottleneck on big brush strokes — large bitmap-backed Maps degrade
 * to ~100–300 ns per get/set, dwarfing the actual blend math. A flat
 * `Uint8Array` indexed by `y * width + x` reads/writes in ~5–10 ns and
 * the 0–255 quantisation is well below the visible threshold for stroke
 * alpha (Photoshop uses 8-bit internally for the same purpose).
 *
 * Allocation: one buffer per renderer, shared across tools (only one
 * stroke is active at a time). Reset via `clearTouchedBuffer` at
 * `strokeStart` — `Uint8Array.fill(0)` is memcpy-speed (~0.5 ms for a
 * 4K canvas).
 */
export interface TouchedBuffer {
  /** Quantised max coverage per pixel, 0..255. Index = y * width + x. */
  data: Uint8Array;
  /** Canvas width in pixels — same as the indexer's stride. */
  width: number;
  /** Canvas height — only used for sanity checks; index math relies on width. */
  height: number;
  /** WASM-heap pointer when `data` is a view into WASM linear memory.
   *  Undefined when the buffer lives on the JS heap (WASM unavailable or
   *  alloc fell back). The brush kernel checks this to decide between
   *  the zero-copy fast path and the slice-marshalling fallback. */
  wasmPtr?: number;
  /**
   * Canvas-space bbox of pixels that the LAST stroke actually wrote to.
   * `acquireTouchedBuffer` uses this to scope the per-stroke reset —
   * clearing just the previous stroke's footprint instead of the entire
   * canvas-sized buffer (70 MB at A1, ~2 ms per stroke start). Tools
   * that paint into touched (currently only Brush) update it on stroke
   * end. Tools that don't update it cause a full fill — same as before.
   */
  lastDirtyRect?: { lx: number; ly: number; rx: number; ry: number };
  /**
   * Bounding box (canvas space, inclusive) of every write made through the
   * shared JS writers (`noteTouchedWrite`) since the last acquire, so the
   * next stroke clears only that region — pencil / eraser / dodge used to
   * force a full canvas-sized clear on every stroke start.
   */
  wx0: number;
  wy0: number;
  wx1: number;
  wy1: number;
  /** Set when something wrote without recording a box (the WASM brush
   *  kernel); unless `lastDirtyRect` covers it, the next acquire clears the
   *  whole buffer. */
  untracked: boolean;
}

/** Record a write at canvas (x, y) into the buffer's write box. */
export function noteTouchedWrite(buf: TouchedBuffer, x: number, y: number): void {
  if (x < buf.wx0) buf.wx0 = x;
  if (x > buf.wx1) buf.wx1 = x;
  if (y < buf.wy0) buf.wy0 = y;
  if (y > buf.wy1) buf.wy1 = y;
}

/** Reset the write box / untracked flag (after the buffer was cleared). */
export function resetTouchedWrites(buf: TouchedBuffer): void {
  buf.wx0 = Infinity;
  buf.wy0 = Infinity;
  buf.wx1 = -1;
  buf.wy1 = -1;
  buf.untracked = false;
}

export function makeTouchedBuffer(
  width: number,
  height: number,
): TouchedBuffer {
  // `allocUint8` (not `new Uint8Array`) so the per-renderer touched buffer
  // counts against the CPU bucket like every other typed-array allocation
  // we own. At canvas resolution this is a meaningful chunk (70 MB on A1)
  // — leaving it untracked under-reports total RAM use whether or not the
  // buffer subsequently gets pinned to the WASM heap (the WASM pin
  // tracks separately and balances out when the JS array is GC'd).
  return {
    data: allocUint8(width * height),
    width,
    height,
    wx0: Infinity,
    wy0: Infinity,
    wx1: -1,
    wy1: -1,
    untracked: false,
  };
}

export function clearTouchedBuffer(buf: TouchedBuffer): void {
  buf.data.fill(0);
}

/** Mark the layer-local intersection of canvas rect [x0, x1) × [y0, y1). */
function markClippedCanvasRect(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const lx = Math.max(0, x0 - layer.offsetX);
  const ly = Math.max(0, y0 - layer.offsetY);
  const rx = Math.min(layer.layerWidth, x1 - layer.offsetX);
  const ry = Math.min(layer.layerHeight, y1 - layer.offsetY);
  if (rx > lx && ry > ly) renderer.markDirtyRect(layer, lx, ly, rx, ry);
}

/**
 * Mark a canvas-space rect [x0, x1) × [y0, y1) dirty on `layer` (clipped to
 * the layer), so the next flush uploads just that patch. In tiled mode writes
 * wrap around the canvas edges: the rect is split into its (up to 4) wrapped
 * pieces. Every pixel write must be covered by a mark before the flush — a
 * flush with nothing pending falls back to a full-layer upload.
 */
export function markCanvasRectDirty(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  tiled: boolean,
): void {
  x0 = Math.floor(x0);
  y0 = Math.floor(y0);
  x1 = Math.ceil(x1);
  y1 = Math.ceil(y1);
  if (x1 <= x0 || y1 <= y0) return;
  if (!tiled) {
    markClippedCanvasRect(renderer, layer, x0, y0, x1, y1);
    return;
  }
  const W = renderer.pixelWidth;
  const H = renderer.pixelHeight;
  // Wrapped spans along each axis (allocation-free: at most two per axis).
  let ax0: number, ax1: number, bx0 = 0, bx1 = 0;
  if (x1 - x0 >= W) {
    ax0 = 0;
    ax1 = W;
  } else {
    ax0 = ((x0 % W) + W) % W;
    ax1 = ax0 + (x1 - x0);
    if (ax1 > W) {
      bx1 = ax1 - W;
      ax1 = W;
    }
  }
  let ay0: number, ay1: number, by0 = 0, by1 = 0;
  if (y1 - y0 >= H) {
    ay0 = 0;
    ay1 = H;
  } else {
    ay0 = ((y0 % H) + H) % H;
    ay1 = ay0 + (y1 - y0);
    if (ay1 > H) {
      by1 = ay1 - H;
      ay1 = H;
    }
  }
  markClippedCanvasRect(renderer, layer, ax0, ay0, ax1, ay1);
  if (bx1 > bx0) markClippedCanvasRect(renderer, layer, bx0, ay0, bx1, ay1);
  if (by1 > by0) {
    markClippedCanvasRect(renderer, layer, ax0, by0, ax1, by1);
    if (bx1 > bx0) markClippedCanvasRect(renderer, layer, bx0, by0, bx1, by1);
  }
}

/**
 * Flush `layer` only when something is pending. A flush with nothing pending
 * falls back to a full-layer upload (and a full history snapshot + full
 * recomposite), e.g. when a previous event already uploaded the patch.
 */
export function flushIfPending(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  palette?: readonly RGBAColor[],
): void {
  if (renderer.hasPendingUpload(layer)) renderer.flushLayer(layer, palette);
}

/**
 * Convert an `RGBAColor` (sRGB-encoded floats in `[0, 1]` — what the colour
 * picker / state stores) into linear-light floats suitable for painting on
 * an `rgba32f` layer. RGB channels go through the sRGB transfer function;
 * alpha is already linear and passes through unchanged.
 *
 * Tools that paint into f32 layers should use this when constructing the
 * `srcFloat` argument to {@link blendPixelOver} — passing sRGB values into
 * a linear-light layer would compress shadows and lift midtones.
 */
export function srgbColorToLinearF32(c: {
  r: number;
  g: number;
  b: number;
  a: number;
}): [number, number, number, number] {
  return [
    srgbToLinearChannel(c.r),
    srgbToLinearChannel(c.g),
    srgbToLinearChannel(c.b),
    c.a,
  ];
}

/**
 * Bresenham's line algorithm — plots every integer pixel between (x0,y0) and
 * (x1,y1) inclusive, calling `plot` for each.
 */
export function bresenham(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  plot: (x: number, y: number) => void,
): void {
  // Integer grid only. Fractional endpoints (e.g. smoothed-curve midpoints)
  // used to make the exact-equality exit unreachable — an infinite loop
  // that froze the app — and NaN (degenerate brush data) did the same.
  if (
    !Number.isFinite(x0) ||
    !Number.isFinite(y0) ||
    !Number.isFinite(x1) ||
    !Number.isFinite(y1)
  )
    return;
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0),
    sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0),
    sy = y0 < y1 ? 1 : -1;
  let err = dx + dy,
    x = x0,
    y = y0;
  // A Bresenham line visits exactly max(|dx|,|dy|)+1 pixels.
  let steps = Math.max(dx, -dy) + 1;

  while (steps-- > 0) {
    plot(x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/**
 * Stochastic-rounding offset for 8-bit writes at canvas (x, y): a hash in
 * [1e-4, 1 − 1e-4) so `floor(v + bias)` rounds up with probability equal to
 * the fraction (an exact level stays put). Mirrors `dither_u` /
 * `dither_bias` in wasm/src/brush_stamp.cpp.
 */
export function ditherBias(x: number, y: number, seed: number): number {
  let h =
    Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(seed, 0xcb1ab31f);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return 0.0001 + ((h >>> 8) / 16777216) * 0.9998;
}

/** Smallest 8-bit level ≥ x (0..1, with a little float slack). */
function ceilByte(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 255;
  return Math.min(255, Math.max(0, Math.ceil(x * 255 - 0.001)));
}

/**
 * Porter-Duff "over" composite with incremental coverage tracking.
 * canvasX/canvasY are CANVAS-SPACE coordinates. Translates to layer-local
 * internally. Silently ignores pixels outside the layer buffer.
 *
 * `touched` is a Map from canvas-pixel-key → max effective-alpha applied.
 * When provided, two cases:
 *
 *  1. `capOpacity` undefined (default — pencil, eraser, every non-flow path):
 *     The per-stamp opacity *is* the per-stroke ceiling. If srcA <= existing,
 *     skip; otherwise upgrade existing to srcA via the incremental alpha
 *     `(srcA - existingA) / (1 - existingA)`. This prevents accumulation
 *     while allowing AA coverage to be upgraded (fixes ring artifacts from
 *     overlapping AA capsule segments).
 *
 *  2. `capOpacity` provided (brush stamp engine with Flow < Opacity):
 *     The per-stamp `opacity` is just per-stamp paint *deposit* (Flow);
 *     `capOpacity` is the per-stroke ceiling (the brush's Opacity). Each
 *     stamp deposits `min(srcA, upgrade-to-cap)` so overlapping stamps
 *     accumulate via Porter-Duff `over` toward the ceiling instead of
 *     reaching it on first contact. With `capOpacity === opacity` this
 *     reduces exactly to case 1.
 */
export function blendPixelOver(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  canvasX: number,
  canvasY: number,
  r: number,
  g: number,
  b: number,
  a: number,
  opacity: number, // 0-100, already includes geometric coverage for AA paths
  touched?: TouchedBuffer,
  sel?: SelMask,
  tiledW?: number,
  tiledH?: number,
  /** Native **linear-light** float `[r, g, b, a]` for rgba32f layers
   * (values in `[0, ∞)`; ≥ 1 for HDR). When the caller has an sRGB-encoded
   * colour (e.g. straight from the colour picker / state), it must be
   * gamma-decoded before being passed here — see {@link srgbColorToLinearF32}.
   * When provided, bypasses the r/g/b/a ÷ 255 normalisation so no precision
   * is lost. Ignored for rgba8 and indexed8 layers. */
  srcFloat?: readonly [number, number, number, number],
  /** When true, the per-stroke alpha cap from `touched` is skipped (so a
   *  smudge stamp can re-blend over a previously stamped pixel) but the
   *  map is still updated with `max(existing, srcA)`, preserving its role
   *  as the stroke silhouette for downstream effects (wet edges). */
  bypassTouchedCap?: boolean,
  /** Per-stroke ceiling for this pixel, in 0..100 (the selection is applied
   *  here). When undefined, `opacity` is reused as the ceiling (legacy
   *  behaviour). When supplied, the brush deposits `min(srcA,
   *  upgrade-to-cap)` per stamp, so overlapping stamps build toward the
   *  ceiling instead of reaching it on first contact — this is what makes
   *  Flow-vs-Opacity work for the stamp engine, which passes its flat
   *  Opacity (paint builds up to the opacity setting). */
  capOpacity?: number,
  /** When set, 8-bit writes (rgba8 channels, the flow-path coverage byte)
   *  use stochastic rounding seeded by this value instead of
   *  round-to-nearest, so low-flow / soft deposits keep their sub-level
   *  contribution on average (see `ditherBias`). The brush engine passes
   *  it; pixel-exact tools leave it undefined. */
  ditherSeed?: number,
): void {
  // Apply modular wrap BEFORE bounds check and touched-map key computation.
  // This ensures a pixel at (-1, 0) and (W-1, 0) share the same touched-map
  // entry, correctly preventing double-opacity accumulation across tile edges.
  if (tiledW !== undefined && tiledH !== undefined) {
    canvasX = ((canvasX % tiledW) + tiledW) % tiledW;
    canvasY = ((canvasY % tiledH) + tiledH) % tiledH;
  }
  // Reject pixels outside the canvas BEFORE any row-major index math, otherwise
  // a negative or oversized canvasX wraps `canvasY * W + canvasX` onto an
  // adjacent row — corrupting the touched-map (causing visible "holes" on the
  // opposite edge) and the selection-mask lookup. Off-canvas samples are never
  // visible anyway (the composite vertex stage clips them).
  if (
    canvasX < 0 ||
    canvasX >= renderer.pixelWidth ||
    canvasY < 0 ||
    canvasY >= renderer.pixelHeight
  )
    return;
  // Soft (feathered) selections scale the deposit and the stroke cap, like
  // the WASM stamp kernels do; 0 = outside.
  let selW = 1;
  if (sel) {
    const v = sel.mask[canvasY * sel.width + canvasX];
    if (v === 0) return;
    if (v !== 255) selW = v / 255;
  }
  const lx = canvasX - layer.offsetX;
  const ly = canvasY - layer.offsetY;
  if (lx < 0 || lx >= layer.layerWidth || ly < 0 || ly >= layer.layerHeight)
    return;
  const srcA =
    (srcFloat !== undefined && layer.format === "rgba32f"
      ? srcFloat[3] * (opacity / 100)
      : (a / 255) * (opacity / 100)) * selW;
  if (srcA <= 0) return;
  const bias =
    ditherSeed !== undefined ? ditherBias(canvasX, canvasY, ditherSeed) : 0.5;

  let blendA = srcA;
  if (touched !== undefined) {
    // Key in canvas-space so it stays stable across layer growth within a stroke.
    // 8-bit quantisation: byte/255 ≈ float, error ≤ 1/255 ≈ 0.4% — invisible
    // in stroke alpha and well below the precision the eye can resolve.
    const tdata = touched.data;
    const key = canvasY * touched.width + canvasX;
    const existingByte = tdata[key];
    const existingA = existingByte / 255;
    if (bypassTouchedCap) {
      // Smudge / build-up paths: no cap, but keep the silhouette growing so
      // stroke-level effects (wet edges) still see every painted pixel.
      // Store *geometric* coverage (opacity-driven, free of carried-alpha
      // fluctuations from smudge sampling) so the wet-edge boundary detector
      // gets a clean stroke shape — otherwise a smudged stroke whose carried
      // alpha varies stamp-to-stamp produces noisy silhouette values and a
      // patchy rim.
      const geomByte = (opacity * selW * 2.55 + 0.5) | 0;
      if (geomByte > existingByte) tdata[key] = geomByte;
      noteTouchedWrite(touched, canvasX, canvasY);
    } else if (capOpacity !== undefined) {
      // Flow path: srcA = per-stamp deposit, capA = per-stroke ceiling.
      // Each stamp deposits `min(srcA, upgrade-to-cap)`; the resulting
      // accumulated alpha (existing + blendA*(1-existing)) approaches
      // capA asymptotically, so overlapping stamps build up gradually.
      const capA =
        (srcFloat !== undefined && layer.format === "rgba32f"
          ? srcFloat[3] * (capOpacity / 100)
          : (a / 255) * (capOpacity / 100)) * selW;
      if (existingA >= capA) return;
      const upgrade = existingA < 1 ? (capA - existingA) / (1 - existingA) : 0;
      blendA = srcA < upgrade ? srcA : upgrade;
      if (blendA <= 0) return;
      const newA = existingA + blendA * (1 - existingA);
      // Dithered: at the ceiling round up, below it stochastically (see
      // `accumulate` in brush_stamp.cpp — a rounded-down ceiling leaves a
      // sliver every later stamp re-blends).
      tdata[key] =
        ditherSeed === undefined
          ? (newA * 255 + 0.5) | 0
          : srcA >= upgrade
            ? ceilByte(capA)
            : Math.min(255, (newA * 255 + bias) | 0);
      noteTouchedWrite(touched, canvasX, canvasY);
    } else {
      if (srcA <= existingA) return;
      blendA = existingA < 1 ? (srcA - existingA) / (1 - existingA) : 0;
      if (blendA <= 0) return;
      tdata[key] = ditherSeed === undefined ? (srcA * 255 + 0.5) | 0 : ceilByte(srcA);
      noteTouchedWrite(touched, canvasX, canvasY);
    }
  }

  if (layer.format === "indexed8") {
    // Palette layers go through the renderer's format strategy.
    const [er, eg, eb, ea] = renderer.samplePixel(layer, lx, ly);
    const dstA = ea / 255;
    const outA = blendA + dstA * (1 - blendA);
    if (outA <= 0) {
      renderer.drawPixel(layer, lx, ly, 0, 0, 0, 0);
    } else {
      const dstBlend = dstA * (1 - blendA);
      renderer.drawPixel(
        layer,
        lx,
        ly,
        Math.round((r * blendA + er * dstBlend) / outA),
        Math.round((g * blendA + eg * dstBlend) / outA),
        Math.round((b * blendA + eb * dstBlend) / outA),
        Math.round(outA * 255),
      );
    }
    return;
  }

  // rgba8 / rgba32f: read and write `layer.data` directly. The per-pixel
  // samplePixel / drawPixel round trip allocated a 4-tuple for every pixel
  // of every stamp.
  const d = layer.data;
  const i = (ly * layer.layerWidth + lx) * 4;
  const er = d[i];
  const eg = d[i + 1];
  const eb = d[i + 2];
  const ea = d[i + 3];
  if (layer.format === "rgba32f") {
    // rgba32f layers store linear-light values. When srcFloat is provided
    // the caller has already gamma-decoded its sRGB inputs (no 0–255 round
    // trip); byte inputs are sRGB-encoded and are decoded here.
    const sr =
      srcFloat !== undefined ? srcFloat[0] : srgbToLinearChannel(r / 255);
    const sg =
      srcFloat !== undefined ? srcFloat[1] : srgbToLinearChannel(g / 255);
    const sb =
      srcFloat !== undefined ? srcFloat[2] : srgbToLinearChannel(b / 255);
    const dstA = ea; // already 0.0-1.0
    const outA = blendA + dstA * (1 - blendA);
    if (outA <= 0) {
      d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
    } else {
      const dstBlend = dstA * (1 - blendA);
      d[i] = (sr * blendA + er * dstBlend) / outA;
      d[i + 1] = (sg * blendA + eg * dstBlend) / outA;
      d[i + 2] = (sb * blendA + eb * dstBlend) / outA;
      d[i + 3] = outA;
    }
  } else {
    const dstA = ea / 255;
    const outA = blendA + dstA * (1 - blendA);
    if (outA <= 0) {
      d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
    } else {
      const dstBlend = dstA * (1 - blendA);
      const inv = 1 / outA;
      d[i] = Math.min(255, ((r * blendA + er * dstBlend) * inv + bias) | 0);
      d[i + 1] = Math.min(255, ((g * blendA + eg * dstBlend) * inv + bias) | 0);
      d[i + 2] = Math.min(255, ((b * blendA + eb * dstBlend) * inv + bias) | 0);
      d[i + 3] = Math.min(255, (outA * 255 + bias) | 0);
    }
  }
}

/**
 * Xiaolin Wu's anti-aliased line algorithm.
 * Calls plot(x, y, coverage) where coverage ∈ (0, 1].
 */
export function wuLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  plot: (x: number, y: number, coverage: number) => void,
): void {
  // Single point — plot once at full coverage
  if (x0 === x1 && y0 === y1) {
    plot(x0, y0, 1);
    return;
  }

  const ipart = (n: number): number => Math.floor(n);
  const fpart = (n: number): number => n - Math.floor(n);
  const rfpart = (n: number): number => 1 - fpart(n);

  let [ax, ay, bx, by] = [x0, y0, x1, y1];
  const steep = Math.abs(by - ay) > Math.abs(bx - ax);
  if (steep) {
    [ax, ay, bx, by] = [ay, ax, by, bx];
  }
  if (ax > bx) {
    [ax, ay, bx, by] = [bx, by, ax, ay];
  }

  const dx = bx - ax;
  const dy = by - ay;
  const gradient = dy / dx;

  // Emit a pixel, swapping x/y back when the line was transposed
  const emit = (px: number, py: number, c: number): void =>
    c > 0 ? (steep ? plot(py, px, c) : plot(px, py, c)) : undefined;

  // First endpoint
  let xend = Math.round(ax);
  let yend = ay + gradient * (xend - ax);
  let xgap = rfpart(ax + 0.5);
  const xpxl1 = xend,
    ypxl1 = ipart(yend);
  emit(xpxl1, ypxl1, rfpart(yend) * xgap);
  emit(xpxl1, ypxl1 + 1, fpart(yend) * xgap);
  let intery = yend + gradient;

  // Second endpoint
  xend = Math.round(bx);
  yend = by + gradient * (xend - bx);
  xgap = fpart(bx + 0.5);
  const xpxl2 = xend,
    ypxl2 = ipart(yend);
  emit(xpxl2, ypxl2, rfpart(yend) * xgap);
  emit(xpxl2, ypxl2 + 1, fpart(yend) * xgap);

  // Main loop — pixels between the two endpoints
  for (let x = xpxl1 + 1; x < xpxl2; x++) {
    emit(x, ipart(intery), rfpart(intery));
    emit(x, ipart(intery) + 1, fpart(intery));
    intery += gradient;
  }
}
