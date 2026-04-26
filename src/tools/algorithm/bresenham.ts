import type { WebGPURenderer, GpuLayer } from '@/graphicspipeline/webgpu/rendering/WebGPURenderer'

/**
 * Bresenham's line algorithm — plots every integer pixel between (x0,y0) and
 * (x1,y1) inclusive, calling `plot` for each.
 */
export function bresenham(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  plot: (x: number, y: number) => void
): void {
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1
  let err = dx + dy, x = x0, y = y0

  while (true) {
    plot(x, y)
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; x += sx }
    if (e2 <= dx) { err += dx; y += sy }
  }
}

/** Convenience: draw a filled line segment on a layer and flush.
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
  a: number
): void {
  bresenham(x0, y0, x1, y1, (x, y) => renderer.drawCanvasPixel(layer, x, y, r, g, b, a))
}

/**
 * Porter-Duff "over" composite with incremental coverage tracking.
 * canvasX/canvasY are CANVAS-SPACE coordinates. Translates to layer-local
 * internally. Silently ignores pixels outside the layer buffer.
 *
 * `touched` is a Map from canvas-pixel-key → max effective-alpha applied.
 * When provided:
 *   - Compute srcA = (a/255) * (opacity/100)
 *   - If srcA <= existing max: skip (pixel is already more fully covered)
 *   - Otherwise apply only the *incremental* alpha needed to go from
 *     existingA to srcA:  incA = (srcA - existingA) / (1 - existingA)
 *     This prevents accumulation while allowing coverage to be upgraded
 *     (fixes ring artifacts from overlapping AA capsule segments).
 */
// Selection mask shorthand used by draw/erase helpers.
type SelMask = { mask: Uint8Array; width: number }

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
  touched?: Map<number, number>,
  sel?: SelMask,
): void {
  if (sel && sel.mask[canvasY * sel.width + canvasX] === 0) return
  const lx = canvasX - layer.offsetX
  const ly = canvasY - layer.offsetY
  if (lx < 0 || lx >= layer.layerWidth || ly < 0 || ly >= layer.layerHeight) return
  const srcA = (a / 255) * (opacity / 100)
  if (srcA <= 0) return

  let blendA = srcA
  if (touched !== undefined) {
    // Key in canvas-space so it stays stable across layer growth within a stroke
    const key = canvasY * renderer.pixelWidth + canvasX
    const existingA = touched.get(key) ?? 0
    if (srcA <= existingA) return
    blendA = existingA < 1 ? (srcA - existingA) / (1 - existingA) : 0
    if (blendA <= 0) return
    touched.set(key, srcA)
  }

  const [er, eg, eb, ea] = renderer.samplePixel(layer, lx, ly)
  const dstA = ea / 255
  const outA = blendA + dstA * (1 - blendA)
  if (outA <= 0) {
    renderer.drawPixel(layer, lx, ly, 0, 0, 0, 0)
  } else {
    const dstBlend = dstA * (1 - blendA)
    renderer.drawPixel(
      layer, lx, ly,
      Math.round((r * blendA + er * dstBlend) / outA),
      Math.round((g * blendA + eg * dstBlend) / outA),
      Math.round((b * blendA + eb * dstBlend) / outA),
      Math.round(outA * 255),
    )
  }
}

/**
 * Stamps a hard-edged circular brush of radius `size/2` centered at (cx, cy).
 * Pixels whose center falls within the radius are fully painted; outside pixels
 * are skipped entirely. Behaves like the AA capsule path but without feathering.
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
  touched?: Map<number, number>,
  sel?: SelMask,
): void {
  const radius = size / 2
  const iRadius = Math.ceil(radius)
  for (let dy = -iRadius; dy <= iRadius; dy++) {
    for (let dx = -iRadius; dx <= iRadius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) {
        blendPixelOver(renderer, layer, cx + dx, cy + dy, r, g, b, a, opacity, touched, sel)
      }
    }
  }
}

/**
 * Anti-aliased thick segment using a capsule signed-distance field.
 * Iterates every pixel in the bounding box of the segment (expanded by radius),
 * computes each pixel's perpendicular distance to the segment, and derives a
 * smooth coverage value. Produces a clean pill/capsule shape with no repeating
 * stamp artifacts.
 */
