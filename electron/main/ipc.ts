import { ipcMain, dialog, BrowserWindow, app, clipboard, nativeImage } from 'electron'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { is } from '@electron-toolkit/utils'
import { writeFileAtomic } from './atomicWrite'
import {
  EXPORT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  assertReadable,
  assertWritable,
  grantPicked
} from './fileAccess'
import { join, basename } from 'node:path'
import { execSync } from 'node:child_process'
import os from 'node:os'
import { registerMlHandlers } from './ml/mlIpc'
import { SUPPORTED_FILE_TYPES, getRegisteredExtensions, applyExtensions } from './fileAssociations'

export function registerIpcHandlers(): void {
  ipcMain.handle('debug:openDevTools', (event) => {
    // Development builds only: in a shipped app any renderer code could
    // otherwise open DevTools.
    if (!is.dev) return
    BrowserWindow.fromWebContents(event.sender)?.webContents.openDevTools()
  })

  ipcMain.handle('dialog:openFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'avif', 'tga', 'pcx', 'tif', 'tiff', 'exr', 'hdr', 'dds'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (!canceled) grantPicked(filePaths)
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

  ipcMain.handle('dialog:openDirectory', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    return canceled ? null : filePaths[0]
  })

  // ── LUT pickers ────────────────────────────────────────────────────────
  // Renderer-side `<input type=file>` pickers lose user-activation across
  // menu animations (Chromium error: "File chooser dialog can only be
  // shown with a user activation"). Drive these from the main process so
  // the OS dialog opens reliably no matter how we got here.

  ipcMain.handle('lut:pickCubeFiles', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Load LUT files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Cube LUT', extensions: ['cube'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (canceled || filePaths.length === 0) return null
    const out: Array<{ name: string; text: string }> = []
    for (const p of filePaths) {
      try {
        out.push({ name: basename(p), text: await readFile(p, 'utf-8') })
      } catch (err) {
        console.warn('[lut:pickCubeFiles] failed to read', p, err)
      }
    }
    return out
  })

  ipcMain.handle('dialog:saveJson', async (_event, defaultName?: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    return canceled ? null : filePath
  })

  ipcMain.handle('file:writeJson', async (_event, path: string, data: string) => {
    await writeFileAtomic(assertWritable(path, ['json']), data, 'utf-8')
  })

  ipcMain.handle('dialog:openImagesMulti', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp', 'tga', 'pcx', 'tif', 'tiff', 'exr', 'hdr', 'dds'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (!canceled) grantPicked(filePaths)
    return canceled ? null : filePaths
  })

  ipcMain.handle('dialog:openverve', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'All Supported',       extensions: ['verve', 'psd', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp', 'tga', 'pcx', 'tif', 'tiff', 'exr', 'hdr', 'dds'] },
        { name: 'Verve Document',  extensions: ['verve'] },
        { name: 'Photoshop Document',  extensions: ['psd'] },
        { name: 'Images',              extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp', 'tga', 'pcx', 'tif', 'tiff', 'exr', 'hdr', 'dds'] },
        { name: 'All Files',           extensions: ['*'] },
      ]
    })
    if (!canceled) grantPicked(filePaths)
    return canceled ? null : filePaths[0]
  })

  ipcMain.handle('dialog:saveverve', async (_event, defaultPath?: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath,
      filters: [{ name: 'Verve Document', extensions: ['verve'] }]
    })
    return canceled ? null : filePath
  })

  // .verve documents travel as raw bytes (binary container, or legacy JSON
  // text that the renderer decodes itself) — never as one giant string.
  ipcMain.handle('file:openverve', async (_event, path: string) => {
    return readFile(assertReadable(path, ['verve']))
  })

  ipcMain.handle('file:saveverve', async (_event, path: string, data: Uint8Array) => {
    await writeFileAtomic(assertWritable(path, ['verve']), data)
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
      ext === 'dds'    ? [{ name: 'DDS Texture',        extensions: ['dds']         }] :
      ext === 'psd'    ? [{ name: 'Photoshop Document', extensions: ['psd']         }] :
      ext === 'pdf'    ? [{ name: 'PDF Document',       extensions: ['pdf']         }] :
                         [{ name: 'JPEG Image',        extensions: ['jpg', 'jpeg'] }]
    const { canceled, filePath } = await dialog.showSaveDialog({ filters })
    return canceled ? null : filePath
  })

  // Raw bytes (arrives in the renderer as a Uint8Array). Base64 strings
  // made 4–5 full copies of every image on the JS heap and could hit V8's
  // maximum string length on large EXR / PSD / TIFF files.
  ipcMain.handle('file:read', async (_event, path: string) => {
    return readFile(assertReadable(path, [...IMAGE_EXTENSIONS, 'icc', 'icm']))
  })

  // `data` is raw bytes, or base64 for encoders that only produce data URLs
  // (canvas-encoded PNG / JPEG).
  ipcMain.handle('file:exportImage', async (_event, path: string, data: Uint8Array | string) => {
    const target = assertWritable(path, EXPORT_EXTENSIONS)
    const bytes = typeof data === 'string' ? Buffer.from(data, 'base64') : data
    await writeFileAtomic(target, bytes)
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
    await writeFileAtomic(presetsPath, json, 'utf-8')
  })

  ipcMain.handle('dialog:openPalette', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Palette', extensions: ['palette'] }],
    })
    if (!canceled) grantPicked(filePaths)
    return canceled ? null : filePaths[0]
  })

  ipcMain.handle('dialog:openIccProfile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'ICC Profile', extensions: ['icc', 'icm'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (!canceled) grantPicked(filePaths)
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
    return readFile(assertReadable(path, ['palette', 'json']), 'utf-8')
  })

  ipcMain.handle('file:writePalette', async (_event, path: string, data: string) => {
    await writeFileAtomic(assertWritable(path, ['palette']), data, 'utf-8')
  })

  // Raw nativeImage bitmaps both ways (premultiplied BGRA, Skia N32): no
  // synchronous PNG encode/decode of a multi-megapixel image on the main
  // process. The renderer swizzles / (un)premultiplies (core/io/clipboardBitmap).
  ipcMain.handle(
    'clipboard:write-image',
    (_event, bitmap: Uint8Array, width: number, height: number) => {
      if (
        !Number.isInteger(width) || !Number.isInteger(height) ||
        width <= 0 || height <= 0 ||
        bitmap.byteLength !== width * height * 4
      ) {
        throw new Error('Invalid clipboard bitmap')
      }
      const img = nativeImage.createFromBitmap(
        Buffer.from(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength),
        { width, height }
      )
      clipboard.writeImage(img)
    }
  )

  ipcMain.handle('clipboard:read-image', () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    const bmp = img.toBitmap()
    return { width, height, data: new Uint8Array(bmp.buffer, bmp.byteOffset, bmp.byteLength) }
  })

  ipcMain.handle('clipboard:image-size', () => {
    const img = clipboard.readImage()
    return img.isEmpty() ? null : img.getSize()
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
    await writeFileAtomic(recentFilesPath(), JSON.stringify(files), 'utf-8')
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
    await writeFileAtomic(userBrushesPath(), data, 'utf-8')
  })

  // ── Paint Brushes (user-profile storage) ─────────────────────────────────────

  const userPaintBrushesPath = (): string => join(app.getPath('userData'), 'paint-brushes.json')

  ipcMain.handle('paintBrushes:load', async () => {
    try {
      return await readFile(userPaintBrushesPath(), 'utf-8')
    } catch {
      return '[]'
    }
  })

  ipcMain.handle('paintBrushes:save', async (_event, data: string) => {
    await writeFileAtomic(userPaintBrushesPath(), data, 'utf-8')
  })

  // ── Paint Brush import/export (.vbrush) ─────────────────────────────────────

  ipcMain.handle('dialog:openPaintBrushFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Verve Paint Brushes', extensions: ['vbrush'] }],
    })
    if (!canceled) grantPicked(filePaths)
    return canceled ? null : filePaths[0]
  })

  ipcMain.handle('dialog:savePaintBrushFile', async (_event, defaultPath?: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath,
      filters: [{ name: 'Verve Paint Brushes', extensions: ['vbrush'] }],
    })
    return canceled ? null : filePath
  })

  ipcMain.handle('file:readPaintBrushFile', async (_event, filePath: string) => {
    return readFile(assertReadable(filePath, ['vbrush']), 'utf-8')
  })

  ipcMain.handle('file:writePaintBrushFile', async (_event, filePath: string, data: string) => {
    await writeFileAtomic(assertWritable(filePath, ['vbrush']), data, 'utf-8')
  })

  // ── Dock layout ───────────────────────────────────────────────────────────
  const dockLayoutPath = (): string => join(app.getPath('userData'), 'dock-layout.json')

  ipcMain.handle('dockLayout:load', async () => {
    try {
      const data = await readFile(dockLayoutPath(), 'utf-8')
      return JSON.parse(data) as unknown
    } catch {
      return null
    }
  })

  ipcMain.handle('dockLayout:save', async (_event, layout: unknown) => {
    await writeFileAtomic(dockLayoutPath(), JSON.stringify(layout, null, 2), 'utf-8')
  })

  ipcMain.handle('dialog:openBrushFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Verve Brushes', extensions: ['pxbrush'] }],
    })
    if (!canceled) grantPicked(filePaths)
    return canceled ? null : filePaths[0]
  })

  ipcMain.handle('dialog:saveBrushFile', async (_event, defaultPath?: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath,
      filters: [{ name: 'Verve Brushes', extensions: ['pxbrush'] }],
    })
    return canceled ? null : filePath
  })

  ipcMain.handle('file:readBrushFile', async (_event, filePath: string) => {
    return readFile(assertReadable(filePath, ['pxbrush']), 'utf-8')
  })

  ipcMain.handle('file:writeBrushFile', async (_event, filePath: string, data: string) => {
    await writeFileAtomic(assertWritable(filePath, ['pxbrush']), data, 'utf-8')
  })

  // ── App lifecycle ─────────────────────────────────────────────────────────────

  ipcMain.handle('app:exit', () => {
    app.quit()
  })

  // ── System info ───────────────────────────────────────────────────────────────

  ipcMain.handle('system:getInfo', async () => {
    const cpus = os.cpus()
    const gpuInfo = await app.getGPUInfo('complete') as {
      gpuDevice?: Array<{
        vendorString?: string
        deviceString?: string
        active?: boolean
        driverVersion?: string
        driverDate?: string
      }>
      auxAttributes?: Record<string, unknown>
    }
    const osType = os.type()
    const osName = osType === 'Darwin' ? 'macOS' : osType === 'Windows_NT' ? 'Windows' : osType
    let osVersion: string
    if (osType === 'Darwin') {
      try {
        osVersion = execSync('sw_vers -productVersion', { timeout: 2000 }).toString().trim()
      } catch {
        osVersion = os.release()
      }
    } else {
      osVersion = os.version()
    }
    return {
      osName,
      osVersion,
      cpuModel: cpus[0]?.model ?? 'Unknown',
      cpuCores: cpus.length,
      totalRamBytes: os.totalmem(),
      gpus: (gpuInfo.gpuDevice ?? []).map(g => ({
        name: [g.vendorString, g.deviceString].filter(Boolean).join(' ') || 'Unknown GPU',
        active: g.active ?? false,
        driverVersion: g.driverVersion ?? '',
      })),
    }
  })

  registerMlHandlers()

  // ── File Associations ─────────────────────────────────────────────────────────

  ipcMain.handle('fileAssoc:getState', async () => {
    try {
      return {
        supported: SUPPORTED_FILE_TYPES,
        registered: await getRegisteredExtensions(),
        platform: process.platform,
      }
    } catch (e) {
      return {
        supported: SUPPORTED_FILE_TYPES,
        registered: [],
        platform: process.platform,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  })

  ipcMain.handle('fileAssoc:apply', async (_event, exts: string[]) => {
    // Validate: only allow known extensions
    const valid = new Set(SUPPORTED_FILE_TYPES.map(t => t.ext))
    const sanitized = exts.filter((e): e is string => typeof e === 'string' && valid.has(e))
    try {
      await applyExtensions(sanitized)
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── Print pipeline ──────────────────────────────────────────────────────
  // The renderer drives the Print Preview UI; main owns the OS-level print
  // job. Flow: renderer rasterises the document to a PNG, hands it to main
  // with print options, main spawns an offscreen BrowserWindow that lays
  // out the image at exact page-mm dimensions, then drives
  // webContents.print({ silent: true, ... }) so the OS print dialog is
  // never surfaced — every choice the user made in our dialog is honoured.

  ipcMain.handle('printer:list', async (event) => {
    const wc = event.sender
    try {
      const printers = await wc.getPrintersAsync()
      return printers.map(p => {
        // CUPS / Linux / macOS expose default-ness via the per-printer
        // options bag; Windows does not, so we accept any of the common
        // keys. Empty options object means "default unknown".
        const opts = (p.options ?? {}) as Record<string, unknown>
        const isDefault =
          opts['printer-is-default'] === 'true' ||
          opts['printer-is-default'] === true ||
          opts['is-default'] === 'true'
        return {
          name: p.name,
          displayName: p.displayName,
          description: p.description,
          isDefault,
        }
      })
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  type PrintOptions = {
    deviceName: string
    pngBase64: string
    /** Page size: standard name or custom microns (1mm = 1000µm). */
    pageSize:
      | 'A3' | 'A4' | 'A5' | 'Legal' | 'Letter' | 'Tabloid'
      | { widthMicrons: number; heightMicrons: number }
    landscape: boolean
    /** Margins in microns. `marginType` controls whether `custom` values are
     *  used; 'none' / 'default' / 'printableArea' ignore the custom values. */
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
    /** Renderer-side image is already rasterised at the chosen DPI; we still
     *  pass it through to Electron so the driver honours its preferred DPI. */
    dpi: number
  }

  /** Upper bound for the OS print callback; see the handler below. */
  const PRINT_TIMEOUT_MS = 120_000

  ipcMain.handle('printer:print', async (_event, opts: PrintOptions) => {
    // Build an off-screen window sized to the page (1in = 96 CSS px;
    // Electron's print pipeline measures the document in CSS pixels and
    // rasterises at the printer's DPI from there). The page-size CSS makes
    // Chromium emit exactly one page per layout box.
    let pageCss: string
    let pageWidthIn: number
    let pageHeightIn: number
    const SIZES_IN: Record<string, [number, number]> = {
      A3: [11.69, 16.54],
      A4: [8.27, 11.69],
      A5: [5.83, 8.27],
      Legal: [8.5, 14],
      Letter: [8.5, 11],
      Tabloid: [11, 17],
    }
    if (typeof opts.pageSize === 'string') {
      const [w, h] = SIZES_IN[opts.pageSize]
      pageWidthIn = opts.landscape ? h : w
      pageHeightIn = opts.landscape ? w : h
      pageCss = `${opts.pageSize}${opts.landscape ? ' landscape' : ''}`
    } else {
      pageWidthIn = opts.pageSize.widthMicrons / 25400
      pageHeightIn = opts.pageSize.heightMicrons / 25400
      if (opts.landscape) [pageWidthIn, pageHeightIn] = [pageHeightIn, pageWidthIn]
      pageCss = `${pageWidthIn}in ${pageHeightIn}in`
    }

    const m = opts.margins
    const cssMarginIn = (microns: number | undefined): string =>
      microns !== undefined ? `${microns / 25400}in` : '0'
    const marginsCss =
      m.marginType === 'custom'
        ? `${cssMarginIn(m.topMicrons)} ${cssMarginIn(m.rightMicrons)} ${cssMarginIn(m.bottomMicrons)} ${cssMarginIn(m.leftMicrons)}`
        : m.marginType === 'none'
          ? '0'
          : '0.5in'

    // Stage the print job in a temp directory. Embedding the PNG as a
    // `data:` URI inside a `data:text/html` URL blew past Chromium's URL
    // length cap (ERR_INVALID_URL -300) on any non-trivial document.
    // Writing the PNG + HTML to disk and loading the HTML via `loadFile`
    // sidesteps URL-length limits entirely while letting the HTML
    // reference the image with a plain `file://` src.
    const tempDir = await mkdtemp(join(app.getPath('temp'), 'verve-print-'))
    const pngPath = join(tempDir, 'page.png')
    const htmlPath = join(tempDir, 'page.html')
    await writeFile(pngPath, Buffer.from(opts.pngBase64, 'base64'))
    const html = `<!doctype html><html><head><style>
      @page { size: ${pageCss}; margin: ${marginsCss}; }
      html, body { margin: 0; padding: 0; background: white; }
      .page { width: 100%; height: 100vh; display: flex; align-items: center; justify-content: center; }
      .page img {
        max-width: 100%;
        max-height: 100%;
        ${opts.color ? '' : 'filter: grayscale(100%);'}
        object-fit: contain;
        image-rendering: -webkit-optimize-contrast;
      }
      </style></head><body>
      <div class="page"><img src="page.png" /></div>
      </body></html>`
    await writeFile(htmlPath, html, 'utf-8')

    const cleanupTemp = async (): Promise<void> => {
      try {
        await rm(tempDir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }

    const win = new BrowserWindow({
      show: false,
      width: Math.round(pageWidthIn * 96),
      height: Math.round(pageHeightIn * 96),
      webPreferences: { offscreen: false },
    })
    try {
      await win.loadFile(htmlPath)
      // Give the <img> a microtask to lay out before printing.
      await new Promise(resolve => setTimeout(resolve, 50))

      const printOptions: Parameters<typeof win.webContents.print>[0] = {
        silent: true,
        printBackground: true,
        color: opts.color,
        margins: {
          marginType: m.marginType,
          ...(m.marginType === 'custom'
            ? {
                top: (m.topMicrons ?? 0) / 25400,
                bottom: (m.bottomMicrons ?? 0) / 25400,
                left: (m.leftMicrons ?? 0) / 25400,
                right: (m.rightMicrons ?? 0) / 25400,
              }
            : {}),
        },
        landscape: opts.landscape,
        copies: Math.max(1, Math.floor(opts.copies)),
        collate: opts.collate,
        deviceName: opts.deviceName,
        pageSize:
          typeof opts.pageSize === 'string'
            ? opts.pageSize
            : { width: opts.pageSize.widthMicrons, height: opts.pageSize.heightMicrons },
        dpi: { horizontal: opts.dpi, vertical: opts.dpi },
      }

      return await new Promise<{ success: boolean; reason?: string; error?: string }>(
        resolve => {
          let settled = false
          // Some drivers / cancelled spoolers never invoke the print
          // callback: without a deadline the hidden window and temp dir
          // leaked and the renderer's print dialog hung forever.
          const timeout = setTimeout(() => {
            if (settled) return
            settled = true
            if (!win.isDestroyed()) win.destroy()
            void cleanupTemp()
            resolve({ success: false, error: 'The print job did not respond (timed out).' })
          }, PRINT_TIMEOUT_MS)
          win.webContents.print(printOptions, (success, reason) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            // Defer close + temp-dir cleanup — webContents.print resolves
            // before the OS spool queue has accepted the job on some
            // drivers, and destroying the BrowserWindow too eagerly can
            // cancel the in-flight job. 500ms is enough headroom in
            // practice without making the dialog feel sluggish.
            setTimeout(() => {
              if (!win.isDestroyed()) win.destroy()
              void cleanupTemp()
            }, 500)
            if (success) resolve({ success: true })
            else resolve({ success: false, reason })
          })
        },
      )
    } catch (e) {
      win.destroy()
      void cleanupTemp()
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}
