import type {
  WebGPURenderer,
  GpuLayer,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import { srgbToLinearChannel } from "@/utils/pixelFormatConvert";

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
}

export function makeTouchedBuffer(
  width: number,
  height: number,
): TouchedBuffer {
  return { data: new Uint8Array(width * height), width, height };
}

export function clearTouchedBuffer(buf: TouchedBuffer): void {
  buf.data.fill(0);
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
  const dx = Math.abs(x1 - x0),
    sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0),
    sy = y0 < y1 ? 1 : -1;
  let err = dx + dy,
    x = x0,
    y = y0;

  while (true) {
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

/** Convenience: draw a filled line segment on a layer.
 * Coordinates are CANVAS-SPACE; translates to layer-local internally. */
export function drawLine(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  bresenham(x0, y0, x1, y1, (x, y) =>
    renderer.drawCanvasPixel(layer, x, y, r, g, b, a),
  );
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
  /** Per-stroke ceiling for this pixel, in 0..100, already including
   *  geometric coverage. When undefined, `opacity` is reused as the
   *  ceiling (legacy behaviour). When supplied, the brush deposits
   *  `min(srcA, upgrade-to-cap)` per stamp, so overlapping stamps build
   *  toward the ceiling instead of reaching it on first contact — this
   *  is what makes Flow-vs-Opacity work for the stamp engine. */
  capOpacity?: number,
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
  if (sel && sel.mask[canvasY * sel.width + canvasX] === 0) return;
  const lx = canvasX - layer.offsetX;
  const ly = canvasY - layer.offsetY;
  if (lx < 0 || lx >= layer.layerWidth || ly < 0 || ly >= layer.layerHeight)
    return;
  const srcA =
    srcFloat !== undefined && layer.format === "rgba32f"
      ? srcFloat[3] * (opacity / 100)
      : (a / 255) * (opacity / 100);
  if (srcA <= 0) return;

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
      const geomByte = (opacity * 2.55 + 0.5) | 0;
      if (geomByte > existingByte) tdata[key] = geomByte;
    } else if (capOpacity !== undefined) {
      // Flow path: srcA = per-stamp deposit, capA = per-stroke ceiling.
      // Each stamp deposits `min(srcA, upgrade-to-cap)`; the resulting
      // accumulated alpha (existing + blendA*(1-existing)) approaches
      // capA asymptotically, so overlapping stamps build up gradually.
      const capA =
        srcFloat !== undefined && layer.format === "rgba32f"
          ? srcFloat[3] * (capOpacity / 100)
          : (a / 255) * (capOpacity / 100);
      if (existingA >= capA) return;
      const upgrade = existingA < 1 ? (capA - existingA) / (1 - existingA) : 0;
      blendA = srcA < upgrade ? srcA : upgrade;
      if (blendA <= 0) return;
      const newA = existingA + blendA * (1 - existingA);
      tdata[key] = (newA * 255 + 0.5) | 0;
    } else {
      if (srcA <= existingA) return;
      blendA = existingA < 1 ? (srcA - existingA) / (1 - existingA) : 0;
      if (blendA <= 0) return;
      tdata[key] = (srcA * 255 + 0.5) | 0;
    }
  }

  const [er, eg, eb, ea] = renderer.samplePixel(layer, lx, ly);
  if (layer.format === "rgba32f") {
    // rgba32f layers store linear-light values; samplePixel / drawPixel
    // operate in linear `[0.0, ∞)`. When srcFloat is provided the caller
    // is responsible for already having gamma-decoded sRGB inputs (so we
    // use it as-is — no precision loss from a 0–255 round-trip). When
    // only the byte path is supplied, those bytes are sRGB-encoded and
    // must be gamma-decoded before they enter the linear blend.
    const sr =
      srcFloat !== undefined ? srcFloat[0] : srgbToLinearChannel(r / 255);
    const sg =
      srcFloat !== undefined ? srcFloat[1] : srgbToLinearChannel(g / 255);
    const sb =
      srcFloat !== undefined ? srcFloat[2] : srgbToLinearChannel(b / 255);
    const dstA = ea; // already 0.0-1.0
    const outA = blendA + dstA * (1 - blendA);
    if (outA <= 0) {
      renderer.drawPixel(layer, lx, ly, 0, 0, 0, 0);
    } else {
      const dstBlend = dstA * (1 - blendA);
      renderer.drawPixel(
        layer,
        lx,
        ly,
        (sr * blendA + er * dstBlend) / outA,
        (sg * blendA + eg * dstBlend) / outA,
        (sb * blendA + eb * dstBlend) / outA,
        outA,
      );
    }
  } else {
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

/**
 * Anti-aliased 1-pixel line using Xiaolin Wu's algorithm.
 * Composites at `opacity` (0-100) × per-pixel coverage over existing pixel data.
 */
export function drawAALine(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  g: number,
  b: number,
  a: number,
  opacity = 100,
  touched?: TouchedBuffer,
): void {
  wuLine(x0, y0, x1, y1, (x, y, coverage) => {
    blendPixelOver(
      renderer,
      layer,
      x,
      y,
      r,
      g,
      b,
      a,
      opacity * coverage,
      touched,
    );
  });
}

/** Convenience: erase a filled line segment on a layer.
 * Coordinates are CANVAS-SPACE; translates to layer-local internally. */
export function eraseLine(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  bresenham(x0, y0, x1, y1, (x, y) => {
    const lx = x - layer.offsetX;
    const ly = y - layer.offsetY;
    if (lx >= 0 && ly >= 0 && lx < layer.layerWidth && ly < layer.layerHeight) {
      renderer.erasePixel(layer, lx, ly);
    }
  });
}

/**
 * Stamps a hard-edged circular brush of radius `size/2` centered at (cx, cy).
 */
function stampCircle(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  cx: number,
  cy: number,
  size: number,
  r: number,
  g: number,
  b: number,
  a: number,
  opacity: number,
  touched?: TouchedBuffer,
  sel?: SelMask,
): void {
  const radius = size / 2;
  const iRadius = Math.ceil(radius);
  for (let dy = -iRadius; dy <= iRadius; dy++) {
    for (let dx = -iRadius; dx <= iRadius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) {
        blendPixelOver(
          renderer,
          layer,
          cx + dx,
          cy + dy,
          r,
          g,
          b,
          a,
          opacity,
          touched,
          sel,
        );
      }
    }
  }
}