function drawAAThickSegment(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number, y0: number,
  x1: number, y1: number,
  size: number,
  r: number, g: number, b: number, a: number,
  opacity: number,
  touched?: Map<number, number>,
  sel?: SelMask,
): void {
  const radius = size / 2
  const pad = Math.ceil(radius) + 1
  const sdx = x1 - x0, sdy = y1 - y0
  const lenSq = sdx * sdx + sdy * sdy

  const minX = Math.floor(Math.min(x0, x1)) - pad
  const maxX = Math.ceil(Math.max(x0, x1)) + pad
  const minY = Math.floor(Math.min(y0, y1)) - pad
  const maxY = Math.ceil(Math.max(y0, y1)) + pad

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      let dist: number
      if (lenSq === 0) {
        // Degenerate segment: distance to the single point
        dist = Math.sqrt((px - x0) ** 2 + (py - y0) ** 2)
      } else {
        const t = Math.max(0, Math.min(1, ((px - x0) * sdx + (py - y0) * sdy) / lenSq))
        const nearX = x0 + t * sdx
        const nearY = y0 + t * sdy
        dist = Math.sqrt((px - nearX) ** 2 + (py - nearY) ** 2)
      }
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - dist))
      if (coverage > 0) {
        blendPixelOver(renderer, layer, px, py, r, g, b, a, opacity * coverage, touched, sel)
      }
    }
  }
}

/**
 * Like drawLine but uses a square stamp brush of `size` pixels,
 * compositing at `opacity` (0-100) over existing pixel data.
 * Pass a `touched` Set to prevent any pixel being composited more than once
 * within a single stroke.
 * When `antiAlias` is true: 1-px lines use Wu's algorithm; thicker lines use
 * a circular stamp with soft edge coverage.
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
  touched?: Map<number, number>,
  antiAlias = false,
  sel?: SelMask,
): void {
  if (antiAlias) {
    if (size <= 1) {
      wuLine(x0, y0, x1, y1, (x, y, coverage) =>
        blendPixelOver(renderer, layer, x, y, r, g, b, a, opacity * coverage, touched, sel))
    } else {
      drawAAThickSegment(renderer, layer, x0, y0, x1, y1, size, r, g, b, a, opacity, touched, sel)
    }
  } else {
    if (size <= 1) {
      bresenham(x0, y0, x1, y1, (x, y) =>
        blendPixelOver(renderer, layer, x, y, r, g, b, a, opacity, touched, sel))
    } else {
      bresenham(x0, y0, x1, y1, (x, y) =>
        stampCircle(renderer, layer, x, y, size, r, g, b, a, opacity, touched, sel))
    }
  }
}

/**
 * Xiaolin Wu's anti-aliased line algorithm.
 * Calls plot(x, y, coverage) where coverage ∈ (0, 1].
 */
function wuLine(
  x0: number, y0: number,
  x1: number, y1: number,
  plot: (x: number, y: number, coverage: number) => void,
): void {
  // Single point — plot once at full coverage
  if (x0 === x1 && y0 === y1) { plot(x0, y0, 1); return }

  const ipart = (n: number): number => Math.floor(n)
  const fpart = (n: number): number => n - Math.floor(n)
  const rfpart = (n: number): number => 1 - fpart(n)

  let [ax, ay, bx, by] = [x0, y0, x1, y1]
  const steep = Math.abs(by - ay) > Math.abs(bx - ax)
  if (steep) { [ax, ay, bx, by] = [ay, ax, by, bx] }
  if (ax > bx) { [ax, ay, bx, by] = [bx, by, ax, ay] }

  const dx = bx - ax
  const dy = by - ay
  const gradient = dy / dx

  // Emit a pixel, swapping x/y back when the line was transposed
  const emit = (px: number, py: number, c: number): void =>
    c > 0 ? (steep ? plot(py, px, c) : plot(px, py, c)) : undefined

  // First endpoint
  let xend = Math.round(ax)
  let yend = ay + gradient * (xend - ax)
  let xgap = rfpart(ax + 0.5)
  const xpxl1 = xend, ypxl1 = ipart(yend)
  emit(xpxl1, ypxl1, rfpart(yend) * xgap)
  emit(xpxl1, ypxl1 + 1, fpart(yend) * xgap)
  let intery = yend + gradient

  // Second endpoint
  xend = Math.round(bx)
  yend = by + gradient * (xend - bx)
  xgap = fpart(bx + 0.5)
  const xpxl2 = xend, ypxl2 = ipart(yend)
  emit(xpxl2, ypxl2, rfpart(yend) * xgap)
  emit(xpxl2, ypxl2 + 1, fpart(yend) * xgap)

  // Main loop — pixels between the two endpoints
  for (let x = xpxl1 + 1; x < xpxl2; x++) {
    emit(x, ipart(intery), rfpart(intery))
    emit(x, ipart(intery) + 1, fpart(intery))
    intery += gradient
  }
}

/**
 * Anti-aliased 1-pixel line using Xiaolin Wu's algorithm.
 * Composites at `opacity` (0-100) × per-pixel coverage over existing pixel data.
 * Pass a `touched` Set to prevent any pixel being composited more than once
 * within a single stroke.
 */
