// ─── Texture helpers ──────────────────────────────────────────────────────────

import { createTrackedTexture } from "@/core/store/memoryStore";

export function createGpuTexture(
  device: GPUDevice,
  width: number,
  height: number,
  data?: Uint8Array | null,
  format: GPUTextureFormat = "rgba8unorm",
  usage: GPUTextureUsageFlags = GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.COPY_DST |
    GPUTextureUsage.COPY_SRC |
    GPUTextureUsage.STORAGE_BINDING |
    GPUTextureUsage.RENDER_ATTACHMENT,
): GPUTexture {
  // All renderer textures route through the tracked allocator so the global
  // buffer-memory cap (Preferences → Memory) is enforced uniformly.
  const texture = createTrackedTexture(device, {
    size: { width, height },
    format,
    usage,
  });
  if (data) {
    uploadTextureData(device, texture, width, height, data);
  }
  return texture;
}

export function uploadTextureData(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
  data: ArrayBufferView,
): void {
  device.queue.writeTexture(
    { texture },
    data as ArrayBufferView<ArrayBuffer>,
    { bytesPerRow: width * 4, rowsPerImage: height },
    { width, height },
  );
}

/**
 * Upload only a sub-rectangle of `data` into `texture`.
 * `x`, `y`, `w`, `h` are in layer-local texel coordinates.
 * `fullWidth` is the full row stride of `data` (the layer's actual width).
 */
// Reusable staging scratch for packed uploads — grown on demand, shared
// across all uploadTexturePatch callers on the same thread. Avoids
// allocating a fresh Uint8Array per stamp on a big-canvas brush stroke.
let _packU8: Uint8Array = new Uint8Array(0);

export function uploadTexturePatch(
  device: GPUDevice,
  texture: GPUTexture,
  fullWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
  data: ArrayBufferView,
): void {
  if (w <= 0 || h <= 0) return;
  // Naive path: writeTexture from the FULL layer buffer with the layer's
  // row stride. The browser still reads (h-1) * fullWidth*4 + w*4 bytes
  // from the source (most of which never make it to the GPU), so on big
  // canvases with narrow dirty rects (every brush stamp on an A1 doc) the
  // per-stamp upload bandwidth scales with canvas width even though only
  // w*h*4 bytes actually land on the texture.
  //
  // When the dirty rect is sufficiently narrow vs the layer, pack the
  // stamp pixels into a contiguous scratch buffer and upload that with a
  // tight stride. Threshold ≈ 2× ensures the pack memcpy (w*h*4) is
  // smaller than the wasted upload bytes ((fullWidth-w)*h*4).
  const FULL_ROW_BYTES = fullWidth * 4;
  const PACKED_ROW_BYTES = w * 4;
  const PACK_THRESHOLD = 2; // pack when source row is ≥2× the dirty width
  if (FULL_ROW_BYTES >= PACKED_ROW_BYTES * PACK_THRESHOLD) {
    // WebGPU requires bytesPerRow to be a multiple of 256 for buffer-source
    // variants; ArrayBufferView writeTexture is generally lenient, but pad
    // anyway for portability (still vastly smaller than the source-stride
    // upload size).
    const padded = (PACKED_ROW_BYTES + 255) & ~255;
    const needBytes = padded * h;
    if (_packU8.length < needBytes) {
      // Grow in 2× steps so subsequent stamps don't reallocate.
      let cap = _packU8.length || 65536;
      while (cap < needBytes) cap *= 2;
      _packU8 = new Uint8Array(cap);
    }
    const src = data as Uint8Array;
    for (let row = 0; row < h; row++) {
      const srcOff = ((y + row) * fullWidth + x) * 4;
      const dstOff = row * padded;
      _packU8.set(src.subarray(srcOff, srcOff + PACKED_ROW_BYTES), dstOff);
    }
    device.queue.writeTexture(
      { texture, origin: { x, y } },
      _packU8 as ArrayBufferView<ArrayBuffer>,
      { offset: 0, bytesPerRow: padded },
      { width: w, height: h },
    );
    return;
  }
  device.queue.writeTexture(
    { texture, origin: { x, y } },
    data as ArrayBufferView<ArrayBuffer>,
    { offset: (y * fullWidth + x) * 4, bytesPerRow: fullWidth * 4 },
    { width: w, height: h },
  );
}

