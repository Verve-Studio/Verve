import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      openDevTools: () => Promise<void>
      openFile: () => Promise<string | null>
      saveFile: () => Promise<string | null>
      openverveDialog: () => Promise<string | null>
      openImagesMultiDialog: () => Promise<string[] | null>
      saveJsonDialog: (defaultName?: string) => Promise<string | null>
      openDirectoryDialog: () => Promise<string | null>
      pickCubeLutFiles: () => Promise<Array<{ name: string; text: string }> | null>
      writeJsonFile: (path: string, data: string) => Promise<void>
      saveverveDialog: (defaultPath?: string) => Promise<string | null>
      openverveFile: (path: string) => Promise<string>
      saveverveFile: (path: string, data: string) => Promise<void>
      exportBrowse: (ext: string) => Promise<string | null>
      exportImage: (path: string, base64: string) => Promise<void>
      readFileBase64: (path: string) => Promise<string>
      loadCurvesPresets: () => Promise<CurvesPreset[]>
      saveCurvesPresets: (presets: CurvesPreset[]) => Promise<void>
      openPaletteDialog: () => Promise<string | null>
      savePaletteAsDialog: (defaultPath?: string) => Promise<string | null>
      readPaletteFile: (path: string) => Promise<string>
      writePaletteFile: (path: string, data: string) => Promise<void>
      clipboardWriteImage: (pngBase64: string) => Promise<void>
      clipboardReadImage: () => Promise<string | null>
      // Recent files
      getRecentFiles: () => Promise<string[]>
      addRecentFile: (path: string) => Promise<string[]>
      clearRecentFiles: () => Promise<void>
      // Pixel Brushes (user-profile storage)
      loadUserPixelBrushes: () => Promise<string>
      saveUserPixelBrushes: (data: string) => Promise<void>
      // Paint Brushes (user-profile storage)
      loadUserBrushes: () => Promise<string>
      saveUserBrushes: (data: string) => Promise<void>
      openPaintBrushFileDialog: () => Promise<string | null>
      savePaintBrushFileDialog: (defaultPath?: string) => Promise<string | null>
      readPaintBrushFile: (filePath: string) => Promise<string>
      writePaintBrushFile: (filePath: string, data: string) => Promise<void>
      openBrushFileDialog: () => Promise<string | null>
      saveBrushFileDialog: (defaultPath?: string) => Promise<string | null>
      readBrushFile: (filePath: string) => Promise<string>
      writeBrushFile: (filePath: string, data: string) => Promise<void>
      // Dock layout
      loadDockLayout: () => Promise<unknown>
      saveDockLayout: (layout: unknown) => Promise<void>
      // App lifecycle
      exitApp: () => Promise<void>
      // Preferences
      loadPreferences: () => Promise<{
        historyMemoryBytes: number
        bufferMemoryBytes: number
        bufferMemoryMaxOut: boolean
        unifiedMemory?: boolean
      }>
      savePreferences: (prefs: {
        historyMemoryBytes: number
        bufferMemoryBytes: number
        bufferMemoryMaxOut: boolean
        unifiedMemory: boolean
      }) => Promise<void>
      getSystemTotalMemoryBytes: () => Promise<number>
      // Startup file path (CLI arg)
      getStartupFile: () => Promise<string | null>
      onOpenFile: (callback: (path: string) => void) => (() => void)
      // File Associations
      getFileAssocState: () => Promise<{
        supported: Array<{ ext: string; label: string }>
        registered: string[]
        platform: string
        error?: string
      }>
      applyFileAssoc: (exts: string[]) => Promise<{ success: boolean; error?: string }>
      // System info
      getSystemInfo: () => Promise<{
        osName: string
        osVersion: string
        cpuModel: string
        cpuCores: number
        totalRamBytes: number
        gpus: Array<{ name: string; active: boolean; driverVersion: string }>
      }>
      // Platform & native menu (macOS)
      platform: string
      onMenuAction: (callback: (actionId: string) => void) => (() => void)
      rebuildNativeMenu: (tree: unknown) => void
      // SAM / Object Selection
      sam: {
        checkModel: () => Promise<{ encoderReady: boolean; decoderReady: boolean }>
        downloadModel: () => Promise<{ success: true } | { error: string }>
        encodeImage: (
          imageData: Uint8Array,
          origWidth: number,
          origHeight: number,
        ) => Promise<{ embeddings: Uint8Array }>
        decodeMask: (params: {
          embeddings: Uint8Array | null
          points: Array<{ x: number; y: number; positive: boolean }>
          box: { x1: number; y1: number; x2: number; y2: number } | null
          origWidth: number
          origHeight: number
        }) => Promise<{ mask: Uint8Array; width: number; height: number; iouScore: number }>
        invalidateCache: () => Promise<void>
        onDownloadProgress: (
          callback: (p: { file: 'encoder' | 'decoder'; progress: number }) => void,
        ) => () => void
      }
      // Alpha matting (Refine Edge)
      matting: {
        checkModel: () => Promise<{ ready: boolean; path: string | null }>
        downloadModel: () => Promise<{ success: true } | { error: string }>
        refine: (params: {
          imageRgba: Uint8Array
          width: number
          height: number
          selectionMask: Uint8Array
          bandRadius: number
          mode: 'hair' | 'object'
        }) => Promise<{ alpha: Uint8Array }>
        invalidateSession: () => Promise<void>
        onDownloadProgress: (
          callback: (p: { progress: number; loaded: number; total: number }) => void,
        ) => () => void
      }
    }
  }

  interface CurvesControlPoint {
    id: string
    x: number
    y: number
  }

  interface CurvesChannelCurve {
    points: CurvesControlPoint[]
  }

  type CurvesChannel = 'rgb' | 'red' | 'green' | 'blue'

  interface CurvesPreset {
    id: string
    name: string
    channels: Record<CurvesChannel, CurvesChannelCurve>
  }
}
