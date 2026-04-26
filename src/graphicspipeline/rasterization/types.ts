import type { RenderPlanEntry, WebGPURenderer } from '@/graphicspipeline/webgpu/rendering/WebGPURenderer'

export type RasterBackend = 'gpu'
export type RasterReason = 'flatten' | 'export' | 'sample' | 'merge'

export interface RasterizeDocumentRequest {
  plan: RenderPlanEntry[]
  width: number
  height: number
  reason: RasterReason
  renderer?: WebGPURenderer | null
}

export interface RasterizeDocumentResult {
  data: Uint8Array
  width: number
  height: number
  backendUsed: RasterBackend
  warning?: string
}

export class RasterizationUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RasterizationUnavailableError'
  }
}

export class RasterizationExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RasterizationExecutionError'
  }
}
