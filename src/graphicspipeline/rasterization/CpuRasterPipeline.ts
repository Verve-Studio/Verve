import type { AdjustmentRenderOp, GpuLayer } from '@/graphicspipeline/webgpu/rendering/WebGPURenderer'
import {
  RasterizationExecutionError,
  type RasterizeDocumentRequest,
} from './types'
import { compositePixelOver } from './cpuBlend'

type AdjustmentKind = AdjustmentRenderOp['kind']
type AdjustmentEvaluator = (input: Uint8Array, op: AdjustmentRenderOp, width: number, height: number) => Uint8Array<ArrayBufferLike>
type CpuRasterizeDocumentResult = {
  data: Uint8Array
  width: number
  height: number
}

export class CpuRasterPipeline {
  private readonly evaluators = new Map<AdjustmentKind, AdjustmentEvaluator>()

  constructor() {
    // Kept as a registry so new adjustments can be added without changing call sites.
    this.evaluators.set('color-invert', this.applyInvert)
  }

  rasterize(request: RasterizeDocumentRequest): CpuRasterizeDocumentResult {
    const { width, height, plan } = request
    const composite = new Uint8Array(width * height * 4)

    for (const entry of plan) {
      if (entry.kind === 'layer') {
        if (!entry.layer.visible || entry.layer.opacity <= 0) continue
        this.compositeLayerOnto(composite, entry.layer, width, height, entry.mask)
        continue
      }

      if (entry.kind === 'layer-group') {
        // CPU pipeline does not support layer groups — skip silently.
        // Groups are only used in GPU compositing.
        continue
      }

      if (entry.kind === 'adjustment-group') {
        if (!entry.baseLayer.visible || entry.baseLayer.opacity <= 0) continue
        const scoped = new Uint8Array(width * height * 4)
        const baseAsSource: GpuLayer = {
          ...entry.baseLayer,
          opacity: 1,
          blendMode: 'normal',
        }
        this.compositeLayerOnto(scoped, baseAsSource, width, height, entry.baseMask)
        let adjusted: Uint8Array<ArrayBufferLike> = scoped
        for (const op of entry.adjustments) {
          if (!op.visible) continue
          adjusted = this.applyAdjustment(adjusted, op, width, height)
        }
        this.compositePixelsOnto(composite, adjusted, width, height, entry.baseLayer.opacity, entry.baseLayer.blendMode)
        continue
      }

      if (!entry.visible) continue
      const adjusted = this.applyAdjustment(composite, entry, width, height)
      composite.set(adjusted)
    }

    return {
      data: composite,
      width,
      height,
    }
  }

  private applyAdjustment(input: Uint8Array, op: AdjustmentRenderOp, width: number, height: number): Uint8Array<ArrayBufferLike> {
    const evaluator = this.evaluators.get(op.kind)
    if (!evaluator) {
      throw new RasterizationExecutionError(`CPU fallback has no evaluator registered for adjustment kind: ${op.kind}`)
    }
    return evaluator(input, op, width, height)
  }

  private applyInvert = (input: Uint8Array, op: AdjustmentRenderOp, width: number, height: number): Uint8Array<ArrayBufferLike> => {
    if (op.kind !== 'color-invert') return input
    const out = input.slice()
    const mask = op.selMaskLayer?.data
    const pxCount = width * height
    for (let i = 0; i < pxCount; i++) {
      const di = i * 4
      const maskWeight = mask ? mask[di] / 255 : 1
      if (maskWeight <= 0) continue
      const invR = 255 - input[di]
      const invG = 255 - input[di + 1]
      const invB = 255 - input[di + 2]
      if (maskWeight >= 1) {
        out[di] = invR
        out[di + 1] = invG
        out[di + 2] = invB
      } else {
        out[di] = Math.round(input[di] * (1 - maskWeight) + invR * maskWeight)
        out[di + 1] = Math.round(input[di + 1] * (1 - maskWeight) + invG * maskWeight)
        out[di + 2] = Math.round(input[di + 2] * (1 - maskWeight) + invB * maskWeight)
      }
    }
    return out
  }

  private compositeLayerOnto(
    destination: Uint8Array,
    layer: GpuLayer,
    width: number,
    height: number,
    maskLayer?: GpuLayer,
  ): void {
    const src = layer.data

    for (let ly = 0; ly < layer.layerHeight; ly++) {
      const cy = layer.offsetY + ly
      if (cy < 0 || cy >= height) continue
      for (let lx = 0; lx < layer.layerWidth; lx++) {
        const cx = layer.offsetX + lx
        if (cx < 0 || cx >= width) continue

        const si = (ly * layer.layerWidth + lx) * 4
        const di = (cy * width + cx) * 4

        let opacity = layer.opacity
        if (maskLayer) {
          const maskA = maskLayer.data[di] / 255
          opacity *= maskA
        }
        compositePixelOver(
          destination,
          di,
          src[si],
          src[si + 1],
          src[si + 2],
          src[si + 3],
          opacity,
          layer.blendMode,
        )
      }
    }
  }

  private compositePixelsOnto(
    destination: Uint8Array,
    source: Uint8Array<ArrayBufferLike>,
    width: number,
    height: number,
    opacity: number,
    blendMode: string,
  ): void {
    const total = width * height

    for (let i = 0; i < total; i++) {
      const di = i * 4
      compositePixelOver(
        destination,
        di,
        source[di],
        source[di + 1],
        source[di + 2],
        source[di + 3],
        opacity,
        blendMode,
      )
    }
  }
}
