import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { existsSync } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

// Set the app name early so the macOS menu bar shows "Verve" instead of "Electron".
app.setName('Verve')

// Disable Chromium subsystems we never use. Switches must be appended before
// `app.whenReady()`.
//
// MediaRouter / DialMediaRouteProvider / CastMediaRouteProvider — Cast and
//   Presentation APIs. The router probes mDNS at startup on macOS, adding
//   launch latency and triggering a "wants to find devices on your local
//   network" permission prompt.
// AutofillServerCommunication — Chromium periodically POSTs form-field
//   metadata to Google's autofill servers. An image editor has no forms
//   that benefit, and the requests are pure background traffic.
// OptimizationHints — Chrome's Optimization Guide service. Downloads ML
//   model + heuristic blobs from optimizationguide-pa.googleapis.com used
//   by features like Lite Mode and prefetch hints. None apply to a desktop
//   editor; disabling avoids the periodic background fetches.
// Translate — built-in page-translation UI; meaningless in an app shell.
// InterestFeedContentSuggestions / SafetyTip / PrivacySandboxSettings4 —
//   consumer-Chrome features (suggested-content feed, deceptive-site tip,
//   ad-topics settings) with no place in an Electron desktop app.
// SpareRendererForSitePerProcess — Chromium keeps a spare renderer process
//   warm for fast cross-origin navigation. Costs ~50–80 MB and we never
//   navigate between origins (the renderer is a single SPA).
// BackForwardCache — caches whole document trees so back/forward navigation
//   is instant. Useless for a single-SPA Electron app that never navigates;
//   disabling frees the cached-page memory and skips a freeze/restore path.
app.commandLine.appendSwitch(
  'disable-features',
  [
    'MediaRouter',
    'DialMediaRouteProvider',
    'CastMediaRouteProvider',
    'AutofillServerCommunication',
    'OptimizationHints',
    'Translate',
    'InterestFeedContentSuggestions',
    'SafetyTip',
    'PrivacySandboxSettings4',
    'SpareRendererForSitePerProcess',
    'BackForwardCache',
  ].join(','),
)

// WebGPU on Linux: Chromium still blocklists WebGPU for many Linux GPU /
// driver combinations and needs the Vulkan backend enabled explicitly.
// Without these the renderer can't create a device and the app is unusable
// (see useGpuDeviceRecovery / GpuDevice init error). Linux-only — Windows
// (D3D12) and macOS (Metal) work out of the box.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-unsafe-webgpu')
  app.commandLine.appendSwitch('enable-features', 'Vulkan')
}

import { registerIpcHandlers } from './ipc'
import { shutdownMlHost } from './ml/mlHost'
import { registerPreferencesHandlers } from './preferences'
import { registerColorProfileHandlers } from './colorProfiles'
import { buildAndSetMacMenu } from './menu'
import type { SerializedMenuNode } from './menu'

// ── Single instance ───────────────────────────────────────────────────────────
// Opening an associated file while Verve is running must not start a second
// copy (a second GPU process + WebGPU device, duplicate AI sessions, and two
// processes racing on the same userData JSON files). Hand the file to the
// running instance instead.
if (!app.requestSingleInstanceLock()) {
  // exit (not quit): nothing below — whenReady, createWindow — may run.
  app.exit(0)
} else {
  app.on('second-instance', (_event, argv) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    const file = detectStartupFileFromArgs(argv)
    if (file) win.webContents.send('app:open-file', file)
  })
}

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

function detectStartupFileFromArgs(argv: string[] = process.argv): string | null {
  // In dev:       argv = [electron, mainScript, ...userArgs]  → skip first 2
  // In packaged:  argv = [exe, ...userArgs]                   → skip first 1
  const args = argv.slice(app.isPackaged ? 1 : 2)
  for (const arg of args) {
    if (arg.startsWith('-')) continue
    try { if (existsSync(arg)) return arg } catch { /* skip invalid paths */ }
  }
  return null
}

/** Titles of documents with unsaved changes, pushed by the renderer. */
let unsavedDocuments: string[] = []
ipcMain.on('app:unsaved-documents', (_event, titles: unknown) => {
  unsavedDocuments = Array.isArray(titles)
    ? titles.filter((t): t is string => typeof t === 'string')
    : []
})

// GPU / utility process crashes. The renderer recovers from a lost GPU
// device on its own (see useGpuDeviceRecovery); log for diagnostics.
app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'clean-exit') return
  console.error(
    `[app] ${details.type} process gone: ${details.reason} (exit code ${details.exitCode})`
  )
})

/** http(s)/mailto links only — anything else is refused. */
function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

/** The renderer's own URL: the dev server in development, the bundled
 *  index.html otherwise. */
