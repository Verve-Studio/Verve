import { ipcMain, dialog, BrowserWindow, app, clipboard, nativeImage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerSamHandlers } from './sam'
import { registerMattingHandlers } from './matting'

export function registerIpcHandlers(): void {
  ipcMain.handle('debug:openDevTools', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.webContents.openDevTools()
  })

  ipcMain.handle('dialog:openFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tga', 'tif', 'tiff', 'exr', 'hdr'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    return canceled ? null : filePaths[0]
  })

  ipcMain.handle('dialog:saveFile', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      filters: [
        { name: 'PNG Image', extensions: ['png'] },
        { name: 'JPEG Image', extensions: ['jpg', 'jpeg'] }
      ]
    })
    return canceled ? null : filePath
  })

  ipcMain.handle('dialog:openPxshop', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'All Supported',       extensions: ['pxshop', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tga', 'tif', 'tiff', 'exr', 'hdr'] },
        { name: 'PixelShop Document',  extensions: ['pxshop'] },
        { name: 'Images',              extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tga', 'tif', 'tiff', 'exr', 'hdr'] },
        { name: 'All Files',           extensions: ['*'] },
      ]
    })
    return canceled ? null : filePaths[0]
  })

  ipcMain.handle('dialog:savePxshop', async (_event, defaultPath?: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath,
      filters: [{ name: 'PixelShop Document', extensions: ['pxshop'] }]
    })
    return canceled ? null : filePath
  })

  ipcMain.handle('file:openPxshop', async (_event, path: string) => {
    return readFile(path, 'utf-8')
  })

  ipcMain.handle('file:savePxshop', async (_event, path: string, data: string) => {
    await writeFile(path, data, 'utf-8')
  })

  ipcMain.handle('dialog:exportBrowse', async (_event, ext: string) => {
    const filters =
      ext === 'png'    ? [{ name: 'PNG Image',         extensions: ['png']         }] :
      ext === 'webp'   ? [{ name: 'WebP Image',        extensions: ['webp']        }] :
      ext === 'tga'    ? [{ name: 'TGA Image',         extensions: ['tga']         }] :
      ext === 'tiff'   ? [{ name: 'TIFF Image',        extensions: ['tif', 'tiff'] }] :
      ext === 'tiff32' ? [{ name: 'TIFF 32-bit Float', extensions: ['tif', 'tiff'] }] :
      ext === 'exr'    ? [{ name: 'OpenEXR Image',     extensions: ['exr']         }] :
      ext === 'hdr'    ? [{ name: 'Radiance HDR',      extensions: ['hdr']         }] :
                         [{ name: 'JPEG Image',        extensions: ['jpg', 'jpeg'] }]
    const { canceled, filePath } = await dialog.showSaveDialog({ filters })
    return canceled ? null : filePath
  })

  ipcMain.handle('file:readFileBase64', async (_event, path: string) => {
    const buffer = await readFile(path)
    return buffer.toString('base64')
  })

  ipcMain.handle('file:exportImage', async (_event, path: string, base64: string) => {
    const buffer = Buffer.from(base64, 'base64')
    await writeFile(path, buffer)
  })

  ipcMain.handle('presets:loadCurvesPresets', async () => {
    const presetsPath = join(app.getPath('userData'), 'curves-presets.json')
    try {
      const data = await readFile(presetsPath, 'utf-8')
      return JSON.parse(data)
    } catch {
      // File doesn't exist yet or is corrupt; return empty array
      return []
    }
  })

  ipcMain.handle('presets:saveCurvesPresets', async (_event, presets: unknown) => {
    const presetsPath = join(app.getPath('userData'), 'curves-presets.json')
    const json = JSON.stringify(presets, null, 2)
    await writeFile(presetsPath, json, 'utf-8')
  })

  ipcMain.handle('dialog:openPalette', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Palette', extensions: ['palette'] }],
    })
    return canceled ? null : filePaths[0]
  })

  ipcMain.handle('dialog:savePaletteAs', async (_event, defaultPath?: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath,
      filters: [{ name: 'Palette', extensions: ['palette'] }],
    })
    return canceled ? null : filePath
  })

  ipcMain.handle('file:readPalette', async (_event, path: string) => {
    return readFile(path, 'utf-8')
  })

  ipcMain.handle('file:writePalette', async (_event, path: string, data: string) => {
    await writeFile(path, data, 'utf-8')
  })

  ipcMain.handle('clipboard:write-image', (_event, pngBase64: string) => {
    const buf = Buffer.from(pngBase64, 'base64')
    const img = nativeImage.createFromBuffer(buf)
    clipboard.writeImage(img)
  })

  ipcMain.handle('clipboard:read-image', () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    return img.toPNG().toString('base64')
  })

  // ── Recent files ─────────────────────────────────────────────────────────────

  const RECENT_FILES_MAX = 10

  const recentFilesPath = (): string => join(app.getPath('userData'), 'recent-files.json')

  const loadRecentFiles = async (): Promise<string[]> => {
    try {
      const data = await readFile(recentFilesPath(), 'utf-8')
      const arr = JSON.parse(data)
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  const saveRecentFiles = async (files: string[]): Promise<void> => {
    await writeFile(recentFilesPath(), JSON.stringify(files), 'utf-8')
  }

  ipcMain.handle('recentFiles:get', async () => {
    return loadRecentFiles()
  })

  ipcMain.handle('recentFiles:add', async (_event, path: string) => {
    const files = await loadRecentFiles()
    const updated = [path, ...files.filter(f => f !== path)].slice(0, RECENT_FILES_MAX)
    await saveRecentFiles(updated)
    return updated
  })

  ipcMain.handle('recentFiles:clear', async () => {
    await saveRecentFiles([])
  })

  // ── Pixel Brushes (user-profile storage) ─────────────────────────────────────

  const userBrushesPath = (): string => join(app.getPath('userData'), 'pixel-brushes.json')

  ipcMain.handle('pixelBrushes:load', async () => {
    try {
      return await readFile(userBrushesPath(), 'utf-8')
    } catch {
      return '[]'
    }
  })

  ipcMain.handle('pixelBrushes:save', async (_event, data: string) => {
    await writeFile(userBrushesPath(), data, 'utf-8')
  })

  ipcMain.handle('dialog:openBrushFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'PixelShop Brushes', extensions: ['pxbrush'] }],
    })
    return canceled ? null : filePaths[0]
  })

  ipcMain.handle('dialog:saveBrushFile', async (_event, defaultPath?: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath,
      filters: [{ name: 'PixelShop Brushes', extensions: ['pxbrush'] }],
    })
    return canceled ? null : filePath
  })

  ipcMain.handle('file:readBrushFile', async (_event, filePath: string) => {
    return readFile(filePath, 'utf-8')
  })

  ipcMain.handle('file:writeBrushFile', async (_event, filePath: string, data: string) => {
    await writeFile(filePath, data, 'utf-8')
  })

  // ── App lifecycle ─────────────────────────────────────────────────────────────

  ipcMain.handle('app:exit', () => {
    app.quit()
  })

  registerSamHandlers()
  registerMattingHandlers()
}
