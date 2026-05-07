import type {
  WebGPURenderer,
  GpuLayer,
} from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { blendPixelOver } from "./primitives";
import type { SelMask } from "./primitives";

/** Brush shape metric used by the airbrush stamp. */
export type BrushShape = "round" | "square" | "diamond";

/** Compute distance from origin using the shape's metric. */
function shapeDistance(dx: number, dy: number, shape: BrushShape): number {
  if (shape === "square") return Math.max(Math.abs(dx), Math.abs(dy));
  if (shape === "diamond") return (Math.abs(dx) + Math.abs(dy)) / Math.SQRT2;
  return Math.sqrt(dx * dx + dy * dy); // round
}

/**
 * Stamp a soft-edged (airbrush-style) brush at canvas point (cx, cy).
 *
 * hardness: 0–100.
 *   100 = hard binary edge (full opacity inside radius, nothing outside).
 *   0   = full cosine smooth falloff from centre to edge.
 * shape:  'round' | 'square' | 'diamond' — distance metric for the brush footprint.
 * opacity: 0–100 tool opacity (multiplied together with per-pixel coverage).
 */
export function stampAirbrush(
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
  hardness: number,
  shape: BrushShape,
  antiAlias = false,
  touched?: Map<number, number>,
  sel?: SelMask,
  tiledW?: number,
  tiledH?: number,
  srcFloat?: readonly [number, number, number, number],
): void {
  const radius = size / 2;
  const outerR = antiAlias ? radius + 0.5 : radius;
  const iRadius = Math.ceil(outerR) + 1;
  const hardR = radius * (hardness / 100);
  const softZone = radius - hardR;

  for (let dy = -iRadius; dy <= iRadius; dy++) {
    for (let dx = -iRadius; dx <= iRadius; dx++) {
      const dist = shapeDistance(dx, dy, shape);
      if (dist > outerR) continue;

      // Sub-pixel feather at the outer boundary (AA only)
      const edgeFactor = antiAlias ? Math.min(1, outerR - dist) : 1;

      let softFactor: number;
      if (softZone <= 0 || dist <= hardR) {
        softFactor = 1;
      } else {
        // Cosine falloff in the soft zone: smooth S-curve from 1→0
        const t = (dist - hardR) / softZone;
        softFactor = 0.5 * (1 + Math.cos(Math.PI * t));
      }

      const coverage = edgeFactor * softFactor;
      if (coverage <= 0) continue;

      blendPixelOver(
        renderer,
        layer,
        cx + dx,
        cy + dy,
        r,
        g,
        b,
        a,
        opacity * coverage,
        touched,
        sel,
        tiledW,
        tiledH,
        srcFloat,
      );
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
  hardness: number,
  shape: BrushShape,
  antiAlias: boolean,
  touched?: Map<number, number>,
  sel?: SelMask,
  tiledW?: number,
  tiledH?: number,
  srcFloat?: readonly [number, number, number, number],
): void {
  const radius = size / 2;
  const outerR = antiAlias ? radius + 0.5 : radius;
  const pad = Math.ceil(outerR) + 1;

  const sdx = x1 - x0,
    sdy = y1 - y0;
  const len = Math.sqrt(sdx * sdx + sdy * sdy);
  const tx = len > 0 ? sdx / len : 1;
  const ty = len > 0 ? sdy / len : 0;

  const minX = Math.floor(Math.min(x0, x1)) - pad;
  const maxX = Math.ceil(Math.max(x0, x1)) + pad;
  const minY = Math.floor(Math.min(y0, y1)) - pad;
  const maxY = Math.ceil(Math.max(y0, y1)) + pad;

  const hardR = radius * (hardness / 100);
  const softZone = radius - hardR;

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      // Nearest canvas-space point on the segment
      const dx = px - x0,
        dy = py - y0;
      const proj = len > 0 ? Math.max(0, Math.min(len, dx * tx + dy * ty)) : 0;
      const nearX = x0 + proj * tx;
      const nearY = y0 + proj * ty;
      const cdx = px - nearX;
      const cdy = py - nearY;

      let dist: number;
      if (shape === "square") {
        dist = Math.max(Math.abs(cdx), Math.abs(cdy));
      } else if (shape === "diamond") {
        dist = Math.abs(cdx) + Math.abs(cdy);
      } else {
        dist = Math.sqrt(cdx * cdx + cdy * cdy);
      }

      if (dist > outerR) continue;

      // Sub-pixel AA feather at the outer boundary
      const edgeFactor = antiAlias ? Math.min(1, outerR - dist) : 1;

      // Cosine soft-zone falloff controlled by hardness
      let softFactor = 1;
      if (softZone > 0 && dist > hardR) {
        const st = (dist - hardR) / softZone;
        softFactor = 0.5 * (1 + Math.cos(Math.PI * st));
      }

      const coverage = edgeFactor * softFactor;
      if (coverage <= 0) continue;

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
        tiledW,
        tiledH,
        srcFloat,
      );
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
  hardness: number,
  shape: BrushShape,
  touched?: Map<number, number>,
  sel?: SelMask,
  tiledW?: number,
  tiledH?: number,
  srcFloat?: readonly [number, number, number, number],
): void {
  const dx = x1 - x0,
    dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const spacing = Math.max(1, size * 0.2);

  if (dist === 0) {
    stampAirbrush(
      renderer,
      layer,
      x0,
      y0,
      size,
      r,
      g,
      b,
      a,
      opacity,
      hardness,
      shape,
      false,
      touched,
      sel,
      tiledW,
      tiledH,
      srcFloat,
    );
    return;
  }

  const steps = Math.max(1, Math.ceil(dist / spacing));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const sx = Math.round(x0 + dx * t);
    const sy = Math.round(y0 + dy * t);
    stampAirbrush(
      renderer,
      layer,
      sx,
      sy,
      size,
      r,
      g,
      b,
      a,
      opacity,
      hardness,
      shape,
      false,
      touched,
      sel,
      tiledW,
      tiledH,
      srcFloat,
    );
  }
}

