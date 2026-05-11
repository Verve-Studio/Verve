// ─── LUT GPU resources ───────────────────────────────────────────────────────
//
// We pack the 3D cube into a 2D atlas (width=size, height=size×size) so it
// fits the existing `texture_2d<f32>` binding kinds — extending the effect
// runtime with a 3D-texture binding type would touch every effect's BGL
// builder. Atlas layout:
//
//   atlasX = redIndex
//   atlasY = blueIndex × size + greenIndex
//
// The shader reads two adjacent blue slabs and trilinearly interpolates.
// A linear sampler gives us bilinear (R, G) sampling within each slab for
// free; only the blue-axis interpolation is manual.
//
// The shaper is packed as a 3-row × size 2D texture, one row per RGB
// channel. Channel `c` at parameter `t∈[0,1]` is read at uv = (t, (c+0.5)/3).
//
// The cache is keyed by `(device, lutId)` and re-uploaded whenever the
// underlying `LutTransform` reference changes.

import type { LutTransform } from "./LUT";

export interface LutGpuBundle {
  cubeTex: GPUTexture; // 2D atlas (size × size²)
  cubeView: GPUTextureView;
  shaperTex: GPUTexture; // 2D (size × 3)
  shaperView: GPUTextureView;
  cubeSize: number;
  shaperSize: number;
  hasShaper: boolean;
  source: LutTransform;
}

const cache = new WeakMap<GPUDevice, Map<string, LutGpuBundle>>();

const f32buf = new ArrayBuffer(4);
const f32 = new Float32Array(f32buf);
const u32 = new Uint32Array(f32buf);
function floatToHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const mant = x & 0x7fffff;
  let exp = (x >>> 23) & 0xff;
  if (exp === 0xff) {
    return sign | 0x7c00 | (mant !== 0 ? 0x0200 : 0);
  }
  exp = exp - 127 + 15;
  if (exp >= 31) return sign | 0x7c00;
  if (exp <= 0) return sign;
  return sign | (exp << 10) | (mant >>> 13);
}

function packF32asF16(rgba: Float32Array): Uint16Array {
  const out = new Uint16Array(rgba.length);
  for (let i = 0; i < rgba.length; i++) out[i] = floatToHalf(rgba[i]);
  return out;
}

/** Build a 2D atlas Float32Array (width=N, height=N²) of rgba16float texels
 *  from a `size³ × 3` RGB-interleaved source. */
function buildCubeAtlas(size: number, table: Float32Array): Float32Array {
  const W = size;
  const H = size * size;
  const out = new Float32Array(W * H * 4);
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      const atlasY = bi * size + gi;
      for (let ri = 0; ri < size; ri++) {
        const srcIdx = ((bi * size + gi) * size + ri) * 3;
        const dstIdx = (atlasY * W + ri) * 4;
        out[dstIdx] = table[srcIdx];
        out[dstIdx + 1] = table[srcIdx + 1];
        out[dstIdx + 2] = table[srcIdx + 2];
        out[dstIdx + 3] = 1;
      }
    }
  }
  return out;
}

/** Build a 3-row × size shaper texture (per-channel rows). */
function buildShaperTexture(
  size: number,
  table: Float32Array,
): Float32Array {
  const out = new Float32Array(size * 3 * 4);
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < size; i++) {
      const v = table[i * 3 + row];
      const o = (row * size + i) * 4;
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
      out[o + 3] = 1;
    }
  }
  return out;
}

/** Identity shaper used when the LUT has none. Saves us from threading a
 *  hasShaper branch through every shader. */
function buildIdentityShaper(): Float32Array {
  const N = 4;
  const out = new Float32Array(N * 3 * 4);
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const o = (row * N + i) * 4;
      out[o] = t;
      out[o + 1] = t;
      out[o + 2] = t;
      out[o + 3] = 1;
    }
  }
  return out;
}

function uploadRgba16f(
  device: GPUDevice,
  tex: GPUTexture,
  rgbaF32: Float32Array,
  width: number,
  height: number,
): void {
  const f16 = packF32asF16(rgbaF32);
  device.queue.writeTexture(
    { texture: tex },
    f16.buffer,
    { bytesPerRow: width * 4 * 2, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
}

export function ensureLutOnGpu(
  device: GPUDevice,
  lut: LutTransform,
): LutGpuBundle {
  let perDevice = cache.get(device);
  if (!perDevice) {
    perDevice = new Map();
    cache.set(device, perDevice);
  }
  const existing = perDevice.get(lut.id);
  if (existing && existing.source === lut) return existing;
  if (existing) {
    existing.cubeTex.destroy();
    existing.shaperTex.destroy();
  }

  const N = lut.cube.size;
  const atlasW = N;
  const atlasH = N * N;
  const cubeTex = device.createTexture({
    size: { width: atlasW, height: atlasH, depthOrArrayLayers: 1 },
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  uploadRgba16f(
    device,
    cubeTex,
    buildCubeAtlas(N, lut.cube.table),
    atlasW,
    atlasH,
  );

  const shaperSize = lut.shaper?.size ?? 4;
  const shaperTex = device.createTexture({
    size: { width: shaperSize, height: 3, depthOrArrayLayers: 1 },
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  uploadRgba16f(
    device,
    shaperTex,
    lut.shaper
      ? buildShaperTexture(lut.shaper.size, lut.shaper.table)
      : buildIdentityShaper(),
    shaperSize,
    3,
  );

  const bundle: LutGpuBundle = {
    cubeTex,
    cubeView: cubeTex.createView(),
    shaperTex,
    shaperView: shaperTex.createView(),
    cubeSize: N,
    shaperSize,
    hasShaper: !!lut.shaper,
    source: lut,
  };
  perDevice.set(lut.id, bundle);
  return bundle;
}

export function evictLut(device: GPUDevice, id: string): void {
  const perDevice = cache.get(device);
  if (!perDevice) return;
  const b = perDevice.get(id);
  if (!b) return;
  b.cubeTex.destroy();
  b.shaperTex.destroy();
  perDevice.delete(id);
}
