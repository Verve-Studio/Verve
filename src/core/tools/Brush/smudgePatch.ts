/**
 * Smudge mode of the paint brush: the brush carries a dab-sized patch of
 * the pixels it moves over and drags it along the stroke (Krita's
 * "smearing", Photoshop's finger painting), so edges, lines and texture
 * smear instead of being averaged into one flat colour per dab.
 *
 * Per spacing step the patch picks up what is under the dab —
 * `patch = strength × carried + (1 − strength) × under` — and the dab then
 * paints the patch back, mixed with `colorRate` of fresh brush colour. At
 * strength 0 the patch is just what's under the dab (no smudge); at 1 the
 * first pickup is dragged along the whole stroke.
 *
 * Pixels are carried premultiplied, in the layer's own value space (sRGB
 * bytes for rgba8, linear light for rgba32f), so transparent areas smear
 * their transparency without dragging in their (meaningless) colour.
 */
import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import {
  ditherBias,
  noteTouchedWrite,
  type SelMask,
  type TouchedBuffer,
} from "../_shared/primitives";

/** A carried patch: premultiplied RGBA, `size × size`, centred on the dab. */
export interface SmudgePatch {
  data: Float32Array;
  size: number;
}

/** The patch to paint for one stamp, positioned on the canvas. */
export interface SmudgeStamp {
  patch: SmudgePatch;
  /** Canvas pixel the patch is centred on. */
  cx: number;
  cy: number;
  /** 0..1 — share of fresh brush colour mixed into the carried paint. */
  colorRate: number;
  /** Brush colour, premultiplied, in the layer's value space. */
  brush: [number, number, number, number];
}

/** Scratch for re-centring a patch when the dab size changes. */
let resizeScratch = new Float32Array(0);
/** One premultiplied pixel read. */
const px4: [number, number, number, number] = [0, 0, 0, 0];

/** Canvas pixel (x, y) of `layer` as premultiplied floats into `px4`
 *  (transparent outside the layer). */
function readPremul(layer: GpuLayer, x: number, y: number): void {
  const lx = x - layer.offsetX;
  const ly = y - layer.offsetY;
  if (lx < 0 || ly < 0 || lx >= layer.layerWidth || ly >= layer.layerHeight) {
    px4[0] = px4[1] = px4[2] = px4[3] = 0;
    return;
  }
  const d = layer.data;
  const i = (ly * layer.layerWidth + lx) * 4;
  if (layer.format === "rgba32f") {
    const a = d[i + 3];
    px4[0] = d[i] * a;
    px4[1] = d[i + 1] * a;
    px4[2] = d[i + 2] * a;
    px4[3] = a;
  } else {
    const a = d[i + 3] / 255;
    const s = a / 255;
    px4[0] = d[i] * s;
    px4[1] = d[i + 1] * s;
    px4[2] = d[i + 2] * s;
    px4[3] = a;
  }
}

const wrap = (v: number, m: number): number => ((v % m) + m) % m;

/**
 * Pick up the pixels under a dab of `radius` centred on canvas pixel
 * (cx, cy) into the carried patch (null = the stroke's first pickup).
 * `tileW/H` wrap reads in tiled mode.
 */
export function pickUpSmudge(
  carried: SmudgePatch | null,
  layer: GpuLayer,
  cx: number,
  cy: number,
  radius: number,
  strength: number,
  tileW?: number,
  tileH?: number,
): SmudgePatch {
  const half = Math.ceil(radius) + 1;
  const size = 2 * half + 1;
  const keep = Math.max(0, Math.min(1, strength));
  let patch: SmudgePatch;
  // Texels outside the carried patch (first pickup, or a bigger dab) start
  // from what's under the dab.
  let oldOff = 0;
  let oldSize = 0;
  let old: Float32Array | null = null;
  if (carried === null) {
    patch = { data: new Float32Array(size * size * 4), size };
  } else if (carried.size === size) {
    patch = carried;
    old = carried.data;
    oldSize = size;
  } else {
    // The dab size changed (pressure): re-centre the carried texels. Copy
    // them aside first — the patch buffer is rewritten in the new layout.
    const oldN = carried.size * carried.size * 4;
    if (resizeScratch.length < oldN) resizeScratch = new Float32Array(oldN);
    resizeScratch.set(carried.data.subarray(0, oldN));
    old = resizeScratch;
    oldSize = carried.size;
    oldOff = (carried.size - size) / 2; // both odd → integer
    patch = carried;
    const n = size * size * 4;
    if (patch.data.length < n) patch.data = new Float32Array(n);
    patch.size = size;
  }
  const data = patch.data;
  const x0 = cx - half;
  const y0 = cy - half;
  for (let j = 0; j < size; j++) {
    let y = y0 + j;
    if (tileH !== undefined) y = wrap(y, tileH);
    for (let i = 0; i < size; i++) {
      let x = x0 + i;
      if (tileW !== undefined) x = wrap(x, tileW);
      readPremul(layer, x, y);
      const o = (j * size + i) * 4;
      const oi = i + oldOff;
      const oj = j + oldOff;
      if (old !== null && oi >= 0 && oj >= 0 && oi < oldSize && oj < oldSize) {
        const q = (oj * oldSize + oi) * 4;
        data[o] = old[q] * keep + px4[0] * (1 - keep);
        data[o + 1] = old[q + 1] * keep + px4[1] * (1 - keep);
        data[o + 2] = old[q + 2] * keep + px4[2] * (1 - keep);
        data[o + 3] = old[q + 3] * keep + px4[3] * (1 - keep);
      } else {
        data[o] = px4[0];
        data[o + 1] = px4[1];
        data[o + 2] = px4[2];
        data[o + 3] = px4[3];
      }
    }
  }
  return patch;
}