/**
 * Walk a quadratic Bézier from (p0x,p0y) to (p1x,p1y) guided by control
 * point (cpx,cpy), stamping brush dabs at stamp-spacing intervals.
 *
 * size0/size1 and opacity0/opacity1 are linearly interpolated per-dab along
 * the arc (t = 0..1). Pass the same value for both when no taper is needed.
 * This gives seamless, blob-free transitions when velocity tracking varies
 * size or opacity across arc segments.
 *
 * motionBlur 0‒1: when > 0 each dab becomes a capsule oriented along the
 * local arc tangent, with half-length = sz × motionBlur × 0.5.
 */
export function walkQuadBezier(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  p0x: number,
  p0y: number,
  cpx: number,
  cpy: number,
  p1x: number,
  p1y: number,
  size0: number,
  size1: number,
  r: number,
  g: number,
  b: number,
  a: number,
  opacity0: number,
  opacity1: number,
  hardness: number,
  shape: BrushShape,
  antiAlias: boolean,
  motionBlur = 0,
  touched?: Map<number, number>,
  sel?: SelMask,
  tiledW?: number,
  tiledH?: number,
  srcFloat?: readonly [number, number, number, number],
): void {
  const arcEst =
    Math.hypot(cpx - p0x, cpy - p0y) + Math.hypot(p1x - cpx, p1y - cpy);
  // Use the smaller end-size for spacing so the narrowing tip never leaves gaps.
  const spacing = Math.max(1, Math.min(size0, size1) * 0.2);
  const steps = Math.max(1, Math.ceil(arcEst / spacing));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const t1 = 1 - t;
    const x = t1 * t1 * p0x + 2 * t1 * t * cpx + t * t * p1x;
    const y = t1 * t1 * p0y + 2 * t1 * t * cpy + t * t * p1y;

    // Continuously interpolated size and opacity — eliminates step jumps at arc joints.
    const sz = size0 + (size1 - size0) * t;
    const op = opacity0 + (opacity1 - opacity0) * t;
    const half = sz * motionBlur * 0.5;

    if (half > 0) {
      const dtx = 2 * t1 * (cpx - p0x) + 2 * t * (p1x - cpx);
      const dty = 2 * t1 * (cpy - p0y) + 2 * t * (p1y - cpy);
      const len = Math.sqrt(dtx * dtx + dty * dty);
      if (len > 0) {
        const nx = dtx / len,
          ny = dty / len;
        drawAirbrushCapsule(
          renderer,
          layer,
          x - nx * half,
          y - ny * half,
          x + nx * half,
          y + ny * half,
          sz,
          r,
          g,
          b,
          a,
          op,
          hardness,
          shape,
          antiAlias,
          touched,
          sel,
          tiledW,
          tiledH,
          srcFloat,
        );
      } else {
        stampAirbrush(
          renderer,
          layer,
          Math.round(x),
          Math.round(y),
          sz,
          r,
          g,
          b,
          a,
          op,
          hardness,
          shape,
          antiAlias,
          touched,
          sel,
          tiledW,
          tiledH,
          srcFloat,
        );
      }
    } else {
      stampAirbrush(
        renderer,
        layer,
        Math.round(x),
        Math.round(y),
        sz,
        r,
        g,
        b,
        a,
        op,
        hardness,
        shape,
        antiAlias,
        touched,
        sel,
        tiledW,
        tiledH,
        srcFloat,
      );
    }
  }
}
