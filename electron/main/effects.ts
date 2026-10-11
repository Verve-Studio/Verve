import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './atomicWrite'
import { assertReadable, assertWritable } from './fileAccess'

/**
 * `.effect` files: node-graph shader effects saved from the shader editor.
 *
 * Effects are picked up from two folders and listed in the Effects menu:
 *  - the user folder `<userData>/effects` (writable; watched for changes);
 *  - the bundled folder `resources/effects` shipped with the app (read-only).
 * The file is JSON (`{ format: "verve-effect", formatVersion, graph }`);
 * the renderer validates the graph itself.
 */

const EXT = 'effect'
/** Larger files are skipped: effects are small JSON documents. */
const MAX_BYTES = 8 * 1024 * 1024

export type EffectSource = 'user' | 'bundled'

export interface EffectFileEntry {
  path: string
  source: EffectSource
  /** File contents (JSON text), or the reason it couldn't be read. */
  text?: string
  error?: string
}

export function userEffectsDir(): string {
  return join(app.getPath('userData'), 'effects')
}

function bundledEffectsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'effects')
    : join(app.getAppPath(), 'resources', 'effects')
}

async function listDir(dir: string, source: EffectSource): Promise<EffectFileEntry[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return [] // folder doesn't exist (yet)
  }
  const files = names.filter((n) => n.toLowerCase().endsWith(`.${EXT}`)).sort()
  return Promise.all(
    files.map(async (name): Promise<EffectFileEntry> => {
      const path = join(dir, name)
      try {
        const { size } = await stat(path)
        if (size > MAX_BYTES) return { path, source, error: 'File is too large' }
        return { path, source, text: await readFile(path, 'utf-8') }
      } catch (err) {
        return { path, source, error: err instanceof Error ? err.message : String(err) }
      }
    })
  )
}

/** Notify every window (debounced) when the user folder changes. */
function watchUserDir(): void {
  let watcher: FSWatcher | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const notify = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('effects:changed')
    }, 250)
  }
  void mkdir(userEffectsDir(), { recursive: true })
    .then(() => {
      watcher = watch(userEffectsDir(), notify)
      watcher.on('error', () => watcher?.close())
    })
    .catch(() => {
      /* no watcher: the menu still refreshes after saves */
    })
  app.on('will-quit', () => watcher?.close())
}

export function registerEffectHandlers(): void {
  ipcMain.handle('effects:list', async (): Promise<EffectFileEntry[]> => [
    ...(await listDir(bundledEffectsDir(), 'bundled')),
    ...(await listDir(userEffectsDir(), 'user'))
  ])

  /** Save dialog (defaulting to the user effects folder), then write. */
  ipcMain.handle('effects:save', async (event, text: unknown, suggestedName: unknown) => {
    if (typeof text !== 'string') throw new Error('Invalid effect data')
    const safe =
      (typeof suggestedName === 'string' ? suggestedName : '')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
        .trim() || 'Effect'
    await mkdir(userEffectsDir(), { recursive: true })
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Save Effect',
      defaultPath: join(userEffectsDir(), `${safe}.${EXT}`),
      filters: [{ name: 'Verve Effect', extensions: [EXT] }]
    }
    const { canceled, filePath } = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (canceled || !filePath) return null
    await writeFileAtomic(assertWritable(filePath, [EXT]), text, 'utf-8')
    return filePath
  })

  /** Open dialog for an `.effect` file; resolves to its path and text. */
  ipcMain.handle('effects:openFile', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Open Effect',
      defaultPath: userEffectsDir(),
      properties: ['openFile' as const],
      filters: [{ name: 'Verve Effect', extensions: [EXT] }]
    }
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (canceled || !filePaths[0]) return null
    const path = assertReadable(filePaths[0], [EXT])
    const { size } = await stat(path)
    if (size > MAX_BYTES) throw new Error('File is too large')
    return { path, text: await readFile(path, 'utf-8') }
  })

  /** Overwrite an `.effect` file (Save on an effect opened from disk). */
  ipcMain.handle('effects:write', async (_event, path: unknown, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Invalid effect data')
    await writeFileAtomic(assertWritable(path, [EXT]), text, 'utf-8')
  })

  ipcMain.handle('effects:openFolder', async () => {
    await mkdir(userEffectsDir(), { recursive: true })
    const error = await shell.openPath(userEffectsDir())
    if (error) throw new Error(error)
  })

  ipcMain.handle('effects:folder', () => userEffectsDir())

  watchUserDir()
}