export function drawAALine(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number, y0: number,
  x1: number, y1: number,
  r: number, g: number, b: number, a: number,
  opacity = 100,
  touched?: Map<number, number>,
): void {
  wuLine(x0, y0, x1, y1, (x, y, coverage) => {
    blendPixelOver(renderer, layer, x, y, r, g, b, a, opacity * coverage, touched)
  })
}

/** Convenience: erase a filled line segment on a layer and flush.
 * Coordinates are CANVAS-SPACE; translates to layer-local internally. */
export function eraseLine(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): void {
  bresenham(x0, y0, x1, y1, (x, y) => {
    const lx = x - layer.offsetX
    const ly = y - layer.offsetY
    if (lx >= 0 && ly >= 0 && lx < layer.layerWidth && ly < layer.layerHeight) {
      renderer.erasePixel(layer, lx, ly)
    }
  })
}

// ─── Erase helpers ────────────────────────────────────────────────────────────

/**
 * Apply one erase pixel operation in canvas-space.
 *
 * alphaMode = false (default): blend RGB towards (secR,secG,secB), keep alpha.
 * alphaMode = true: reduce alpha by blendFactor, keep RGB values.
 *
 * `touched` tracks the max blendFactor already applied so the same pixel is
 * never over-erased within a single stroke.
 */
function erasePixelOp(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  canvasX: number,
  canvasY: number,
  secR: number,
  secG: number,
  secB: number,
  blendFactor: number, // 0-1  (coverage × strength/100)
  alphaMode: boolean,
  touched?: Map<number, number>,
  sel?: SelMask,
): void {
  if (sel && sel.mask[canvasY * sel.width + canvasX] === 0) return
  const lx = canvasX - layer.offsetX
  const ly = canvasY - layer.offsetY
  if (lx < 0 || lx >= layer.layerWidth || ly < 0 || ly >= layer.layerHeight) return
  if (blendFactor <= 0) return

  let incr = blendFactor
  if (touched !== undefined) {
    const key = canvasY * renderer.pixelWidth + canvasX
    const existing = touched.get(key) ?? 0
    if (blendFactor <= existing) return
    incr = existing < 1 ? (blendFactor - existing) / (1 - existing) : 0
    if (incr <= 0) return
    touched.set(key, blendFactor)
  }

  const [er, eg, eb, ea] = renderer.samplePixel(layer, lx, ly)

  if (alphaMode) {
    // Reduce alpha, keep RGB unchanged
    renderer.drawPixel(layer, lx, ly, er, eg, eb, Math.round(ea * (1 - incr)))
  } else {
    // Lerp RGB towards secondary color, preserve alpha
    renderer.drawPixel(
      layer, lx, ly,
      Math.round(er + (secR - er) * incr),
      Math.round(eg + (secG - eg) * incr),
      Math.round(eb + (secB - eb) * incr),
      ea,
    )
  }
}

function eraseStampCircle(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  cx: number,
  cy: number,
  size: number,
  secR: number,
  secG: number,
  secB: number,
  strength: number,
  alphaMode: boolean,
  touched?: Map<number, number>,
  sel?: SelMask,
): void {
  const radius = size / 2
  const iRadius = Math.ceil(radius)
  const bf = strength / 100
  for (let dy = -iRadius; dy <= iRadius; dy++) {
    for (let dx = -iRadius; dx <= iRadius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) {
        erasePixelOp(renderer, layer, cx + dx, cy + dy, secR, secG, secB, bf, alphaMode, touched, sel)
      }
    }
  }
}

function eraseAASegment(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number, y0: number,
  x1: number, y1: number,
  size: number,
  secR: number,
  secG: number,
  secB: number,
  strength: number,
  alphaMode: boolean,
  touched?: Map<number, number>,
  sel?: SelMask,
): void {
  const radius = size / 2
  const pad = Math.ceil(radius) + 1
  const sdx = x1 - x0, sdy = y1 - y0
  const lenSq = sdx * sdx + sdy * sdy
  const minX = Math.floor(Math.min(x0, x1)) - pad
  const maxX = Math.ceil(Math.max(x0, x1)) + pad
  const minY = Math.floor(Math.min(y0, y1)) - pad
  const maxY = Math.ceil(Math.max(y0, y1)) + pad

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      let dist: number
      if (lenSq === 0) {
        dist = Math.sqrt((px - x0) ** 2 + (py - y0) ** 2)
      } else {
        const t = Math.max(0, Math.min(1, ((px - x0) * sdx + (py - y0) * sdy) / lenSq))
        dist = Math.sqrt((px - x0 - t * sdx) ** 2 + (py - y0 - t * sdy) ** 2)
      }
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - dist))
      if (coverage > 0) {
        erasePixelOp(renderer, layer, px, py, secR, secG, secB, (strength / 100) * coverage, alphaMode, touched, sel)
      }
    }
  }
}

