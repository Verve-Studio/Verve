import { ipcMain, shell } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from './atomicWrite'

/**
 * Cell animation folders: every frame is its own file (`.verve` / `.exr`)
 * in one folder, plus a manifest (`verve-cells.json`) that records frame
 * order, durations and playback settings, and a `.verve-previews` subfolder
 * of flattened PNG previews (onion skin / playback).
 *
 * Frame files themselves are read and written through the regular
 * extension-checked handlers (`file:openverve`, `file:read`, the streamed
 * `.verve` save, `file:exportImage`). These handlers cover what those don't:
 * the manifest (JSON under a fixed name) and moving frame files to the trash.
 */

export const CELL_MANIFEST_NAME = 'verve-cells.json'
const PREVIEW_DIR = '.verve-previews'
/** The manifest is a small JSON document. */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
/** Frame files (and their previews) the trash handler may move. */
const TRASHABLE = ['verve', 'exr', 'png']

function checkFolder(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0) throw new Error('Invalid folder path')
  if (!isAbsolute(path)) throw new Error(`"${path}" is not an absolute path`)
  return resolve(path)
}

export function registerCellAnimationHandlers(): void {
  /** The folder's manifest text, or null when it has none. */
  ipcMain.handle('cells:readManifest', async (_e, folder: unknown): Promise<string | null> => {
    const path = join(checkFolder(folder), CELL_MANIFEST_NAME)
    let size: number
    try {
      size = (await stat(path)).size
    } catch {
      return null
    }
    if (size > MAX_MANIFEST_BYTES) throw new Error(`${CELL_MANIFEST_NAME} is too large`)
    return readFile(path, 'utf-8')
  })

  ipcMain.handle('cells:writeManifest', async (_e, folder: unknown, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Invalid manifest')
    await writeFileAtomic(join(checkFolder(folder), CELL_MANIFEST_NAME), text, 'utf-8')
  })

  /** Move a frame file (or a frame preview) to the OS trash. Only files
   *  directly inside a cell folder or its preview folder qualify. */
  ipcMain.handle('cells:trash', async (_e, path: unknown) => {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Invalid file path')
    const full = resolve(path)
    const ext = extname(full).slice(1).toLowerCase()
    if (!TRASHABLE.includes(ext)) {
      throw new Error(`Refusing to delete "${full}": not a cell frame`)
    }
    if (ext === 'png' && basename(dirname(full)) !== PREVIEW_DIR) {
      throw new Error(`Refusing to delete "${full}": not a frame preview`)
    }
    try {
      await stat(full)
    } catch {
      return // Already gone.
    }
    await shell.trashItem(full)
  })
}
