/**
 * Shared helpers for "local effect" brushes (Blur, Sharpen, Smudge, Liquify…)
 *
 *   • `forEachBrushPixel`   — visit every pixel inside a circular brush
 *     footprint (clipped to the layer rect) with a precomputed weight =
 *     strength × falloff.
 *   • `forEachStamp`        — interpolate stamps along a brush stroke segment
 *     so a fast pointer drag still produces a continuous effect rather than
 *     widely-spaced disks.
 */

export interface BrushFootprint {
  /** Brush center in layer-local pixels. */
  cxL: number;
  cyL: number;
  radius: number;
  /** 0..1 — fraction of the radius at full strength. 1 = hard edge. */
  hardness01: number;
  /** 0..1 — global multiplier on the per-pixel weight. */
  strength01: number;
}

/**
 * Brush falloff (1 at center, 0 at edge). hardness01 controls the size of the
 * fully-strong inner core; outside the core a cosine ramp brings it to 0 at
 * t = 1.
 */
export function brushFalloff(t: number, hardness01: number): number {
  if (t >= 1) return 0;
  if (t <= hardness01) return 1;
  const u = (t - hardness01) / Math.max(1e-6, 1 - hardness01);
  return 0.5 + 0.5 * Math.cos(Math.PI * u);
}

/**
 * Walk every pixel within the brush radius (clipped to layer bounds), calling
 * `cb(lx, ly, weight)`. `weight = strength01 × falloff` and is guaranteed > 0.
 */
export function forEachBrushPixel(
  layerW: number,
  layerH: number,
  p: BrushFootprint,
  cb: (lx: number, ly: number, weight: number) => void,
): void {
  const { cxL, cyL, radius, hardness01, strength01 } = p;
  const r2 = radius * radius;
  const minLx = Math.max(0, Math.floor(cxL - radius));
  const maxLx = Math.min(layerW - 1, Math.ceil(cxL + radius));
  const minLy = Math.max(0, Math.floor(cyL - radius));
  const maxLy = Math.min(layerH - 1, Math.ceil(cyL + radius));
  if (minLx > maxLx || minLy > maxLy) return;
  for (let ly = minLy; ly <= maxLy; ly++) {
    const dy = ly - cyL;
    for (let lx = minLx; lx <= maxLx; lx++) {
      const dx = lx - cxL;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const t = Math.sqrt(d2) / radius;
      const f = brushFalloff(t, hardness01);
      const w = f * strength01;
      if (w <= 0) continue;
      cb(lx, ly, w);
    }
  }
}

/**
 * Visit a series of brush-center positions along the segment (prev → cur)
 * spaced at `spacing` pixels apart. The first stamp is at `cur` if the segment
 * is shorter than `spacing`; otherwise the segment is subdivided so adjacent
 * stamps overlap by ~75% (typical `spacing = radius * 0.25`).
 */
export function forEachStamp(
  prevX: number,
  prevY: number,
  curX: number,
  curY: number,
  spacing: number,
  cb: (cx: number, cy: number) => void,
): void {
  const dx = curX - prevX;
  const dy = curY - prevY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < spacing) {
    cb(curX, curY);
    return;
  }
  const steps = Math.max(1, Math.round(dist / spacing));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    cb(prevX + dx * t, prevY + dy * t);
  }
}

/**
 * Mark the full brush footprint as dirty on a layer (the layer's `dirtyRect`
 * gets expanded to include this stamp's bounding rect).
 */
export function markBrushDirty(
  layer: {
    layerWidth: number;
    layerHeight: number;
    dirtyRect: { lx: number; ly: number; rx: number; ry: number } | null;
  },
  cxL: number,
  cyL: number,
  radius: number,
): void {
  const minLx = Math.max(0, Math.floor(cxL - radius));
  const maxLx = Math.min(layer.layerWidth - 1, Math.ceil(cxL + radius));
  const minLy = Math.max(0, Math.floor(cyL - radius));
  const maxLy = Math.min(layer.layerHeight - 1, Math.ceil(cyL + radius));
  if (!layer.dirtyRect) {
    layer.dirtyRect = {
      lx: minLx,
      ly: minLy,
      rx: maxLx + 1,
      ry: maxLy + 1,
    };
  } else {
    layer.dirtyRect.lx = Math.min(layer.dirtyRect.lx, minLx);
    layer.dirtyRect.ly = Math.min(layer.dirtyRect.ly, minLy);
    layer.dirtyRect.rx = Math.max(layer.dirtyRect.rx, maxLx + 1);
    layer.dirtyRect.ry = Math.max(layer.dirtyRect.ry, maxLy + 1);
  }
}