/**
 * Erase a thick line segment on a layer (canvas-space coords).
 *
 * alphaMode = false: blend RGB towards (secR,secG,secB), keep alpha.
 * alphaMode = true:  reduce alpha; RGB values unchanged.
 * strength: 0-100 (100 = full erase).
 * antiAlias: use capsule SDF / Wu line for soft edges.
 */
export function eraseThickLine(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
  secR: number,
  secG: number,
  secB: number,
  strength = 100,
  alphaMode = false,
  antiAlias = false,
  touched?: Map<number, number>,
  sel?: SelMask,
): void {
  const bf = strength / 100
  if (antiAlias) {
    if (size <= 1) {
      wuLine(x0, y0, x1, y1, (x, y, coverage) => {
        erasePixelOp(renderer, layer, x, y, secR, secG, secB, bf * coverage, alphaMode, touched, sel)
      })
    } else {
      eraseAASegment(renderer, layer, x0, y0, x1, y1, size, secR, secG, secB, strength, alphaMode, touched, sel)
    }
  } else {
    if (size <= 1) {
      bresenham(x0, y0, x1, y1, (x, y) => {
        erasePixelOp(renderer, layer, x, y, secR, secG, secB, bf, alphaMode, touched, sel)
      })
    } else {
      bresenham(x0, y0, x1, y1, (cx, cy) => {
        eraseStampCircle(renderer, layer, cx, cy, size, secR, secG, secB, strength, alphaMode, touched, sel)
      })
    }
  }
}

// ─── Dodge / Burn helpers ─────────────────────────────────────────────────────

/** Range channels covered by dodge/burn. */
export type DodgeBurnRange = 'shadows' | 'midtones' | 'highlights'

/**
 * Compute the per-pixel exposure factor for dodge/burn.
 *
 * @param luminance  0–1 linear luminance of the existing pixel
 * @param range      Which tonal range to target
 * @returns          0–1 weight (1 = full effect at the sweet-spot, 0 = no effect)
 */
function toneWeight(luminance: number, range: DodgeBurnRange): number {
  switch (range) {
    case 'shadows':    return Math.max(0, 1 - luminance * 3)
    case 'highlights': return Math.max(0, luminance * 3 - 2)
    default:           return Math.max(0, 1 - Math.abs(luminance - 0.5) * 4)
  }
}

/**
 * Apply dodge/burn to one pixel.
 *
 * `exposure`  — signed magnitude, positive=dodge, negative=burn (0–1 scale)
 * `coverage`  — 0–1 SDF or stamp value for this hit
 * `touched`   — MAX coverage reached for each pixel key across all segments of the stroke
 * `origData`  — caches each pixel's ORIGINAL rgba on first touch so that all subsequent
 *               coverage updates apply their factor against the unmodified value.
 *               Without this, sequential delta updates compound multiplicatively and produce
 *               visible luminance rings at segment junctions.
 */
function dodgeBurnPixelOp(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  canvasX: number,
  canvasY: number,
  exposure: number,
  coverage: number,
  range: DodgeBurnRange,
  touched?: Map<number, number>,
  sel?: SelMask,
  origData?: Map<number, readonly [number, number, number, number]>,
): void {
  if (sel && sel.mask[canvasY * sel.width + canvasX] === 0) return
  const lx = canvasX - layer.offsetX
  const ly = canvasY - layer.offsetY
  if (lx < 0 || lx >= layer.layerWidth || ly < 0 || ly >= layer.layerHeight) return

  let maxCoverage = coverage
  if (touched !== undefined) {
    const key = canvasY * renderer.pixelWidth + canvasX
    const prev = touched.get(key) ?? 0
    if (prev >= coverage) return    // already at or beyond this coverage level — no change
    touched.set(key, coverage)
    maxCoverage = coverage          // apply full factor against original value (not delta)
  }

  if (maxCoverage <= 0) return

  // Use the pixel's ORIGINAL value (cached on first touch) so each coverage update
  // is computed from the same baseline — avoids multiplicative compounding.
  const key = canvasY * renderer.pixelWidth + canvasX
  let r: number, g: number, b: number, a: number
  if (origData) {
    let orig = origData.get(key)
    if (!orig) {
      orig = renderer.samplePixel(layer, lx, ly)
      origData.set(key, orig)
    }
    ;[r, g, b, a] = orig
  } else {
    ;[r, g, b, a] = renderer.samplePixel(layer, lx, ly)
  }
  if (a === 0) return

  const rl = r / 255, gl = g / 255, bl = b / 255
  const lum = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl
  const weight = toneWeight(lum, range)
  if (weight <= 0) return

  const factor = 1 + exposure * maxCoverage * weight
  renderer.drawPixel(
    layer, lx, ly,
    Math.max(0, Math.min(255, Math.round(r * factor))),
    Math.max(0, Math.min(255, Math.round(g * factor))),
    Math.max(0, Math.min(255, Math.round(b * factor))),
    a,
  )
}

