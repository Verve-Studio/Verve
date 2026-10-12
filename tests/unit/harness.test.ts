import { describe, expect, it } from 'vitest'

describe('test harness', () => {
  it('provides WebGPU flag constants', () => {
    expect(GPUTextureUsage.RENDER_ATTACHMENT).toBe(0x10)
    expect(GPUBufferUsage.UNIFORM).toBe(0x40)
  })
})
