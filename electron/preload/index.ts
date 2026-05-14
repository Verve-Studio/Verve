import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  openDevTools: (): Promise<void> => ipcRenderer.invoke('debug:openDevTools'),
  openFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFile'),
  saveFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:saveFile'),
  openverveDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openverve'),
  openImagesMultiDialog: (): Promise<string[] | null> =>
    ipcRenderer.invoke('dialog:openImagesMulti'),
  saveJsonDialog: (defaultName?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveJson', defaultName),
  openDirectoryDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openDirectory'),
  pickCubeLutFiles: (): Promise<Array<{ name: string; text: string }> | null> =>
    ipcRenderer.invoke('lut:pickCubeFiles'),
  writeJsonFile: (path: string, data: string): Promise<void> =>
    ipcRenderer.invoke('file:writeJson', path, data),
  saveverveDialog: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveverve', defaultPath),
  openverveFile: (path: string): Promise<string> => ipcRenderer.invoke('file:openverve', path),
  saveverveFile: (path: string, data: string): Promise<void> =>
    ipcRenderer.invoke('file:saveverve', path, data),
  exportBrowse: (ext: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:exportBrowse', ext),
  exportImage: (path: string, base64: string): Promise<void> =>
    ipcRenderer.invoke('file:exportImage', path, base64),
  readFileBase64: (path: string): Promise<string> =>
    ipcRenderer.invoke('file:readFileBase64', path),
  loadCurvesPresets: (): Promise<unknown> =>
    ipcRenderer.invoke('presets:loadCurvesPresets'),
  saveCurvesPresets: (presets: unknown): Promise<void> =>
    ipcRenderer.invoke('presets:saveCurvesPresets', presets),
  openPaletteDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openPalette'),
  openIccProfileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openIccProfile'),
  cmsListProfiles: (): Promise<
    Array<{ id: string; filename: string; source: 'system' | 'user'; size: number }>
  > => ipcRenderer.invoke('cms:listProfiles'),
  cmsReadProfileBytes: (id: string): Promise<string | null> =>
    ipcRenderer.invoke('cms:readProfileBytes', id),
  cmsImportProfileDialog: (): Promise<{
    id: string
    filename: string
    source: 'system' | 'user'
    size: number
  } | null> => ipcRenderer.invoke('cms:importProfileDialog'),
  cmsDeleteUserProfile: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('cms:deleteUserProfile', id),
  savePaletteAsDialog: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:savePaletteAs', defaultPath),
  readPaletteFile: (path: string): Promise<string> =>
    ipcRenderer.invoke('file:readPalette', path),
  writePaletteFile: (path: string, data: string): Promise<void> =>
    ipcRenderer.invoke('file:writePalette', path, data),
  clipboardWriteImage: (pngBase64: string): Promise<void> =>
    ipcRenderer.invoke('clipboard:write-image', pngBase64),
  clipboardReadImage: (): Promise<string | null> =>
    ipcRenderer.invoke('clipboard:read-image'),

  // ── Recent files ─────────────────────────────────────────────────────────────
  getRecentFiles: (): Promise<string[]> => ipcRenderer.invoke('recentFiles:get'),
  addRecentFile: (path: string): Promise<string[]> => ipcRenderer.invoke('recentFiles:add', path),
  clearRecentFiles: (): Promise<void> => ipcRenderer.invoke('recentFiles:clear'),

  // ── Pixel Brushes (user-profile storage) ─────────────────────────────────────
  loadUserPixelBrushes: (): Promise<string> => ipcRenderer.invoke('pixelBrushes:load'),
  saveUserPixelBrushes: (data: string): Promise<void> => ipcRenderer.invoke('pixelBrushes:save', data),
  loadUserBrushes: (): Promise<string> => ipcRenderer.invoke('paintBrushes:load'),
  saveUserBrushes: (data: string): Promise<void> => ipcRenderer.invoke('paintBrushes:save', data),
  openPaintBrushFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openPaintBrushFile'),
  savePaintBrushFileDialog: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:savePaintBrushFile', defaultPath),
  readPaintBrushFile: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('file:readPaintBrushFile', filePath),
  writePaintBrushFile: (filePath: string, data: string): Promise<void> =>
    ipcRenderer.invoke('file:writePaintBrushFile', filePath, data),
  openBrushFileDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openBrushFile'),
  saveBrushFileDialog: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveBrushFile', defaultPath),
  readBrushFile: (filePath: string): Promise<string> => ipcRenderer.invoke('file:readBrushFile', filePath),
  writeBrushFile: (filePath: string, data: string): Promise<void> =>
    ipcRenderer.invoke('file:writeBrushFile', filePath, data),

  // ── Dock layout ──────────────────────────────────────────────────────────────
  loadDockLayout: (): Promise<unknown> => ipcRenderer.invoke('dockLayout:load'),
  saveDockLayout: (layout: unknown): Promise<void> => ipcRenderer.invoke('dockLayout:save', layout),

  // ── App lifecycle ─────────────────────────────────────────────────────────────
  exitApp: (): Promise<void> => ipcRenderer.invoke('app:exit'),

  // ── Preferences (persisted to userData/preferences.json) ────────────────
  loadPreferences: (): Promise<{
    theme?: 'light' | 'dark' | 'auto'
    historyMemoryBytes: number
    bufferMemoryBytes: number
    bufferMemoryMaxOut: boolean
    unifiedMemory?: boolean
  }> => ipcRenderer.invoke('prefs:load'),
  savePreferences: (prefs: {
    theme?: 'light' | 'dark' | 'auto'
    historyMemoryBytes: number
    bufferMemoryBytes: number
    bufferMemoryMaxOut: boolean
    unifiedMemory: boolean
  }): Promise<void> => ipcRenderer.invoke('prefs:save', prefs),
  getSystemTotalMemoryBytes: (): Promise<number> =>
    ipcRenderer.invoke('system:totalMemoryBytes'),

  // ── Startup file path ─────────────────────────────────────────────────────────
  /** Poll once on mount — returns the file path passed as a CLI arg, or null. */
  getStartupFile: (): Promise<string | null> => ipcRenderer.invoke('app:getStartupFile'),

  /** Listen for runtime file-open events (macOS dock drop / open-with). */
  onOpenFile: (callback: (path: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, path: string): void => callback(path)
    ipcRenderer.on('app:open-file', handler)
    return () => ipcRenderer.removeListener('app:open-file', handler)
  },

  // ── Printing ──────────────────────────────────────────────────────────────────
  listPrinters: (): Promise<
    | Array<{
        name: string
        displayName?: string
        description?: string
        isDefault?: boolean
      }>
    | { error: string }
  > => ipcRenderer.invoke('printer:list'),

  print: (opts: {
    deviceName: string
    pngBase64: string
    pageSize:
      | 'A3' | 'A4' | 'A5' | 'Legal' | 'Letter' | 'Tabloid'
      | { widthMicrons: number; heightMicrons: number }
    landscape: boolean
    margins: {
      marginType: 'default' | 'none' | 'printableArea' | 'custom'
      topMicrons?: number
      bottomMicrons?: number
      leftMicrons?: number
      rightMicrons?: number
    }
    color: boolean
    copies: number
    collate: boolean
    dpi: number
  }): Promise<{ success: boolean; reason?: string; error?: string }> =>
    ipcRenderer.invoke('printer:print', opts),

  // ── File Associations ─────────────────────────────────────────────────────────
  getFileAssocState: (): Promise<{
    supported: Array<{ ext: string; label: string }>
    registered: string[]
    platform: string
    error?: string
  }> => ipcRenderer.invoke('fileAssoc:getState'),

  applyFileAssoc: (exts: string[]): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('fileAssoc:apply', exts),

  // ── System info ───────────────────────────────────────────────────────────────
  getSystemInfo: (): Promise<{
    osName: string
    osVersion: string
    cpuModel: string
    cpuCores: number
    totalRamBytes: number
    gpus: Array<{ name: string; active: boolean; driverVersion: string }>
  }> => ipcRenderer.invoke('system:getInfo'),

  // ── Platform & native menu (macOS) ────────────────────────────────
  platform: process.platform as string,

  /** Listen for native menu actions. Returns a cleanup function that removes the listener. */
  onMenuAction: (callback: (actionId: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, actionId: string): void => callback(actionId)
    ipcRenderer.on('menu:action', handler)
    return () => ipcRenderer.removeListener('menu:action', handler)
  },

  /** Rebuild the macOS native application menu. The full serialized
   *  tree is sent on every state change — see
   *  `src/core/services/useMacNativeMenu.ts` and the comment block in
   *  `electron/main/menu.ts` for why this is one IPC instead of the
   *  previous build/set-enabled/set-checked/set-visible quartet. */
  rebuildNativeMenu: (tree: unknown): void => {
    ipcRenderer.send('menu:rebuild', tree)
  },

  // ── LaMa inpainting (Object Removal tool) ───────────────────────────────
  inpaint: {
    checkModel: (): Promise<{ ready: boolean; path: string | null; searchedPaths: string[] }> =>
      ipcRenderer.invoke('inpaint:check-model'),

    run: (params: {
      rgba: Uint8Array
      mask: Uint8Array
      width: number
      height: number
    }): Promise<{ rgba: Uint8Array; width: number; height: number; provider: string }> =>
      ipcRenderer.invoke('inpaint:run', {
        rgba: Buffer.from(params.rgba.buffer, params.rgba.byteOffset, params.rgba.byteLength),
        mask: Buffer.from(params.mask.buffer, params.mask.byteOffset, params.mask.byteLength),
        width: params.width,
        height: params.height,
      }),

    invalidateSession: (): Promise<void> =>
      ipcRenderer.invoke('inpaint:invalidate-session'),
  },

  // ── ISNet auto-mask (Auto-Mask tool) ─────────────────────────────────────
  isnet: {
    checkModel: (): Promise<{ ready: boolean; path: string | null; searchedPaths: string[] }> =>
      ipcRenderer.invoke('isnet:check-model'),

    run: (params: {
      rgba: Uint8Array
      width: number
      height: number
    }): Promise<{ mask: Uint8Array; width: number; height: number; provider: string }> =>
      ipcRenderer.invoke('isnet:run', {
        rgba: Buffer.from(params.rgba.buffer, params.rgba.byteOffset, params.rgba.byteLength),
        width: params.width,
        height: params.height,
      }),

    invalidateSession: (): Promise<void> =>
      ipcRenderer.invoke('isnet:invalidate-session'),
  },

  // ── AI Upscale (Rescale Image) ────────────────────────────────
  upscale: {
    listModels: (): Promise<Array<{ id: string; label: string; scale: number }>> =>
      ipcRenderer.invoke('upscale:list-models'),

    checkModel: (
      modelId: string,
    ): Promise<{ ready: boolean; path: string | null; searchedPaths: string[] }> =>
      ipcRenderer.invoke('upscale:check-model', modelId),

    run: (params: {
      rgba: Uint8Array
      width: number
      height: number
      modelId: string
      targetWidth: number
      targetHeight: number
    }): Promise<{ rgba: Uint8Array; width: number; height: number; provider: string }> =>
      ipcRenderer.invoke('upscale:run', {
        rgba: Buffer.from(params.rgba.buffer, params.rgba.byteOffset, params.rgba.byteLength),
        width: params.width,
        height: params.height,
        modelId: params.modelId,
        targetWidth: params.targetWidth,
        targetHeight: params.targetHeight,
      }),

    invalidateSession: (modelId?: string): Promise<void> =>
      ipcRenderer.invoke('upscale:invalidate-session', modelId),

    onProgress: (
      callback: (p: { progress: number; loaded: number; total: number }) => void,
    ): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        p: { progress: number; loaded: number; total: number },
      ): void => callback(p)
      ipcRenderer.on('upscale:progress', handler)
      return () => ipcRenderer.removeListener('upscale:progress', handler)
    },
  },

  // ── Alpha matting (Refine Edge) ─────────────────────────────────
  matting: {
    checkModel: (): Promise<{ ready: boolean; path: string | null }> =>
      ipcRenderer.invoke('matting:check-model'),

    downloadModel: (): Promise<{ success: true } | { error: string }> =>
      ipcRenderer.invoke('matting:download-model'),

    refine: (params: {
      imageRgba: Uint8Array
      width: number
      height: number
      selectionMask: Uint8Array
      bandRadius: number
      mode: 'hair' | 'object'
    }): Promise<{ alpha: Uint8Array }> =>
      ipcRenderer.invoke('matting:refine', {
        imageRgba: Buffer.from(params.imageRgba.buffer, params.imageRgba.byteOffset, params.imageRgba.byteLength),
        width: params.width,
        height: params.height,
        selectionMask: Buffer.from(params.selectionMask.buffer, params.selectionMask.byteOffset, params.selectionMask.byteLength),
        bandRadius: params.bandRadius,
        mode: params.mode,
      }),

    invalidateSession: (): Promise<void> =>
      ipcRenderer.invoke('matting:invalidate-session'),

    onDownloadProgress: (
      callback: (p: { progress: number; loaded: number; total: number }) => void,
    ): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        p: { progress: number; loaded: number; total: number },
      ): void => callback(p)
      ipcRenderer.on('matting:download-progress', handler)
      return () => ipcRenderer.removeListener('matting:download-progress', handler)
    },
  },
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