function dodgeBurnStampCircle(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  cx: number, cy: number,
  size: number,
  exposure: number,
  range: DodgeBurnRange,
  hardness: number,
  antiAlias: boolean,
  touched?: Map<number, number>,
  sel?: SelMask,
  origData?: Map<number, readonly [number, number, number, number]>,
): void {
  const radius   = size / 2
  const outerR   = antiAlias ? radius + 0.5 : radius
  const iRadius  = Math.ceil(outerR) + 1
  const hardR    = radius * (hardness / 100)
  const softZone = radius - hardR

  for (let dy = -iRadius; dy <= iRadius; dy++) {
    for (let dx = -iRadius; dx <= iRadius; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist > outerR) continue

      const edgeFactor = antiAlias ? Math.min(1, outerR - dist) : 1
      let softFactor: number
      if (softZone <= 0 || dist <= hardR) {
        softFactor = 1
      } else {
        const t = (dist - hardR) / softZone
        softFactor = 0.5 * (1 + Math.cos(Math.PI * t))
      }
      const coverage = edgeFactor * softFactor
      if (coverage <= 0) continue
      dodgeBurnPixelOp(renderer, layer, cx + dx, cy + dy, exposure, coverage, range, touched, sel, origData)
    }
  }
}

function dodgeBurnAASegment(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number, y0: number,
  x1: number, y1: number,
  size: number,
  exposure: number,
  range: DodgeBurnRange,
  hardness: number,
  touched?: Map<number, number>,
  sel?: SelMask,
  origData?: Map<number, readonly [number, number, number, number]>,
): void {
  const radius   = size / 2
  const outerR   = radius + 0.5
  const hardR    = radius * (hardness / 100)
  const softZone = radius - hardR
  const pad = Math.ceil(outerR) + 1
  const sdx = x1 - x0, sdy = y1 - y0
  const lenSq = sdx * sdx + sdy * sdy
  const minX = Math.floor(Math.min(x0, x1)) - pad
  const maxX = Math.ceil(Math.max(x0, x1)) + pad
  const minY = Math.floor(Math.min(y0, y1)) - pad
  const maxY = Math.ceil(Math.max(y0, y1)) + pad

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      let dist: number
      if (lenSq === 0) {
        dist = Math.sqrt((px - x0) ** 2 + (py - y0) ** 2)
      } else {
        const t = Math.max(0, Math.min(1, ((px - x0) * sdx + (py - y0) * sdy) / lenSq))
        dist = Math.sqrt((px - x0 - t * sdx) ** 2 + (py - y0 - t * sdy) ** 2)
      }
      if (dist > outerR) continue

      const edgeFactor = Math.min(1, outerR - dist)
      let softFactor: number
      if (softZone <= 0 || dist <= hardR) {
        softFactor = 1
      } else {
        const t = (dist - hardR) / softZone
        softFactor = 0.5 * (1 + Math.cos(Math.PI * t))
      }
      const coverage = edgeFactor * softFactor
      if (coverage > 0) {
        dodgeBurnPixelOp(renderer, layer, px, py, exposure, coverage, range, touched, sel, origData)
      }
    }
  }
}

/**
 * Apply dodge (lighten) or burn (darken) along a thick line segment.
 *
 * exposure > 0 = dodge, exposure < 0 = burn.
 * exposure magnitude is 0–1 (maps to 0–100% in the UI).
 *
 * Pass the same `touched` and `origData` maps for every segment in a stroke so that
 * pixels which span multiple segment capsules are rendered from their original values
 * at the highest coverage reached — producing seamless, artifact-free strokes.
 */
