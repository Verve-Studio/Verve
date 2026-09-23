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

import type { ToolContext } from "./types";

/** Active selection, mapped onto a layer (canvas-sized mask). */
export interface BrushSelection {
  mask: Uint8Array;
  width: number;
  height: number;
  /** Layer offset on the canvas (layer-local → canvas coordinates). */
  offsetX: number;
  offsetY: number;
}

/** The context's selection for the active layer, or null if none. */
export function brushSelection(ctx: ToolContext): BrushSelection | null {
  const mask = ctx.selectionMask;
  if (!mask) return null;
  return {
    mask,
    width: ctx.renderer.pixelWidth,
    height: ctx.renderer.pixelHeight,
    offsetX: ctx.layer.offsetX,
    offsetY: ctx.layer.offsetY,
  };
}

/** Selection coverage (0–1) at a layer-local pixel. */
export function selectionWeight(sel: BrushSelection, lx: number, ly: number): number {
  const x = lx + sel.offsetX;
  const y = ly + sel.offsetY;
  if (x < 0 || y < 0 || x >= sel.width || y >= sel.height) return 0;
  return sel.mask[y * sel.width + x] / 255;
}

const scratchPool = new Map<number, Uint8Array | Float32Array>();

/**
 * Reusable per-stamp scratch buffer (`slot` distinguishes buffers a stamp
 * needs at the same time). Stamps run many times per pointer move; fresh
 * typed arrays each time were pure allocation churn. Contents are stale —
 * callers overwrite what they read.
 */
export function scratchBuffer(
  slot: number,
  isFloat: boolean,
  length: number,
): Uint8Array | Float32Array {
  const key = slot * 2 + (isFloat ? 1 : 0);
  let buf = scratchPool.get(key);
  if (!buf || buf.length < length) {
    buf = isFloat ? new Float32Array(length) : new Uint8Array(length);
    scratchPool.set(key, buf);
  }
  return buf.subarray(0, length);
}

/** Copy a layer-local rect of RGBA pixels into `dst` (tightly packed). */
export function copyLayerRect(
  data: Uint8Array | Float32Array,
  layerW: number,
  minLx: number,
  minLy: number,
  bw: number,
  bh: number,
  dst: Uint8Array | Float32Array,
): void {
  for (let y = 0; y < bh; y++) {
    const from = ((minLy + y) * layerW + minLx) * 4;
    dst.set(data.subarray(from, from + bw * 4), y * bw * 4);
  }
}

/** Upload the stamps' dirty region (if any) and re-render. Flushing with no
 *  pending dirty rect would upload the whole layer. */
export function flushStamps(ctx: ToolContext): void {
  if (ctx.renderer.hasPendingUpload(ctx.layer)) {
    ctx.renderer.flushLayer(ctx.layer);
  }
  ctx.render();
}

export interface BrushFootprint {
  /** Brush center in layer-local pixels. */
  cxL: number;
  cyL: number;
  radius: number;
  /** 0..1 — fraction of the radius at full strength. 1 = hard edge. */
  hardness01: number;
  /** 0..1 — global multiplier on the per-pixel weight. */
  strength01: number;
  /** When set, the weight is scaled by the selection (0 = untouched). */
  selection?: BrushSelection | null;
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
  const { cxL, cyL, radius, hardness01, strength01, selection } = p;
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
      let w = f * strength01;
      if (selection) w *= selectionWeight(selection, lx, ly);
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
 * Mark the full brush footprint as dirty on a layer (the layer's pending dirty
 * rect gets expanded through the renderer to include this stamp's bounding box).
 */
export function markBrushDirty(
  renderer: import("@/graphics/webgpu/rendering/WebGPURenderer").WebGPURenderer,
  layer: import("@/graphics/webgpu/rendering/WebGPURenderer").GpuLayer,
  cxL: number,
  cyL: number,
  radius: number,
): void {
  const minLx = Math.max(0, Math.floor(cxL - radius));
  const maxLx = Math.min(layer.layerWidth - 1, Math.ceil(cxL + radius));
  const minLy = Math.max(0, Math.floor(cyL - radius));
  const maxLy = Math.min(layer.layerHeight - 1, Math.ceil(cyL + radius));
  renderer.markDirtyRect(layer, minLx, minLy, maxLx + 1, maxLy + 1);
}
