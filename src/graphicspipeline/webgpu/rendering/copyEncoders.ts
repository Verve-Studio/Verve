/**
 * Encoder helpers that don't touch any renderer state — just `encoder` plus
 * the textures they operate on. Pulled out of WebGPURenderer to keep the
 * class focused on render-loop orchestration.
 */

/** Begin and end an empty render pass that clears the texture to (0,0,0,0). */
export function encodeClearTexture(encoder: GPUCommandEncoder, texture: GPUTexture): void {
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: texture.createView(),
      loadOp: 'clear',
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
      storeOp: 'store',
    }],
  })
  pass.end()
}

/**
 * Copy the four strips of `src` that lie OUTSIDE rect (rx, ry, rw, rh) into
 * `dst`, leaving `dst` inside the rect untouched (a subsequent render pass
 * will write the rect interior).
 *
 * Used by the layer composite to preserve the previous frame's content
 * outside the layer's own bbox without DMAing the full canvas every frame.
 *
 * Layout (rect = R inside canvas C):
 *   ┌─────top─────┐
 *   ├──┬───────┬──┤
 *   │L │   R   │ R│
 *   ├──┴───────┴──┤
 *   └────bottom───┘
 */
export function copyOutsideRect(
  encoder: GPUCommandEncoder,
  src: GPUTexture, dst: GPUTexture,
  rx: number, ry: number, rw: number, rh: number,
  cw: number, ch: number,
): void {
  // Clamp rect to canvas — defensive against out-of-canvas layer rects.
  const x0 = Math.max(0, rx)
  const y0 = Math.max(0, ry)
  const x1 = Math.min(cw, rx + rw)
  const y1 = Math.min(ch, ry + rh)
  if (x0 >= x1 || y0 >= y1) {
    // Rect is outside or empty — preserve everything.
    encoder.copyTextureToTexture({ texture: src }, { texture: dst }, { width: cw, height: ch })
    return
  }
  // Top strip: full width, rows [0, y0)
  if (y0 > 0) {
    encoder.copyTextureToTexture(
      { texture: src, origin: { x: 0, y: 0 } },
      { texture: dst, origin: { x: 0, y: 0 } },
      { width: cw, height: y0 },
    )
  }
  // Bottom strip: full width, rows [y1, ch)
  if (y1 < ch) {
    encoder.copyTextureToTexture(
      { texture: src, origin: { x: 0, y: y1 } },
      { texture: dst, origin: { x: 0, y: y1 } },
      { width: cw, height: ch - y1 },
    )
  }
  // Left strip: cols [0, x0), rows [y0, y1)
  if (x0 > 0) {
    encoder.copyTextureToTexture(
      { texture: src, origin: { x: 0, y: y0 } },
      { texture: dst, origin: { x: 0, y: y0 } },
      { width: x0, height: y1 - y0 },
    )
  }
  // Right strip: cols [x1, cw), rows [y0, y1)
  if (x1 < cw) {
    encoder.copyTextureToTexture(
      { texture: src, origin: { x: x1, y: y0 } },
      { texture: dst, origin: { x: x1, y: y0 } },
      { width: cw - x1, height: y1 - y0 },
    )
  }
}
