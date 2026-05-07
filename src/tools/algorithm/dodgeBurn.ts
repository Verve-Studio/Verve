import type {
  WebGPURenderer,
  GpuLayer,
} from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { bresenham, wuLine } from "./primitives";
import type { SelMask } from "./primitives";

/** Range channels covered by dodge/burn. */
export type DodgeBurnRange = "shadows" | "midtones" | "highlights";

/**
 * Compute the per-pixel exposure factor for dodge/burn.
 *
 * @param luminance  0–1 linear luminance of the existing pixel
 * @param range      Which tonal range to target
 * @returns          0–1 weight (1 = full effect at the sweet-spot, 0 = no effect)
 */
function toneWeight(luminance: number, range: DodgeBurnRange): number {
  switch (range) {
    case "shadows":
      return Math.max(0, 1 - luminance * 3);
    case "highlights":
      return Math.max(0, luminance * 3 - 2);
    default:
      return Math.max(0, 1 - Math.abs(luminance - 0.5) * 4);
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

  let maxCoverage = coverage;
  if (touched !== undefined) {
    const key = canvasY * renderer.pixelWidth + canvasX;
    const prev = touched.get(key) ?? 0;
    if (prev >= coverage) return;
    touched.set(key, coverage);
    maxCoverage = coverage;
  }

  if (maxCoverage <= 0) return;

  const key = canvasY * renderer.pixelWidth + canvasX;
  let r: number, g: number, b: number, a: number;
  if (origData) {
    let orig = origData.get(key);
    if (!orig) {
      orig = renderer.samplePixel(layer, lx, ly);
      origData.set(key, orig);
    }
    [r, g, b, a] = orig;
  } else {
    [r, g, b, a] = renderer.samplePixel(layer, lx, ly);
  }
  if (a === 0) return;

  const rl = r / 255,
    gl = g / 255,
    bl = b / 255;
  const lum = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
  const weight = toneWeight(lum, range);
  if (weight <= 0) return;

  const factor = 1 + exposure * maxCoverage * weight;
  renderer.drawPixel(
    layer,
    lx,
    ly,
    Math.max(0, Math.min(255, Math.round(r * factor))),
    Math.max(0, Math.min(255, Math.round(g * factor))),
    Math.max(0, Math.min(255, Math.round(b * factor))),
    a,
  );
}

function dodgeBurnStampCircle(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  cx: number,
  cy: number,
  size: number,
  exposure: number,
  range: DodgeBurnRange,
  hardness: number,
  antiAlias: boolean,
  touched?: Map<number, number>,
  sel?: SelMask,
  origData?: Map<number, readonly [number, number, number, number]>,
): void {
  const radius = size / 2;
  const outerR = antiAlias ? radius + 0.5 : radius;
  const iRadius = Math.ceil(outerR) + 1;
  const hardR = radius * (hardness / 100);
  const softZone = radius - hardR;

  for (let dy = -iRadius; dy <= iRadius; dy++) {
    for (let dx = -iRadius; dx <= iRadius; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > outerR) continue;

      const edgeFactor = antiAlias ? Math.min(1, outerR - dist) : 1;
      let softFactor: number;
      if (softZone <= 0 || dist <= hardR) {
        softFactor = 1;
      } else {
        const t = (dist - hardR) / softZone;
        softFactor = 0.5 * (1 + Math.cos(Math.PI * t));
      }
      const coverage = edgeFactor * softFactor;
      if (coverage <= 0) continue;
      dodgeBurnPixelOp(
        renderer,
        layer,
        cx + dx,
        cy + dy,
        exposure,
        coverage,
        range,
        touched,
        sel,
        origData,
      );
    }
  }
}

function dodgeBurnAASegment(
  renderer: WebGPURenderer,
  layer: GpuLayer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
  exposure: number,
  range: DodgeBurnRange,
  hardness: number,
  touched?: Map<number, number>,
  sel?: SelMask,
  origData?: Map<number, readonly [number, number, number, number]>,
): void {
  const radius = size / 2;
  const outerR = radius + 0.5;
  const hardR = radius * (hardness / 100);
  const softZone = radius - hardR;
  const pad = Math.ceil(outerR) + 1;
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
        dist = Math.sqrt((px - x0 - t * sdx) ** 2 + (py - y0 - t * sdy) ** 2);
      }
      if (dist > outerR) continue;

      const edgeFactor = Math.min(1, outerR - dist);
      let softFactor: number;
      if (softZone <= 0 || dist <= hardR) {
        softFactor = 1;
      } else {
        const t = (dist - hardR) / softZone;
        softFactor = 0.5 * (1 + Math.cos(Math.PI * t));
      }
      const coverage = edgeFactor * softFactor;
      if (coverage > 0) {
        dodgeBurnPixelOp(
          renderer,
          layer,
          px,
          py,
          exposure,
          coverage,
          range,
          touched,
          sel,
          origData,
        );
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
  x0: number,
  y0: number,
  x1: number,
  y1: number,
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
        dodgeBurnPixelOp(
          renderer,
          layer,
          x,
          y,
          exposure,
          coverage,
          range,
          touched,
          sel,
          origData,
        );
      });
    } else {
      dodgeBurnAASegment(
        renderer,
        layer,
        x0,
        y0,
        x1,
        y1,
        size,
        exposure,
        range,
        hardness,
        touched,
        sel,
        origData,
      );
    }
  } else {
    if (size <= 1) {
      bresenham(x0, y0, x1, y1, (x, y) => {
        dodgeBurnPixelOp(
          renderer,
          layer,
          x,
          y,
          exposure,
          1,
          range,
          touched,
          sel,
          origData,
        );
      });
    } else {
      bresenham(x0, y0, x1, y1, (cx, cy) => {
        dodgeBurnStampCircle(
          renderer,
          layer,
          cx,
          cy,
          size,
          exposure,
          range,
          hardness,
          antiAlias,
          touched,
          sel,
          origData,
        );
      });
    }
  }
}
