import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { existsSync } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

// Set the app name early so the macOS menu bar shows "Verve" instead of "Electron".
app.setName('Verve')
import { registerIpcHandlers } from './ipc'
import { buildAndSetMacMenu, setMacMenuItemEnabled, setMacMenuItemChecked } from './menu'
import type { MenuBuildPayload } from './menu'

// ── Startup file path ─────────────────────────────────────────────────────────
// Stored at module level; renderer polls once on mount via app:getStartupFile.
let startupFilePath: string | null = null

// macOS: open-file fires before 'ready' when user double-clicks or drags to dock.
app.on('open-file', (event, path) => {
  event.preventDefault()
  try {
    if (existsSync(path)) {
      startupFilePath = path
      // If the window is already open (e.g. user drops a second file), send directly.
      const wins = BrowserWindow.getAllWindows()
      if (wins.length > 0) wins[0].webContents.send('app:open-file', path)
    }
  } catch { /* ignore */ }
})

function detectStartupFileFromArgs(): string | null {
  // In dev:       argv = [electron, mainScript, ...userArgs]  → skip first 2
  // In packaged:  argv = [exe, ...userArgs]                   → skip first 1
  const args = process.argv.slice(app.isPackaged ? 1 : 2)
  for (const arg of args) {
    if (arg.startsWith('-')) continue
    try { if (existsSync(arg)) return arg } catch { /* skip invalid paths */ }
  }
  return null
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.Verve')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()

  // Detect startup file from CLI args (Windows / Linux); macOS uses open-file event above.
  if (!startupFilePath) startupFilePath = detectStartupFileFromArgs()

  // IPC: renderer polls for the startup file path exactly once on mount.
  ipcMain.handle('app:getStartupFile', () => {
    const p = startupFilePath
    startupFilePath = null   // clear after first read
    return p
  })

  // ── macOS native application menu ──────────────────────────────────
  if (process.platform === 'darwin') {
    // Renderer sends full menu structure (with dynamic adjustment/filter items) on startup.
    ipcMain.on('menu:build', (_event, payload: MenuBuildPayload) => {
      buildAndSetMacMenu(payload)
    })
    // Renderer sends enabled-state updates when relevant app state changes.
    ipcMain.on('menu:set-enabled', (_event, updates: Record<string, boolean>) => {
      setMacMenuItemEnabled(updates)
    })
    // Renderer sends checked-state updates (e.g. Show Grid checkbox).
    ipcMain.on('menu:set-checked', (_event, updates: Record<string, boolean>) => {
      setMacMenuItemChecked(updates)
    })
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