export function dodgeBurnThickLine(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number, y0: number,
  x1: number, y1: number,
  size: number,
  exposure: number,
  range: DodgeBurnRange,
  hardness = 100,
  antiAlias = false,
  touched?: Map<number, number>,
  sel?: SelMask,
  origData?: Map<number, readonly [number, number, number, number]>,
): void {
  if (antiAlias) {
    if (size <= 1) {
      wuLine(x0, y0, x1, y1, (x, y, coverage) => {
        dodgeBurnPixelOp(renderer, layer, x, y, exposure, coverage, range, touched, sel, origData)
      })
    } else {
      dodgeBurnAASegment(renderer, layer, x0, y0, x1, y1, size, exposure, range, hardness, touched, sel, origData)
    }
  } else {
    if (size <= 1) {
      bresenham(x0, y0, x1, y1, (x, y) => {
        dodgeBurnPixelOp(renderer, layer, x, y, exposure, 1, range, touched, sel, origData)
      })
    } else {
      bresenham(x0, y0, x1, y1, (cx, cy) => {
        dodgeBurnStampCircle(renderer, layer, cx, cy, size, exposure, range, hardness, antiAlias, touched, sel, origData)
      })
    }
  }
}

// ─── Airbrush helpers ─────────────────────────────────────────────────────────

/** Brush shape metric used by the airbrush stamp. */
export type BrushShape = 'round' | 'square' | 'diamond'

/** Compute distance from origin using the shape's metric. */
function shapeDistance(dx: number, dy: number, shape: BrushShape): number {
  if (shape === 'square')  return Math.max(Math.abs(dx), Math.abs(dy))
  if (shape === 'diamond') return (Math.abs(dx) + Math.abs(dy)) / Math.SQRT2
  return Math.sqrt(dx * dx + dy * dy) // round
}

/**
 * Stamp a soft-edged (airbrush-style) brush at canvas point (cx, cy).
 *
 * hardness: 0–100.
 *   100 = hard binary edge (full opacity inside radius, nothing outside).
 *   0   = full Gaussian-like smooth falloff from centre to edge.
 * shape:  'round' | 'square' | 'diamond' — distance metric for the brush footprint.
 * opacity: 0–100 tool opacity (multiplied together with per-pixel coverage).
 */
export function stampAirbrush(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  cx: number,
  cy: number,
  size: number,
  r: number, g: number, b: number, a: number,
  opacity: number,
  hardness: number,
  shape: BrushShape,
  antiAlias = false,
  touched?: Map<number, number>,
  sel?: SelMask,
): void {
  const radius  = size / 2
  const outerR  = antiAlias ? radius + 0.5 : radius
  const iRadius = Math.ceil(outerR) + 1
  const hardR   = radius * (hardness / 100)
  const softZone = radius - hardR

  for (let dy = -iRadius; dy <= iRadius; dy++) {
    for (let dx = -iRadius; dx <= iRadius; dx++) {
      const dist = shapeDistance(dx, dy, shape)
      if (dist > outerR) continue

      // Sub-pixel feather at the outer boundary (AA only)
      const edgeFactor = antiAlias ? Math.min(1, outerR - dist) : 1

      let softFactor: number
      if (softZone <= 0 || dist <= hardR) {
        softFactor = 1
      } else {
        // Cosine falloff in the soft zone: smooth S-curve from 1→0
        const t = (dist - hardR) / softZone
        softFactor = 0.5 * (1 + Math.cos(Math.PI * t))
      }

      const coverage = edgeFactor * softFactor
      if (coverage <= 0) continue

      blendPixelOver(
        renderer, layer,
        cx + dx, cy + dy,
        r, g, b, a,
        opacity * coverage,
        touched, sel,
      )
    }
  }
}

/**
 * Render a single brush stroke segment as one unified SDF shape — no discrete
 * stamps, so there are zero caterpillar / bead artifacts.
 *
 * Distance is computed in **canvas space** from each pixel to the nearest point
 * on the segment, then fed through the chosen metric:
 *   round:   Euclidean  → smooth circular capsule with round caps.
 *   square:  Chebyshev  → square cross-section, square caps (canvas-aligned).
 *   diamond: L1         → diamond cross-section, diamond caps (canvas-aligned).
 *
 * hardness 0–100: 100 = binary hard edge; 0 = full cosine falloff to centre.
 * antiAlias: adds a 0.5 px sub-pixel feather at the outer boundary.
 */
