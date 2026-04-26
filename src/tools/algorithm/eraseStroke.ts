import type { WebGPURenderer, GpuLayer } from '@/graphicspipeline/webgpu/rendering/WebGPURenderer'
import { bresenham, wuLine } from './primitives'
import type { SelMask } from './primitives'

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
