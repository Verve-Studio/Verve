import type {
  WebGPURenderer,
  GpuLayer,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import { blendPixelOver } from "../_shared/primitives";
import type { SelMask } from "../_shared/primitives";
import { linearToSrgbChannel } from "@/utils/pixelFormatConvert";

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
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
  hardness: number,
  offsetDX: number,
  offsetDY: number,
  sourceBuffer: Uint8Array | Float32Array,
  sourceIsCanvas: boolean,
  sourceBounds: {
    offsetX: number;
    offsetY: number;
    layerWidth: number;
    layerHeight: number;
  } | null,
  canvasW: number,
  canvasH: number,
  opacity: number,
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

  const featherBand = Math.max(0.5, radius * (1 - hardness / 100));
  const innerRadius = Math.max(0, radius - featherBand);

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
      const isF32 = sourceBuffer instanceof Float32Array;
      if (sourceIsCanvas) {
        let sx = Math.round(srcX),
          sy = Math.round(srcY);
        if (tiledW !== undefined && tiledH !== undefined) {
          sx = ((sx % tiledW) + tiledW) % tiledW;
          sy = ((sy % tiledH) + tiledH) % tiledH;
        }
        if (sx >= 0 && sy >= 0 && sx < canvasW && sy < canvasH) {
          const i = (sy * canvasW + sx) * 4;
          sr = sourceBuffer[i];
          sg = sourceBuffer[i + 1];
          sb = sourceBuffer[i + 2];
          sa = sourceBuffer[i + 3];
        }
      } else if (sourceBounds) {
        const lx = Math.round(srcX) - sourceBounds.offsetX;
        const ly = Math.round(srcY) - sourceBounds.offsetY;
        if (
          lx >= 0 &&
          ly >= 0 &&
          lx < sourceBounds.layerWidth &&
          ly < sourceBounds.layerHeight
        ) {
          const i = (ly * sourceBounds.layerWidth + lx) * 4;
          sr = sourceBuffer[i];
          sg = sourceBuffer[i + 1];
          sb = sourceBuffer[i + 2];
          sa = sourceBuffer[i + 3];
        }
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