export function drawAirbrushCapsule(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number, y0: number,
  x1: number, y1: number,
  size: number,
  r: number, g: number, b: number, a: number,
  opacity: number,
  hardness: number,
  shape: BrushShape,
  antiAlias: boolean,
  touched?: Map<number, number>,
  sel?: SelMask,
): void {
  const radius = size / 2
  const outerR = antiAlias ? radius + 0.5 : radius
  const pad    = Math.ceil(outerR) + 1

  const sdx = x1 - x0, sdy = y1 - y0
  const len  = Math.sqrt(sdx * sdx + sdy * sdy)
  const tx   = len > 0 ? sdx / len : 1
  const ty   = len > 0 ? sdy / len : 0

  const minX = Math.floor(Math.min(x0, x1)) - pad
  const maxX = Math.ceil(Math.max(x0, x1)) + pad
  const minY = Math.floor(Math.min(y0, y1)) - pad
  const maxY = Math.ceil(Math.max(y0, y1)) + pad

  const hardR    = radius * (hardness / 100)
  const softZone = radius - hardR

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      // Nearest canvas-space point on the segment
      const dx = px - x0, dy = py - y0
      const proj  = len > 0 ? Math.max(0, Math.min(len, dx * tx + dy * ty)) : 0
      const nearX = x0 + proj * tx
      const nearY = y0 + proj * ty
      const cdx   = px - nearX
      const cdy   = py - nearY

      let dist: number
      if (shape === 'square') {
        dist = Math.max(Math.abs(cdx), Math.abs(cdy))
      } else if (shape === 'diamond') {
        // L1 norm: same axis-aligned width as round; corners cut in
        dist = Math.abs(cdx) + Math.abs(cdy)
      } else {
        dist = Math.sqrt(cdx * cdx + cdy * cdy)
      }

      if (dist > outerR) continue

      // Sub-pixel AA feather at the outer boundary
      const edgeFactor = antiAlias ? Math.min(1, outerR - dist) : 1

      // Cosine soft-zone falloff controlled by hardness
      let softFactor = 1
      if (softZone > 0 && dist > hardR) {
        const st = (dist - hardR) / softZone
        softFactor = 0.5 * (1 + Math.cos(Math.PI * st))
      }

      const coverage = edgeFactor * softFactor
      if (coverage <= 0) continue

      blendPixelOver(renderer, layer, px, py, r, g, b, a, opacity * coverage, touched, sel)
    }
  }
}

/**
 * Walk from (x0,y0) to (x1,y1) placing airbrush stamps at spacing intervals.
 * spacing ≈ size * 0.2 keeps the stroke continuous without over-blending.
 */
export function drawAirbrushSegment(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number, y0: number,
  x1: number, y1: number,
  size: number,
  r: number, g: number, b: number, a: number,
  opacity: number,
  hardness: number,
  shape: BrushShape,
  touched?: Map<number, number>,
  sel?: SelMask,
): void {
  const dx = x1 - x0, dy = y1 - y0
  const dist = Math.sqrt(dx * dx + dy * dy)
  const spacing = Math.max(1, size * 0.2)

  if (dist === 0) {
    stampAirbrush(renderer, layer, x0, y0, size, r, g, b, a, opacity, hardness, shape, false, touched, sel)
    return
  }

  const steps = Math.max(1, Math.ceil(dist / spacing))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const sx = Math.round(x0 + dx * t)
    const sy = Math.round(y0 + dy * t)
    stampAirbrush(renderer, layer, sx, sy, size, r, g, b, a, opacity, hardness, shape, false, touched, sel)
  }
}

/**
 * Walk a quadratic Bézier from (p0x,p0y) to (p1x,p1y) guided by control
 * point (cpx,cpy), stamping brush dabs at stamp-spacing intervals.
 *
 * motionBlur 0‒1: when > 0 each dab becomes a capsule oriented along the
 * local arc tangent, with half-length = size × motionBlur × 0.5. This gives
 * a natural directional-smear appearance without any post-processing step.
 * The touched map prevents double-painting in capsule overlaps.
 */
export function walkQuadBezier(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  p0x: number, p0y: number,
  cpx: number, cpy: number,
  p1x: number, p1y: number,
  size: number,
  r: number, g: number, b: number, a: number,
  opacity: number,
  hardness: number,
  shape: BrushShape,
  antiAlias: boolean,
  motionBlur = 0,
  touched?: Map<number, number>,
  sel?: SelMask,
): void {
  const arcEst = Math.hypot(cpx - p0x, cpy - p0y) + Math.hypot(p1x - cpx, p1y - cpy)
  const spacing = Math.max(1, size * 0.2)
  const steps   = Math.max(1, Math.ceil(arcEst / spacing))
  const half    = size * motionBlur * 0.5

  for (let i = 0; i <= steps; i++) {
    const t  = i / steps
    const t1 = 1 - t
    const x  = t1 * t1 * p0x + 2 * t1 * t * cpx + t * t * p1x
    const y  = t1 * t1 * p0y + 2 * t1 * t * cpy + t * t * p1y

    if (half > 0) {
      // Quadratic Bézier tangent: d/dt evaluated at current t
      const dtx = 2 * t1 * (cpx - p0x) + 2 * t * (p1x - cpx)
      const dty = 2 * t1 * (cpy - p0y) + 2 * t * (p1y - cpy)
      const len = Math.sqrt(dtx * dtx + dty * dty)
      if (len > 0) {
        const nx = dtx / len, ny = dty / len
        drawAirbrushCapsule(
          renderer, layer,
          x - nx * half, y - ny * half,
          x + nx * half, y + ny * half,
          size, r, g, b, a, opacity,
          hardness, shape, antiAlias,
          touched, sel,
        )
      } else {
        stampAirbrush(renderer, layer, Math.round(x), Math.round(y), size, r, g, b, a, opacity, hardness, shape, antiAlias, touched, sel)
      }
    } else {
      stampAirbrush(renderer, layer, Math.round(x), Math.round(y), size, r, g, b, a, opacity, hardness, shape, antiAlias, touched, sel)
    }
  }
}

