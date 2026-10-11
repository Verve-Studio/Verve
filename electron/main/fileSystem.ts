import { ipcMain } from 'electron'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Folder listing / stat / mkdir for automation workflows (batch processing
 * a folder of images, writing results into an output folder).
 *
 * These expose file *metadata* only (names, sizes, dates) — reading and
 * writing contents still goes through the extension-checked handlers in
 * ipc.ts / fileAccess.ts. Paths must be absolute. Everything is async so a
 * large recursive listing never blocks the main process.
 */

export interface FsEntry {
  path: string
  name: string
  isDirectory: boolean
  size: number
  /** Last modification time, ms since the epoch. */
  modified: number
}

export interface FsListOptions {
  recursive?: boolean
  /** Include files (default true). */
  files?: boolean
  /** Include folders (default false). */
  folders?: boolean
}

export interface FsStat {
  exists: boolean
  isDirectory: boolean
  isFile: boolean
  size: number
  modified: number
  created: number
}

/** Guard against runaway recursive listings (e.g. a drive root). */
const MAX_ENTRIES = 200_000

function checkPath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0) throw new Error('Invalid path')
  if (!isAbsolute(path)) throw new Error(`"${path}" is not an absolute path`)
  return resolve(path)
}

async function list(root: string, options: FsListOptions): Promise<FsEntry[]> {
  const wantFiles = options.files !== false
  const wantFolders = options.folders === true
  const out: FsEntry[] = []
  const pending = [root]
  while (pending.length > 0) {
    const dir = pending.shift()!
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      // The root must be readable; unreadable subfolders are skipped.
      if (dir === root) throw err
      continue
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    for (const d of dirents) {
      // Symlinks and other special entries are skipped (no cycles).
      const isDirectory = d.isDirectory()
      if (!isDirectory && !d.isFile()) continue
      const path = join(dir, d.name)
      if (isDirectory && options.recursive) pending.push(path)
      if (isDirectory ? !wantFolders : !wantFiles) continue
      let size = 0
      let modified = 0
      try {
        const s = await stat(path)
        size = s.size
        modified = s.mtimeMs
      } catch {
        continue
      }
      out.push({ path, name: d.name, isDirectory, size, modified })
      if (out.length >= MAX_ENTRIES) {
        throw new Error(`More than ${MAX_ENTRIES} entries under "${root}"; pick a smaller folder`)
      }
    }
  }
  return out
}

export function registerFileSystemHandlers(): void {
  ipcMain.handle('fs:list', (_e, path: unknown, options: FsListOptions = {}) =>
    list(checkPath(path), options ?? {})
  )

  ipcMain.handle('fs:stat', async (_e, path: unknown): Promise<FsStat> => {
    const full = checkPath(path)
    try {
      const s = await stat(full)
      return {
        exists: true,
        isDirectory: s.isDirectory(),
        isFile: s.isFile(),
        size: s.size,
        modified: s.mtimeMs,
        created: s.birthtimeMs
      }
    } catch {
      return { exists: false, isDirectory: false, isFile: false, size: 0, modified: 0, created: 0 }
    }
  })

  ipcMain.handle('fs:mkdir', async (_e, path: unknown): Promise<void> => {
    await mkdir(checkPath(path), { recursive: true })
  })
}
