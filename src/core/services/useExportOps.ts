import { exportJpeg } from '@/core/io/exportJpeg'
import { exportPng } from '@/core/io/exportPng'
import { exportTga } from '@/core/io/exportTga'
import { exportTiff } from '@/core/io/exportTiff'
import { exportWebp } from '@/core/io/exportWebp'
import type { AppState } from '@/types'
import { showOperationError } from '@/utils/userFeedback'
import { clampF32ToUint8 } from '@/utils/pixelFormatConvert'
import type { CanvasHandle } from '@/ux/main/Canvas/Canvas'
import type { ExportSettings } from '@/ux/modals/ExportDialog/ExportDialog'
import { useCallback, type MutableRefObject } from 'react'

interface UseExportOpsOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null }
  stateRef: MutableRefObject<AppState>
}

interface UseExportOpsReturn {
  handleExportConfirm: (settings: ExportSettings) => Promise<void>
}

export function useExportOps({
  canvasHandleRef,
  stateRef,
}: UseExportOpsOptions): UseExportOpsReturn {
  const handleExportConfirm = useCallback(async (settings: ExportSettings): Promise<void> => {
    try {
      const handle = canvasHandleRef.current
      if (!handle) throw new Error('Canvas renderer is not ready yet. Please try export again.')
      const flat = await handle.rasterizeLayers(stateRef.current.layers, 'export')
      const data: Uint8Array = flat.data instanceof Float32Array ? clampF32ToUint8(flat.data) : flat.data
      const { width, height } = flat
      let dataUrl: string
      if      (settings.format === 'png')  dataUrl = exportPng(data, width, height)
      else if (settings.format === 'webp') dataUrl = exportWebp(data, width, height, { quality: settings.webpQuality })
      else if (settings.format === 'tga')  dataUrl = exportTga(data, width, height)
      else if (settings.format === 'tiff') dataUrl = exportTiff(data, width, height)
      else                                 dataUrl = exportJpeg(data, width, height, { quality: settings.jpegQuality, background: settings.jpegBackground })
      await window.api.exportImage(settings.filePath, dataUrl.replace(/^data:[^;]+;base64,/, ''))
    } catch (error) {
      console.error('[useExportOps] Export failed:', error)
      showOperationError('Export failed.', error)
    }
  }, [canvasHandleRef, stateRef])

  return { handleExportConfirm }
}