// ─── Clone Stamp helpers ──────────────────────────────────────────────────────

/**
 * Paints a clone-stamp capsule segment from (x0,y0) to (x1,y1).
 * For each pixel in the capsule SDF area, the source color is sampled from
 * `sourceBuffer` at (canvasX + offsetDX, canvasY + offsetDY) and composited
 * onto `destLayer` using Porter-Duff "over" with per-stroke coverage tracking.
 *
 * @param offsetDX        source = dest + offset (X); computed at stroke start
 * @param offsetDY        source = dest + offset (Y)
 * @param sourceIsCanvas  when true, sourceBuffer is canvas-sized (canvasW × canvasH × 4);
 *                        when false, sourceBounds must be provided (layer-local buffer)
 * @param sourceBounds    geometry of the source layer; ignored when sourceIsCanvas=true
 * @param hardness        0-100; 100 = hard circular edge, lower = SDF feather
 */
export function stampCloneSegment(
  renderer: WebGPURenderer,
  destLayer: GpuLayer,
  x0: number, y0: number,
  x1: number, y1: number,
  size: number,
  hardness: number,
  offsetDX: number, offsetDY: number,
  sourceBuffer: Uint8Array,
  sourceIsCanvas: boolean,
  sourceBounds: { offsetX: number; offsetY: number; layerWidth: number; layerHeight: number } | null,
  canvasW: number, canvasH: number,
  opacity: number,
  touched?: Map<number, number>,
  sel?: SelMask,
): void {
  const radius = size / 2
  const pad = Math.ceil(radius) + 1
  const sdx = x1 - x0, sdy = y1 - y0
  const lenSq = sdx * sdx + sdy * sdy

  const featherBand = Math.max(0.5, radius * (1 - hardness / 100))
  const innerRadius = Math.max(0, radius - featherBand)

  const minX = Math.floor(Math.min(x0, x1)) - pad
  const maxX = Math.ceil(Math.max(x0, x1)) + pad
  const minY = Math.floor(Math.min(y0, y1)) - pad
  const maxY = Math.ceil(Math.max(y0, y1)) + pad

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      let dist: number
      if (lenSq === 0) {
        dist = Math.sqrt((px - x0) ** 2 + (py - y0) ** 2)
      } else {
        const t = Math.max(0, Math.min(1, ((px - x0) * sdx + (py - y0) * sdy) / lenSq))
        const nearX = x0 + t * sdx, nearY = y0 + t * sdy
        dist = Math.sqrt((px - nearX) ** 2 + (py - nearY) ** 2)
      }
      if (dist > radius) continue

      const coverage = dist <= innerRadius
        ? 1
        : Math.max(0, (radius - dist) / featherBand)
      if (coverage <= 0) continue

      const srcX = px + offsetDX
      const srcY = py + offsetDY

      let sr = 0, sg = 0, sb = 0, sa = 0
      if (sourceIsCanvas) {
        const sx = Math.round(srcX), sy = Math.round(srcY)
        if (sx >= 0 && sy >= 0 && sx < canvasW && sy < canvasH) {
          const i = (sy * canvasW + sx) * 4
          sr = sourceBuffer[i]; sg = sourceBuffer[i + 1]
          sb = sourceBuffer[i + 2]; sa = sourceBuffer[i + 3]
        }
      } else if (sourceBounds) {
        const lx = Math.round(srcX) - sourceBounds.offsetX
        const ly = Math.round(srcY) - sourceBounds.offsetY
        if (lx >= 0 && ly >= 0 && lx < sourceBounds.layerWidth && ly < sourceBounds.layerHeight) {
          const i = (ly * sourceBounds.layerWidth + lx) * 4
          sr = sourceBuffer[i]; sg = sourceBuffer[i + 1]
          sb = sourceBuffer[i + 2]; sa = sourceBuffer[i + 3]
        }
      }
      if (sa === 0) continue

      blendPixelOver(
        renderer, destLayer, px, py,
        sr, sg, sb, sa,
        opacity * coverage,
        touched, sel,
      )
    }
  }
}
