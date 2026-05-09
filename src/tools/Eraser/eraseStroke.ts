import type {
  WebGPURenderer,
  GpuLayer,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import { bresenham, wuLine } from "../_shared/primitives";
import type { SelMask } from "../_shared/primitives";

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
  tiledW?: number,
  tiledH?: number,
): void {
  // Apply modular wrap before bounds check and touched-map key computation.
  if (tiledW !== undefined && tiledH !== undefined) {
    canvasX = ((canvasX % tiledW) + tiledW) % tiledW;
    canvasY = ((canvasY % tiledH) + tiledH) % tiledH;
  }
  // See blendPixelOver in primitives.ts: bail before any row-major index math
  // when the sample is outside the canvas, so a negative or oversized canvasX
  // can't wrap onto an adjacent row of the touched-map / selection mask.
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
  if (blendFactor <= 0) return;

  let incr = blendFactor;
  if (touched !== undefined) {
    const key = canvasY * renderer.pixelWidth + canvasX;
    const existing = touched.get(key) ?? 0;
    if (blendFactor <= existing) return;
    incr = existing < 1 ? (blendFactor - existing) / (1 - existing) : 0;
    if (incr <= 0) return;
    touched.set(key, blendFactor);
  }

  const [er, eg, eb, ea] = renderer.samplePixel(layer, lx, ly);

  if (alphaMode) {
    // Reduce alpha, keep RGB unchanged
    renderer.drawPixel(layer, lx, ly, er, eg, eb, Math.round(ea * (1 - incr)));
  } else {
    // Lerp RGB towards secondary color, preserve alpha
    renderer.drawPixel(
      layer,
      lx,
      ly,
      Math.round(er + (secR - er) * incr),
      Math.round(eg + (secG - eg) * incr),
      Math.round(eb + (secB - eb) * incr),
      ea,
    );
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
  softness: number,
  touched?: Map<number, number>,
  sel?: SelMask,
  tiledW?: number,
  tiledH?: number,
): void {
  const radius = size / 2;
  const iRadius = Math.ceil(radius);
  const bf = strength / 100;
  // softness 0..1 — fraction of the radius over which alpha falls off.
  // soft=0 → hard edge (full bf inside the disc).
  // soft=1 → falloff begins at the centre, linear to 0 at the rim.
  const soft = Math.max(0, Math.min(1, softness / 100));
  const inner = radius * (1 - soft);
  const fadeSpan = radius - inner;
  for (let dy = -iRadius; dy <= iRadius; dy++) {
    for (let dx = -iRadius; dx <= iRadius; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > radius) continue;
      const coverage =
        soft === 0 || dist <= inner
          ? 1
          : Math.max(0, 1 - (dist - inner) / fadeSpan);
      if (coverage <= 0) continue;
      erasePixelOp(
        renderer,
        layer,
        cx + dx,
        cy + dy,
        secR,
        secG,
        secB,
        bf * coverage,
        alphaMode,
        touched,
        sel,
        tiledW,
        tiledH,
      );
    }
  }
}

function eraseAASegment(
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
  strength: number,
  alphaMode: boolean,
  softness: number,
  touched?: Map<number, number>,
  sel?: SelMask,
  tiledW?: number,
  tiledH?: number,
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
  const soft = Math.max(0, Math.min(1, softness / 100));
  const inner = radius * (1 - soft);
  const fadeSpan = radius - inner;

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
        dist = Math.sqrt((px - x0 - t * sdx) ** 2 + (py - y0 - t * sdy) ** 2);
      }
      // AA edge coverage (sub-pixel feather at the rim, always present).
      const aaCoverage = Math.max(0, Math.min(1, radius + 0.5 - dist));
      if (aaCoverage <= 0) continue;
      // Softness falloff (radial), composed with the AA edge.
      const softCoverage =
        soft === 0 || dist <= inner
          ? 1
          : Math.max(0, 1 - (dist - inner) / fadeSpan);
      const coverage = aaCoverage * softCoverage;
      if (coverage > 0) {
        erasePixelOp(
          renderer,
          layer,
          px,
          py,
          secR,
          secG,
          secB,
          (strength / 100) * coverage,
          alphaMode,
          touched,
          sel,
          tiledW,
          tiledH,
        );
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
 * softness: 0-100 (0 = hard disc, 100 = full radial linear falloff to the rim).
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
  softness = 0,
  touched?: Map<number, number>,
  sel?: SelMask,
  tiledW?: number,
  tiledH?: number,
): void {
  const bf = strength / 100;
  if (antiAlias) {
    if (size <= 1) {
      wuLine(x0, y0, x1, y1, (x, y, coverage) => {
        erasePixelOp(
          renderer,
          layer,
          x,
          y,
          secR,
          secG,
          secB,
          bf * coverage,
          alphaMode,
          touched,
          sel,
          tiledW,
          tiledH,
        );
      });
    } else {
      eraseAASegment(
        renderer,
        layer,
        x0,
        y0,
        x1,
        y1,
        size,
        secR,
        secG,
        secB,
        strength,
        alphaMode,
        softness,
        touched,
        sel,
        tiledW,
        tiledH,
      );
    }
  } else {
    if (size <= 1) {
      bresenham(x0, y0, x1, y1, (x, y) => {
        erasePixelOp(
          renderer,
          layer,
          x,
          y,
          secR,
          secG,
          secB,
          bf,
          alphaMode,
          touched,
          sel,
          tiledW,
          tiledH,
        );
      });
    } else {
      bresenham(x0, y0, x1, y1, (cx, cy) => {
        eraseStampCircle(
          renderer,
          layer,
          cx,
          cy,
          size,
          secR,
          secG,
          secB,
          strength,
          alphaMode,
          softness,
          touched,
          sel,
          tiledW,
          tiledH,
        );
      });
    }
  }
}

/**
 * Walk a quadratic Bézier from (p0x,p0y) to (p1x,p1y) guided by control
 * point (cpx,cpy), erasing along the arc with stamp-spaced sub-segments.
 *
 * Mirrors the brush's `walkQuadBezier`: samples the curve at intervals of
 * ~0.2 × radius and calls `eraseThickLine` between consecutive samples so
 * the AA-capsule / circle stamps tile seamlessly along curvature.
 */
export function eraseQuadBezier(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  p0x: number,
  p0y: number,
  cpx: number,
  cpy: number,
  p1x: number,
  p1y: number,
  size: number,
  secR: number,
  secG: number,
  secB: number,
  strength: number,
  alphaMode: boolean,
  antiAlias: boolean,
  softness: number,
  touched?: Map<number, number>,
  sel?: SelMask,
  tiledW?: number,
  tiledH?: number,
): void {
  const arcEst =
    Math.hypot(cpx - p0x, cpy - p0y) + Math.hypot(p1x - cpx, p1y - cpy);
  const spacing = Math.max(1, size * 0.2);
  const steps = Math.max(1, Math.ceil(arcEst / spacing));

  let prevX = p0x;
  let prevY = p0y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const t1 = 1 - t;
    const x = t1 * t1 * p0x + 2 * t1 * t * cpx + t * t * p1x;
    const y = t1 * t1 * p0y + 2 * t1 * t * cpy + t * t * p1y;
    eraseThickLine(
      renderer,
      layer,
      prevX,
      prevY,
      x,
      y,
      size,
      secR,
      secG,
      secB,
      strength,
      alphaMode,
      antiAlias,
      softness,
      touched,
      sel,
      tiledW,
      tiledH,
    );
    prevX = x;
    prevY = y;
  }
}