/**
 * Paint the carried patch at canvas pixel (px, py) with strength `k`
 * (coverage × opacity, 0..1): the pixel moves toward the patch texel (mixed
 * with the brush colour) in premultiplied space. Also grows the stroke
 * silhouette in `touched` (for wet edges) by `geom` (coverage × opacity).
 */
export function smudgePixel(
  layer: GpuLayer,
  canvasW: number,
  canvasH: number,
  px: number,
  py: number,
  k: number,
  geom: number,
  st: SmudgeStamp,
  touched: TouchedBuffer,
  sel: SelMask | undefined,
  tiled: boolean,
  ditherSeed: number,
): void {
  const half = (st.patch.size - 1) / 2;
  const ti = px - (st.cx - half);
  const tj = py - (st.cy - half);
  const size = st.patch.size;
  if (ti < 0 || tj < 0 || ti >= size || tj >= size) return;
  let x = px;
  let y = py;
  if (tiled) {
    x = wrap(x, canvasW);
    y = wrap(y, canvasH);
  }
  if (x < 0 || y < 0 || x >= canvasW || y >= canvasH) return;
  if (sel) {
    const v = sel.mask[y * sel.width + x];
    if (v === 0) return;
    if (v !== 255) {
      k *= v / 255;
      geom *= v / 255;
    }
  }
  const lx = x - layer.offsetX;
  const ly = y - layer.offsetY;
  if (lx < 0 || ly < 0 || lx >= layer.layerWidth || ly >= layer.layerHeight) return;

  const key = y * touched.width + x;
  const geomByte = Math.min(255, (geom * 255 + 0.5) | 0);
  if (geomByte > touched.data[key]) {
    touched.data[key] = geomByte;
    noteTouchedWrite(touched, x, y);
  }

  const t = st.patch.data;
  const o = (tj * size + ti) * 4;
  const cr = st.colorRate;
  const b = st.brush;
  const tr = t[o] + (b[0] - t[o]) * cr;
  const tg = t[o + 1] + (b[1] - t[o + 1]) * cr;
  const tb = t[o + 2] + (b[2] - t[o + 2]) * cr;
  const ta = t[o + 3] + (b[3] - t[o + 3]) * cr;
  readPremul(layer, x, y);
  const nr = px4[0] + (tr - px4[0]) * k;
  const ng = px4[1] + (tg - px4[1]) * k;
  const nb = px4[2] + (tb - px4[2]) * k;
  const na = px4[3] + (ta - px4[3]) * k;

  const d = layer.data;
  const i = (ly * layer.layerWidth + lx) * 4;
  if (na <= 1e-6) {
    d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
    return;
  }
  const inv = 1 / na;
  if (layer.format === "rgba32f") {
    d[i] = nr * inv;
    d[i + 1] = ng * inv;
    d[i + 2] = nb * inv;
    d[i + 3] = na;
  } else {
    // Stochastic rounding: small smudge steps would otherwise round away.
    const bias = ditherBias(x, y, ditherSeed);
    d[i] = Math.min(255, (nr * inv * 255 + bias) | 0);
    d[i + 1] = Math.min(255, (ng * inv * 255 + bias) | 0);
    d[i + 2] = Math.min(255, (nb * inv * 255 + bias) | 0);
    d[i + 3] = Math.min(255, (na * 255 + bias) | 0);
  }
}
