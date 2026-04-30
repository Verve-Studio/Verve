// ─── Texture helpers ──────────────────────────────────────────────────────────

export function createGpuTexture(
  device: GPUDevice,
  width: number,
  height: number,
  data?: Uint8Array | null,
  format: GPUTextureFormat = 'rgba8unorm',
  usage: GPUTextureUsageFlags =
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.COPY_DST |
    GPUTextureUsage.COPY_SRC |
    GPUTextureUsage.STORAGE_BINDING |
    GPUTextureUsage.RENDER_ATTACHMENT,
): GPUTexture {
  const texture = device.createTexture({
    size: { width, height },
    format,
    usage,
  })
  if (data) {
    uploadTextureData(device, texture, width, height, data)
  }
  return texture
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
  )
}

/**
 * Upload only a sub-rectangle of `data` into `texture`.
 * `x`, `y`, `w`, `h` are in layer-local texel coordinates.
 * `fullWidth` is the full row stride of `data` (the layer's actual width).
 */
export function uploadTexturePatch(
  device: GPUDevice,
  texture: GPUTexture,
  fullWidth: number,
  x: number, y: number, w: number, h: number,
  data: ArrayBufferView,
): void {
  if (w <= 0 || h <= 0) return
  device.queue.writeTexture(
    { texture, origin: { x, y } },
    data as ArrayBufferView<ArrayBuffer>,
    { offset: (y * fullWidth + x) * 4, bytesPerRow: fullWidth * 4 },
    { width: w, height: h },
  )
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
  )
}

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
  if (w <= 0 || h <= 0) return
  device.queue.writeTexture(
    { texture, origin: { x, y } },
    data as unknown as GPUAllowSharedBufferSource,
    { offset: (y * textureWidth + x) * 16, bytesPerRow: textureWidth * 16 },
    { width: w, height: h },
  )
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
  )
}

// ─── Buffer helpers ───────────────────────────────────────────────────────────

export function createUniformBuffer(device: GPUDevice, size: number): GPUBuffer {
  return device.createBuffer({
    size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
}

export function createStorageBuffer(device: GPUDevice, size: number): GPUBuffer {
  return device.createBuffer({
    size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
}

export function writeUniformBuffer(
  device: GPUDevice,
  buffer: GPUBuffer,
  data: ArrayBuffer | Float32Array | Uint32Array,
): void {
  const src = data instanceof ArrayBuffer ? data : (data.buffer as ArrayBuffer)
  device.queue.writeBuffer(buffer, 0, src)
}

export function createVertexBuffer(device: GPUDevice, data: Float32Array): GPUBuffer {
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>)
  return buffer
}

export function createReadbackBuffer(device: GPUDevice, byteSize: number): GPUBuffer {
  return device.createBuffer({
    size: byteSize,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  })
}

export function unpackRows(src: Uint8Array, w: number, h: number, alignedBpr: number): Uint8Array {
  const packedBpr = w * 4
  if (alignedBpr === packedBpr) return src.slice()
  const out = new Uint8Array(packedBpr * h)
  for (let row = 0; row < h; row++) {
    out.set(src.subarray(row * alignedBpr, row * alignedBpr + packedBpr), row * packedBpr)
  }
  return out
}
