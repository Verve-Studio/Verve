import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

// Set the app name early so the macOS menu bar shows "Verve" instead of "Electron".
app.setName('Verve')
import { registerIpcHandlers } from './ipc'
import { buildAndSetMacMenu, setMacMenuItemEnabled, setMacMenuItemChecked } from './menu'
import type { MenuBuildPayload } from './menu'

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