/**
 * Anti-aliased thick segment using a capsule signed-distance field.
 */
function drawAAThickSegment(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
  r: number,
  g: number,
  b: number,
  a: number,
  opacity: number,
  touched?: TouchedBuffer,
  sel?: SelMask,
): void {
  const radius = size / 2;
  const pad = Math.ceil(radius) + 1;
  const sdx = x1 - x0,
    sdy = y1 - y0;
  const lenSq = sdx * sdx + sdy * sdy;

  const minX = Math.floor(Math.min(x0, x1)) - pad;
  const maxX = Math.ceil(Math.max(x0, x1)) + pad;
  const minY = Math.floor(Math.min(y0, y1)) - pad;
  const maxY = Math.ceil(Math.max(y0, y1)) + pad;

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      let dist: number;
      if (lenSq === 0) {
        dist = Math.sqrt((px - x0) ** 2 + (py - y0) ** 2);
      } else {
        const t = Math.max(
          0,
          Math.min(1, ((px - x0) * sdx + (py - y0) * sdy) / lenSq),
        );
        const nearX = x0 + t * sdx;
        const nearY = y0 + t * sdy;
        dist = Math.sqrt((px - nearX) ** 2 + (py - nearY) ** 2);
      }
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - dist));
      if (coverage > 0) {
        blendPixelOver(
          renderer,
          layer,
          px,
          py,
          r,
          g,
          b,
          a,
          opacity * coverage,
          touched,
          sel,
        );
      }
    }
  }
}

/**
 * Draw a thick line segment on a layer at `opacity` (0-100).
 * When `antiAlias` is true: 1-px lines use Wu's algorithm; thicker lines use a capsule SDF.
 */
export function drawThickLine(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
  r: number,
  g: number,
  b: number,
  a: number,
  opacity = 100,
  touched?: TouchedBuffer,
  antiAlias = false,
  sel?: SelMask,
): void {
  if (antiAlias) {
    if (size <= 1) {
      wuLine(x0, y0, x1, y1, (x, y, coverage) =>
        blendPixelOver(
          renderer,
          layer,
          x,
          y,
          r,
          g,
          b,
          a,
          opacity * coverage,
          touched,
          sel,
        ),
      );
    } else {
      drawAAThickSegment(
        renderer,
        layer,
        x0,
        y0,
        x1,
        y1,
        size,
        r,
        g,
        b,
        a,
        opacity,
        touched,
        sel,
      );
    }
  } else {
    if (size <= 1) {
      bresenham(x0, y0, x1, y1, (x, y) =>
        blendPixelOver(
          renderer,
          layer,
          x,
          y,
          r,
          g,
          b,
          a,
          opacity,
          touched,
          sel,
        ),
      );
    } else {
      bresenham(x0, y0, x1, y1, (x, y) =>
        stampCircle(
          renderer,
          layer,
          x,
          y,
          size,
          r,
          g,
          b,
          a,
          opacity,
          touched,
          sel,
        ),
      );
    }
  }
}