export function uploadF32TextureData(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
  data: Float32Array,
): void {
  device.queue.writeTexture(
    { texture },
    data as unknown as GPUAllowSharedBufferSource,
    { bytesPerRow: width * 16, rowsPerImage: height },
    { width, height },
  );
}

// Same packed-staging trick as uploadTexturePatch but for f32 (16 bytes
// per pixel). Wasted-source-bytes scale 4× faster than rgba8 so the
// pack-win is correspondingly bigger.
let _packF32: Float32Array = new Float32Array(0);

export function uploadF32TexturePatch(
  device: GPUDevice,
  texture: GPUTexture,
  textureWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
  data: Float32Array,
): void {
  if (w <= 0 || h <= 0) return;
  const FULL_ROW_BYTES = textureWidth * 16;
  const PACKED_ROW_BYTES = w * 16;
  if (FULL_ROW_BYTES >= PACKED_ROW_BYTES * 2) {
    // bytesPerRow is already a multiple of 16 (pixel-aligned); writeTexture
    // expects multiples of 256 only for buffer-source variants, so f32
    // can stay tight.
    const padded = (PACKED_ROW_BYTES + 255) & ~255;
    const needFloats = (padded * h) / 4;
    if (_packF32.length < needFloats) {
      let cap = _packF32.length || 16384;
      while (cap < needFloats) cap *= 2;
      _packF32 = new Float32Array(cap);
    }
    const floatsPerSrcRow = textureWidth * 4;
    const floatsPerPackedRow = padded / 4;
    const floatsPerCopyRow = w * 4;
    for (let row = 0; row < h; row++) {
      const srcOff = (y + row) * floatsPerSrcRow + x * 4;
      const dstOff = row * floatsPerPackedRow;
      _packF32.set(data.subarray(srcOff, srcOff + floatsPerCopyRow), dstOff);
    }
    device.queue.writeTexture(
      { texture, origin: { x, y } },
      _packF32 as unknown as GPUAllowSharedBufferSource,
      { offset: 0, bytesPerRow: padded },
      { width: w, height: h },
    );
    return;
  }
  device.queue.writeTexture(
    { texture, origin: { x, y } },
    data as unknown as GPUAllowSharedBufferSource,
    { offset: (y * textureWidth + x) * 16, bytesPerRow: textureWidth * 16 },
    { width: w, height: h },
  );
}

export function uploadR8TextureData(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
  data: Uint8Array,
): void {
  device.queue.writeTexture(
    { texture },
    data as Uint8Array<ArrayBuffer>,
    { bytesPerRow: width, rowsPerImage: height },
    { width, height },
  );
}

// ─── Buffer helpers ───────────────────────────────────────────────────────────

export function createUniformBuffer(
  device: GPUDevice,
  size: number,
): GPUBuffer {
  return device.createBuffer({
    size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

export function createStorageBuffer(
  device: GPUDevice,
  size: number,
): GPUBuffer {
  return device.createBuffer({
    size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
}

export function writeUniformBuffer(
  device: GPUDevice,
  buffer: GPUBuffer,
  data: ArrayBuffer | Float32Array | Uint32Array,
): void {
  const src = data instanceof ArrayBuffer ? data : (data.buffer as ArrayBuffer);
  device.queue.writeBuffer(buffer, 0, src);
}

export function createVertexBuffer(
  device: GPUDevice,
  data: Float32Array,
): GPUBuffer {
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
  return buffer;
}

export function createReadbackBuffer(
  device: GPUDevice,
  byteSize: number,
): GPUBuffer {
  return device.createBuffer({
    size: byteSize,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
}

export function unpackRows(
  src: Uint8Array,
  w: number,
  h: number,
  alignedBpr: number,
): Uint8Array {
  const packedBpr = w * 4;
  if (alignedBpr === packedBpr) return src.slice();
  const out = new Uint8Array(packedBpr * h);
  for (let row = 0; row < h; row++) {
    out.set(
      src.subarray(row * alignedBpr, row * alignedBpr + packedBpr),
      row * packedBpr,
    );
  }
  return out;
}
