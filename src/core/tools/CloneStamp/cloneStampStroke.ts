import type {
  WebGPURenderer,
  GpuLayer,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import { blendPixelOver } from "../_shared/primitives";
import type { SelMask, TouchedBuffer } from "../_shared/primitives";
import { linearToSrgbChannel } from "@/utils/pixelFormatConvert";
import type { CowLayerSnapshot } from "../_shared/cowLayerSnapshot";

/** Where a clone stamp reads from: a canvas-sized composite buffer
 *  ("sample all layers"), or a layer view (stroke-start copy-on-write
 *  snapshot for the painted layer, live view for another layer). */
export type CloneSource =
  | { kind: "canvas"; data: Uint8Array | Float32Array }
  | { kind: "layer"; snapshot: CowLayerSnapshot };

/**
 * Paints a clone-stamp capsule segment from (x0,y0) to (x1,y1).
 * For each pixel in the capsule SDF area, the source color is sampled from
 * `source` at (canvasX + offsetDX, canvasY + offsetDY) and composited
 * onto `destLayer` using Porter-Duff "over" with per-stroke coverage tracking.
 *
 * @param offsetDX        source = dest + offset (X); computed at stroke start
 * @param offsetDY        source = dest + offset (Y)
 * @param source          canvas-sized composite (canvasW × canvasH × 4) or a layer
 *                        snapshot; a snapshot of `destLayer` must already have
 *                        `protect`ed this segment's write box
 * @param hardness        0-100; 100 = hard circular edge, lower = SDF feather
 */
export function stampCloneSegment(
  renderer: WebGPURenderer,
  destLayer: GpuLayer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
  hardness: number,
  offsetDX: number,
  offsetDY: number,
  source: CloneSource,
  canvasW: number,
  canvasH: number,
  opacity: number,
  touched?: TouchedBuffer,
  sel?: SelMask,
  tiledW?: number,
  tiledH?: number,
): void {
  const radius = size / 2;
  const pad = Math.ceil(radius) + 1;
  const sdx = x1 - x0,
    sdy = y1 - y0;
  const lenSq = sdx * sdx + sdy * sdy;

  const featherBand = Math.max(0.5, radius * (1 - hardness / 100));
  const innerRadius = Math.max(0, radius - featherBand);

  const minX = Math.floor(Math.min(x0, x1)) - pad;
  const maxX = Math.ceil(Math.max(x0, x1)) + pad;
  const minY = Math.floor(Math.min(y0, y1)) - pad;
  const maxY = Math.ceil(Math.max(y0, y1)) + pad;

  const canvasBuf = source.kind === "canvas" ? source.data : null;
  const snapshot = source.kind === "layer" ? source.snapshot : null;
  const isF32 = canvasBuf
    ? canvasBuf instanceof Float32Array
    : snapshot!.isFloat;
  const sample = new Float64Array(4);

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
        const nearX = x0 + t * sdx,
          nearY = y0 + t * sdy;
        dist = Math.sqrt((px - nearX) ** 2 + (py - nearY) ** 2);
      }
      if (dist > radius) continue;

      const coverage =
        dist <= innerRadius ? 1 : Math.max(0, (radius - dist) / featherBand);
      if (coverage <= 0) continue;

      const srcX = px + offsetDX;
      const srcY = py + offsetDY;

      let sr = 0,
        sg = 0,
        sb = 0,
        sa = 0;
      if (canvasBuf) {
        let sx = Math.round(srcX),
          sy = Math.round(srcY);
        if (tiledW !== undefined && tiledH !== undefined) {
          sx = ((sx % tiledW) + tiledW) % tiledW;
          sy = ((sy % tiledH) + tiledH) % tiledH;
        }
        if (sx >= 0 && sy >= 0 && sx < canvasW && sy < canvasH) {
          const i = (sy * canvasW + sx) * 4;
          sr = canvasBuf[i];
          sg = canvasBuf[i + 1];
          sb = canvasBuf[i + 2];
          sa = canvasBuf[i + 3];
        }
      } else if (
        snapshot!.sampleLocal(
          Math.round(srcX) - snapshot!.offsetX,
          Math.round(srcY) - snapshot!.offsetY,
          sample,
        )
      ) {
        sr = sample[0];
        sg = sample[1];
        sb = sample[2];
        sa = sample[3];
      }
      if (sa === 0) continue;

      // Source/destination format matrix:
      //   src f32 (linear) → dest f32 (linear): pass srcFloat through as-is
      //   src f32 (linear) → dest rgba8 (sRGB): encode linear → sRGB byte
      //   src rgba8 (sRGB) → dest f32 (linear): byte path; blendPixelOver
      //                                          gamma-decodes internally
      //   src rgba8 (sRGB) → dest rgba8 (sRGB): byte path as-is
      const destIsF32 = destLayer.format === "rgba32f";
      let br = sr,
        bg = sg,
        bb = sb,
        ba = sa;
      let srcFloat: readonly [number, number, number, number] | undefined;
      if (isF32) {
        if (destIsF32) {
          srcFloat = [sr, sg, sb, sa];
        } else {
          // Linear-light → sRGB byte for rgba8 destination
          br = Math.round(Math.max(0, Math.min(1, linearToSrgbChannel(sr))) * 255);
          bg = Math.round(Math.max(0, Math.min(1, linearToSrgbChannel(sg))) * 255);
          bb = Math.round(Math.max(0, Math.min(1, linearToSrgbChannel(sb))) * 255);
          ba = Math.round(Math.max(0, Math.min(1, sa)) * 255);
        }
      }
      blendPixelOver(
        renderer,
        destLayer,
        px,
        py,
        br,
        bg,
        bb,
        ba,
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
