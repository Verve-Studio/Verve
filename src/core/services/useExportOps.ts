import { exportJpeg } from '@/core/io/exportJpeg'
import { exportPng } from '@/core/io/exportPng'
import { exportTga } from '@/core/io/exportTga'
import { exportTiff } from '@/core/io/exportTiff'
import { exportWebp } from '@/core/io/exportWebp'
import { exportHdr } from '@/core/io/exportHdr'
import { exportTiff32 } from '@/core/io/exportTiff32'
import { exportDds } from '@/core/io/exportDds'
import { encodeExr } from '@/wasm'
import { DdsFormat, DdsHeaderMode } from '@/wasm'
import { displayStore } from '@/core/store/displayStore'
import type { AppState, ToneMappingOperator } from '@/types'
import { showOperationError } from '@/utils/userFeedback'
import { clampF32ToUint8 } from '@/utils/pixelFormatConvert'
import type { CanvasHandle } from '@/ux/main/Canvas/Canvas'
import type { ExportSettings } from '@/ux/modals/ExportDialog/ExportDialog'
import { useCallback, useState, type MutableRefObject } from 'react'

// ─── Tone-mapping helper ──────────────────────────────────────────────────────

function toneMapToUint8(f32: Float32Array, operator: ToneMappingOperator, exposureEV: number): Uint8Array {
  const out = new Uint8Array(f32.length)
  const gain = Math.pow(2, exposureEV)
  for (let i = 0; i < f32.length; i += 4) {
    let r = f32[i] * gain
    let g = f32[i + 1] * gain
    let b = f32[i + 2] * gain
    const a = f32[i + 3]
    if (operator === 'reinhard') {
      r = r / (1 + r)
      g = g / (1 + g)
      b = b / (1 + b)
    }
    out[i]     = Math.round(Math.min(1, Math.max(0, r)) * 255)
    out[i + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255)
    out[i + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255)
    out[i + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255)
  }
  return out
}

interface UseExportOpsOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null }
  stateRef: MutableRefObject<AppState>
}

interface UseExportOpsReturn {
  handleExportConfirm: (settings: ExportSettings) => Promise<void>
  pendingLdrExport: ExportSettings | null
  clearPendingLdrExport: () => void
  confirmLdrExport: () => Promise<void>
}