function isAppUrl(url: string): boolean {
  const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  if (devUrl) return url.startsWith(devUrl)
  try {
    const target = new URL(url)
    return (
      target.protocol === 'file:' &&
      decodeURIComponent(target.pathname).endsWith('/renderer/index.html')
    )
  } catch {
    return false
  }
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
      // The preload only uses contextBridge + ipcRenderer, so the renderer
      // can run fully sandboxed.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // WebSQL is a deprecated, removed-from-the-spec storage API. We don't
      // use it; disabling drops the SQLite binding from the renderer.
      enableWebSQL: false,
      // Verve renders exclusively through WebGPU (`src/graphics/webgpu/`).
      // Turning off WebGL drops ANGLE / GL initialisation from the renderer.
      webgl: false,
      // No long-form text inputs in the app — only short form fields (layer
      // names, numeric inputs, etc). Disabling skips spellchecker dictionary
      // downloads and keeps the renderer slimmer.
      spellcheck: false,
      // Pepper plugins (built-in PDF viewer, Flash). No <embed>/<object>/PDF
      // usage in the codebase — drops the plugin host from the renderer.
      plugins: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // ── Unsaved changes: ask before the window closes (X, File > Exit, Cmd+Q).
  let allowClose = false
  mainWindow.on('close', (event) => {
    if (allowClose || unsavedDocuments.length === 0) return
    const list = unsavedDocuments.slice(0, 10).map((t) => `• ${t}`).join('\n')
    const more = unsavedDocuments.length > 10 ? `\n…and ${unsavedDocuments.length - 10} more` : ''
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Quit Without Saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message:
        unsavedDocuments.length === 1
          ? 'This document has unsaved changes.'
          : `${unsavedDocuments.length} documents have unsaved changes.`,
      detail: `${list}${more}\n\nIf you quit now, these changes will be lost.`
    })
    if (choice === 0) {
      allowClose = true
    } else {
      // Also cancels an in-progress app.quit().
      event.preventDefault()
    }
  })

  // ── Renderer crash (e.g. out of memory on a huge document): without this
  // the user is left with a blank white window and no explanation.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    console.error(`[app] renderer gone: ${details.reason} (exit code ${details.exitCode})`)
    unsavedDocuments = []
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'error',
      buttons: ['Reload', 'Quit'],
      defaultId: 0,
      message: 'The editor stopped unexpectedly.',
      detail:
        `Reason: ${details.reason} (exit code ${details.exitCode}).\n` +
        'Unsaved changes could not be recovered. This usually means the ' +
        'system ran out of memory or the graphics driver failed.'
    })
    if (choice === 0) {
      mainWindow.reload()
    } else {
      allowClose = true
      app.quit()
    }
  })

  mainWindow.on('unresponsive', () => {
    void dialog
      .showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Keep Waiting', 'Reload'],
        defaultId: 0,
        cancelId: 0,
        message: 'Verve is not responding.',
        detail:
          'A long operation may still be running. Reloading discards unsaved changes.'
      })
      .then(({ response }) => {
        if (response === 1) mainWindow.webContents.forcefullyCrashRenderer()
      })
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Only real web links go to the OS. file://, ms-msdt:, search-ms:, UNC
    // paths etc. would otherwise be handed to shell.openExternal unchecked.
    if (isSafeExternalUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Never navigate the app window away from the app itself (a dropped file
  // or link would otherwise replace the editor with that page).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })

  // The editor needs no browser permissions (camera, mic, geolocation, …).
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  )

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
  registerPreferencesHandlers()
  registerColorProfileHandlers()

  // Detect startup file from CLI args (Windows / Linux); macOS uses open-file event above.
  if (!startupFilePath) startupFilePath = detectStartupFileFromArgs()

  // IPC: renderer polls for the startup file path exactly once on mount.
  ipcMain.handle('app:getStartupFile', () => {
    const p = startupFilePath
    startupFilePath = null   // clear after first read
    return p
  })

  // ── macOS native application menu ──────────────────────────────────
  // The renderer rebuilds and re-sends the full menu tree on every
  // relevant state change (color mode, animation mode, panel layout,
  // …). One IPC channel replaces the previous build/set-enabled/
  // set-checked/set-visible quartet — `Menu.buildFromTemplate` plus
  // `setApplicationMenu` round-trips in ~1 ms, well under any human-
  // perceptible threshold, and centralises the menu definitions in
  // `src/ux/main/menu/menuTree.ts`.
  if (process.platform === 'darwin') {
    ipcMain.on('menu:rebuild', (_event, tree: SerializedMenuNode[]) => {
      buildAndSetMacMenu(tree)
    })
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Stop the ML utility process with the app.
app.on('will-quit', () => {
  shutdownMlHost()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
