import type { RefineParams } from '../matting'

export type MlModel = 'isnet' | 'inpaint' | 'matting' | 'upscale'

/** Work the ML worker can do. Shared by `mlHost.ts` and `mlWorker.ts`. */
export type MlJob =
  | { kind: 'isnet'; params: { rgba: Uint8Array; width: number; height: number } }
  | {
      kind: 'inpaint'
      params: { rgba: Uint8Array; mask: Uint8Array; width: number; height: number }
    }
  | { kind: 'matting'; params: RefineParams }
  | {
      kind: 'upscale'
      params: {
        rgba: Uint8Array
        width: number
        height: number
        modelId: string
        targetWidth: number
        targetHeight: number
      }
    }
  | { kind: 'invalidate'; model: MlModel; modelId?: string }
  | { kind: 'check'; model: MlModel; modelId?: string }
  | { kind: 'list-upscale-models' }
  | { kind: 'download-matting' }