export function useExportOps({
  canvasHandleRef,
  stateRef,
}: UseExportOpsOptions): UseExportOpsReturn {
  const [pendingLdrExport, setPendingLdrExport] = useState<ExportSettings | null>(null)

  // Chunked Uint8Array → base64. Avoids "Maximum call stack size exceeded" from
  // String.fromCharCode(...largeArray) for multi-MB HDR/EXR/TIFF32 buffers.
  const bytesToBase64 = (bytes: Uint8Array): string => {
    const CHUNK = 8192
    let s = ''
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
    }
    return btoa(s)
  }

  const doExport = useCallback(async (settings: ExportSettings): Promise<void> => {
    const handle = canvasHandleRef.current
    if (!handle) throw new Error('Canvas renderer is not ready yet. Please try export again.')
    const flat = await handle.rasterizeLayers(stateRef.current.layers, 'export')
    const { width, height } = flat
    const isHdrDoc = stateRef.current.pixelFormat === 'rgba32f'

    // HDR formats — always available for rgba32f docs
    if (settings.format === 'exr') {
      if (!(flat.data instanceof Float32Array)) throw new Error('EXR export requires a rgba32f document.')
      const bytes = await encodeExr(flat.data, width, height, settings.exrCompression, settings.exrHalfFloat ? 1 : 0)
      const b64 = bytesToBase64(bytes)
      await window.api.exportImage(settings.filePath, b64)
      return
    }
    if (settings.format === 'hdr') {
      if (!(flat.data instanceof Float32Array)) throw new Error('HDR export requires a rgba32f document.')
      const bytes = exportHdr(flat.data, width, height)
      const b64 = bytesToBase64(bytes)
      await window.api.exportImage(settings.filePath, b64)
      return
    }
    if (settings.format === 'tiff32') {
      if (!(flat.data instanceof Float32Array)) throw new Error('TIFF32 export requires a rgba32f document.')
      const bytes = exportTiff32(flat.data, width, height)
      const b64 = bytesToBase64(bytes)
      await window.api.exportImage(settings.filePath, b64)
      return
    }
    if (settings.format === 'dds') {
      const { ddsCompression } = settings
      const isHdrComp = ddsCompression === 'bc6h' || ddsCompression === 'rgba32f'
      const fmtMap: Record<string, number> = {
        bc1: DdsFormat.BC1, bc3: DdsFormat.BC3, bc7: DdsFormat.BC7,
        bc6h: DdsFormat.BC6H, rgba32f: DdsFormat.RGBA32F,
      }
      const fmt = fmtMap[ddsCompression]
      if (isHdrComp) {
        if (!(flat.data instanceof Float32Array)) throw new Error('BC6H/RGBA32F DDS export requires a rgba32f document.')
        const dataUrl = await exportDds({ pixels: flat.data, width, height, fmt, mipLevels: settings.ddsMipLevels, inputFormat: 'rgba32f' })
        await window.api.exportImage(settings.filePath, dataUrl.replace(/^data:[^;]+;base64,/, ''))
      } else {
        let ldrData: Uint8Array
        if (isHdrDoc && flat.data instanceof Float32Array) {
          ldrData = toneMapToUint8(flat.data, displayStore.toneMappingOperator, displayStore.exposureEV)
        } else {
          ldrData = flat.data instanceof Float32Array ? clampF32ToUint8(flat.data) : flat.data
        }
        const dataUrl = await exportDds({ pixels: ldrData, width, height, fmt, mipLevels: settings.ddsMipLevels, headerMode: DdsHeaderMode.AUTO, inputFormat: 'rgba8' })
        await window.api.exportImage(settings.filePath, dataUrl.replace(/^data:[^;]+;base64,/, ''))
      }
      return
    }

    // LDR formats
    let data: Uint8Array
    if (isHdrDoc && flat.data instanceof Float32Array) {
      data = toneMapToUint8(flat.data, displayStore.toneMappingOperator, displayStore.exposureEV)
    } else {
      data = flat.data instanceof Float32Array ? clampF32ToUint8(flat.data) : flat.data
    }

    let dataUrl: string
    if      (settings.format === 'png')  dataUrl = exportPng(data, width, height)
    else if (settings.format === 'webp') dataUrl = exportWebp(data, width, height, { quality: settings.webpQuality })
    else if (settings.format === 'tga')  dataUrl = exportTga(data, width, height)
    else if (settings.format === 'tiff') dataUrl = exportTiff(data, width, height)
    else                                 dataUrl = exportJpeg(data, width, height, { quality: settings.jpegQuality, background: settings.jpegBackground })
    await window.api.exportImage(settings.filePath, dataUrl.replace(/^data:[^;]+;base64,/, ''))
  }, [canvasHandleRef, stateRef])

  const handleExportConfirm = useCallback(async (settings: ExportSettings): Promise<void> => {
    try {
      const isHdrDoc = stateRef.current.pixelFormat === 'rgba32f'
      const isLdrFormat = settings.format !== 'exr' && settings.format !== 'hdr' && settings.format !== 'tiff32'
        && !(settings.format === 'dds' && (settings.ddsCompression === 'bc6h' || settings.ddsCompression === 'rgba32f'))
      if (isHdrDoc && isLdrFormat) {
        // Gate behind warning dialog
        setPendingLdrExport(settings)
        return
      }
      await doExport(settings)
    } catch (error) {
      console.error('[useExportOps] Export failed:', error)
      showOperationError('Export failed.', error)
    }
  }, [doExport, stateRef])

  const confirmLdrExport = useCallback(async (): Promise<void> => {
    if (!pendingLdrExport) return
    const settings = pendingLdrExport
    setPendingLdrExport(null)
    try {
      await doExport(settings)
    } catch (error) {
      console.error('[useExportOps] Export failed:', error)
      showOperationError('Export failed.', error)
    }
  }, [pendingLdrExport, doExport])

  const clearPendingLdrExport = useCallback((): void => {
    setPendingLdrExport(null)
  }, [])

  return { handleExportConfirm, pendingLdrExport, clearPendingLdrExport, confirmLdrExport }
}