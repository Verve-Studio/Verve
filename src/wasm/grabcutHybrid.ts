import {
  gpuComputeNLinks,
  gpuComputeDataTerms,
  isGrabCutComputeReady,
} from "@/graphicspipeline/webgpu/compute/grabcutCompute";
import {
  grabCutComputeBeta,
  grabCutKmeansInit,
  grabCutUpdateGmms,
  grabCutMincut,
  grabCut,
} from "./index";

const K = 5;
const TARGET_MAX_DIM = 1200; // downsample so longest side is ≤ this

function chooseScale(w: number, h: number): number {
  const m = Math.max(w, h);
  if (m <= TARGET_MAX_DIM) return 1;
  return Math.min(4, Math.ceil(m / TARGET_MAX_DIM));
}

function downsamplePixels(
  src: Uint8Array,
  sw: number,
  sh: number,
  s: number,
): { data: Uint8Array; w: number; h: number } {
  const dw = Math.max(1, Math.floor(sw / s));
  const dh = Math.max(1, Math.floor(sh / s));
  const out = new Uint8Array(dw * dh * 4);
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      const ymax = Math.min(sh, (dy + 1) * s);
      const xmax = Math.min(sw, (dx + 1) * s);
      for (let y = dy * s; y < ymax; y++) {
        for (let x = dx * s; x < xmax; x++) {
          const si = (y * sw + x) * 4;
          r += src[si];
          g += src[si + 1];
          b += src[si + 2];
          a += src[si + 3];
          n++;
        }
      }
      const di = (dy * dw + dx) * 4;
      out[di] = (r / n) | 0;
      out[di + 1] = (g / n) | 0;
      out[di + 2] = (b / n) | 0;
      out[di + 3] = (a / n) | 0;
    }
  }
  return { data: out, w: dw, h: dh };
}

function downsampleTrimap(
  src: Uint8Array,
  sw: number,
  sh: number,
  s: number,
): { data: Uint8Array; w: number; h: number } {
  // A downsampled cell is FG only if all source pixels are FG (255), BG only if
  // all are BG (0); otherwise unknown (128). Conservative — keeps the band wide.
  const dw = Math.max(1, Math.floor(sw / s));
  const dh = Math.max(1, Math.floor(sh / s));
  const out = new Uint8Array(dw * dh);
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      let allFg = true,
        allBg = true;
      const ymax = Math.min(sh, (dy + 1) * s);
      const xmax = Math.min(sw, (dx + 1) * s);
      for (let y = dy * s; y < ymax; y++) {
        for (let x = dx * s; x < xmax; x++) {
          const v = src[y * sw + x];
          if (v !== 255) allFg = false;
          if (v !== 0) allBg = false;
          if (!allFg && !allBg) break;
        }
        if (!allFg && !allBg) break;
      }
      out[dy * dw + dx] = allFg ? 255 : allBg ? 0 : 128;
    }
  }
  return { data: out, w: dw, h: dh };
}

function upsampleMask(
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  s: number,
): Uint8Array {
  // Bilinear interpolation on the binary mask (treated as 0/255), then
  // threshold at 128. This gives sub-pixel-accurate edges instead of
  // nearest-neighbour stairsteps.
  const out = new Uint8Array(dw * dh);
  const invS = 1 / s;
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * invS - 0.5;
    const y0 = Math.floor(fy);
    const y1 = y0 + 1;
    const wy = fy - y0;
    const cy0 = y0 < 0 ? 0 : y0 >= sh ? sh - 1 : y0;
    const cy1 = y1 < 0 ? 0 : y1 >= sh ? sh - 1 : y1;
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) * invS - 0.5;
      const x0 = Math.floor(fx);
      const x1 = x0 + 1;
      const wx = fx - x0;
      const cx0 = x0 < 0 ? 0 : x0 >= sw ? sw - 1 : x0;
      const cx1 = x1 < 0 ? 0 : x1 >= sw ? sw - 1 : x1;
      const v00 = src[cy0 * sw + cx0];
      const v01 = src[cy0 * sw + cx1];
      const v10 = src[cy1 * sw + cx0];
      const v11 = src[cy1 * sw + cx1];
      const v =
        v00 * (1 - wx) * (1 - wy) +
        v01 * wx * (1 - wy) +
        v10 * (1 - wx) * wy +
        v11 * wx * wy;
      out[y * dw + x] = v >= 128 ? 255 : 0;
    }
  }
  return out;
}

export async function grabCutHybrid(
  pixels: Uint8Array,
  w: number,
  h: number,
  trimap: Uint8Array,
  iterations: number = 3,
): Promise<Uint8Array> {
  if (!isGrabCutComputeReady()) {
    return grabCut(pixels, w, h, trimap, iterations, K);
  }

  const t0 = performance.now();
  const scale = chooseScale(w, h);

  let workPixels = pixels;
  let workTrimap = trimap;
  let ww = w,
    wh = h;
  let tDS = 0;
  if (scale > 1) {
    const ds0 = performance.now();
    const dp = downsamplePixels(pixels, w, h, scale);
    const dt = downsampleTrimap(trimap, w, h, scale);
    workPixels = dp.data;
    workTrimap = dt.data;
    ww = dp.w;
    wh = dp.h;
    tDS = performance.now() - ds0;
  }
  const n = ww * wh;

  const tBeta0 = performance.now();
  const beta = await grabCutComputeBeta(workPixels, ww, wh);
  const tBeta = performance.now() - tBeta0;

  const tNL0 = performance.now();
  const { hW, vW } = await gpuComputeNLinks(workPixels, ww, wh, beta);
  const tNL = performance.now() - tNL0;

  const tKM0 = performance.now();
  let params = await grabCutKmeansInit(workPixels, ww, wh, workTrimap, K);
  const tKM = performance.now() - tKM0;

  let label: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) label[i] = workTrimap[i] >= 128 ? 1 : 0;

  let tGMM = 0,
    tDT = 0,
    tMC = 0;
  for (let iter = 0; iter < iterations; iter++) {
    const a = performance.now();
    params = await grabCutUpdateGmms(workPixels, ww, wh, label, K, params);
    const b = performance.now();
    const { capS, capT } = await gpuComputeDataTerms(
      workPixels,
      workTrimap,
      ww,
      wh,
      params,
    );
    const c = performance.now();
    label = await grabCutMincut(capS, capT, hW, vW, workTrimap, ww, wh);
    const d = performance.now();
    tGMM += b - a;
    tDT += c - b;
    tMC += d - c;
  }

  const tUS0 = performance.now();
  const lowMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) lowMask[i] = label[i] ? 255 : 0;
  const out = scale > 1 ? upsampleMask(lowMask, ww, wh, w, h, scale) : lowMask;
  // Re-apply original trimap hard constraints at full res so the boundary
  // doesn't get blocky from nearest-neighbour upsample of definite regions.
  if (scale > 1) {
    for (let i = 0; i < w * h; i++) {
      if (trimap[i] === 255) out[i] = 255;
      else if (trimap[i] === 0) out[i] = 0;
    }
  }
  const tUS = performance.now() - tUS0;

  const tTotal = performance.now() - t0;
  console.log(
    `[grabCutHybrid] ${w}×${h}→${ww}×${wh} (s=${scale}), ${iterations}it: total=${tTotal.toFixed(0)}ms` +
      ` | ds=${tDS.toFixed(0)} beta=${tBeta.toFixed(0)} nlinks=${tNL.toFixed(0)} kmeans=${tKM.toFixed(0)}` +
      ` updateGMMs=${tGMM.toFixed(0)} dataTerms=${tDT.toFixed(0)} mincut=${tMC.toFixed(0)} us=${tUS.toFixed(0)}`,
  );
  return out;
}
