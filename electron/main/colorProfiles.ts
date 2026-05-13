import { app, ipcMain, dialog } from 'electron'
import { readdir, readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'

// ─── Color profile catalog (Tier 3d) ─────────────────────────────────────────
//
// Scans the OS for ICC profiles in well-known directories and presents a
// merged listing to the renderer: system profiles (read-only) + user-
// imported profiles living in `userData/color-profiles/` (managed by Verve).
//
// The renderer-side `ProfileManagerDialog` uses this to populate the
// profile-picker UI; nothing else in Verve depends on it (the existing
// Set/Assign/Convert flows still use the raw OS file dialog, which works
// fine for one-off picks).

export interface CatalogEntry {
  /** Stable id for this entry. System profiles: `sys:<basename>`. User
   *  profiles: `usr:<basename>`. The renderer uses this id to fetch
   *  bytes via `cms:readProfileBytes`. */
  id: string
  /** Filename without directory. */
  filename: string
  /** Absolute path. Not exposed to the renderer beyond loading the bytes;
   *  the dialog should display `filename` instead. */
  path: string
  /** "system" = OS-installed, read-only. "user" = imported into Verve's
   *  userData and deletable. */
  source: 'system' | 'user'
  /** Byte size — handy for the manager UI without forcing a read of every
   *  profile up front. */
  size: number
}

// ─── OS profile directories ──────────────────────────────────────────────────

function systemProfileDirs(): string[] {
  switch (process.platform) {
    case 'win32':
      return [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'spool', 'drivers', 'color')]
    case 'darwin':
      return [
        '/Library/ColorSync/Profiles',
        '/System/Library/ColorSync/Profiles',
        join(app.getPath('home'), 'Library', 'ColorSync', 'Profiles'),
      ]
    default:
      // Linux / BSD: ICC color directory conventions vary by distro.
      // These two cover essentially every install I've seen.
      return [
        '/usr/share/color/icc',
        join(app.getPath('home'), '.color', 'icc'),
      ]
  }
}

function userProfileDir(): string {
  return join(app.getPath('userData'), 'color-profiles')
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function listIccFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries.filter((e) => {
      const ext = extname(e).toLowerCase()
      return ext === '.icc' || ext === '.icm'
    })
  } catch {
    // Missing directory / permission denied — treat as empty, don't crash.
    return []
  }
}

async function fileSize(p: string): Promise<number> {
  try {
    const s = await stat(p)
    return s.size
  } catch {
    return 0
  }
}

async function ensureUserDir(): Promise<string> {
  const d = userProfileDir()
  await mkdir(d, { recursive: true })
  return d
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

export function registerColorProfileHandlers(): void {
  ipcMain.handle('cms:listProfiles', async (): Promise<CatalogEntry[]> => {
    const out: CatalogEntry[] = []

    // User-imported profiles first so the dialog can show "Yours" above
    // the long system list.
    const userDir = await ensureUserDir().catch(() => userProfileDir())
    const userFiles = await listIccFiles(userDir)
    for (const f of userFiles) {
      const path = join(userDir, f)
      out.push({
        id: `usr:${f}`,
        filename: f,
        path,
        source: 'user',
        size: await fileSize(path),
      })
    }

    // System profiles. Dedupe by filename (multiple system dirs may shadow
    // each other — first hit wins).
    const seen = new Set<string>()
    for (const dir of systemProfileDirs()) {
      const files = await listIccFiles(dir)
      for (const f of files) {
        if (seen.has(f)) continue
        seen.add(f)
        const path = join(dir, f)
        out.push({
          id: `sys:${f}`,
          filename: f,
          path,
          source: 'system',
          size: await fileSize(path),
        })
      }
    }

    return out
  })

  ipcMain.handle('cms:readProfileBytes', async (
    _event,
    id: string,
  ): Promise<string | null> => {
    // Re-resolve the entry from the filesystem each call rather than
    // caching the catalog in module state — keeps imports/deletes between
    // catalog refreshes from serving stale paths. Returns base64 to keep
    // the IPC boundary symmetrical with `readFileBase64`.
    const userDir = userProfileDir()
    if (id.startsWith('usr:')) {
      const path = join(userDir, id.slice(4))
      try {
        const buf = await readFile(path)
        return buf.toString('base64')
      } catch {
        return null
      }
    }
    if (id.startsWith('sys:')) {
      const name = id.slice(4)
      for (const dir of systemProfileDirs()) {
        const path = join(dir, name)
        try {
          const buf = await readFile(path)
          return buf.toString('base64')
        } catch {
          // try next dir
        }
      }
    }
    return null
  })

  ipcMain.handle('cms:importProfileDialog', async (): Promise<CatalogEntry | null> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import ICC Profile',
      properties: ['openFile'],
      filters: [
        { name: 'ICC Profile', extensions: ['icc', 'icm'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (canceled || filePaths.length === 0) return null
    const src = filePaths[0]
    const filename = basename(src)
    const userDir = await ensureUserDir()
    const dst = join(userDir, filename)
    const bytes = await readFile(src)
    await writeFile(dst, bytes)
    return {
      id: `usr:${filename}`,
      filename,
      path: dst,
      source: 'user',
      size: bytes.length,
    }
  })

  ipcMain.handle('cms:deleteUserProfile', async (
    _event,
    id: string,
  ): Promise<boolean> => {
    if (!id.startsWith('usr:')) return false
    const filename = id.slice(4)
    const userDir = userProfileDir()
    try {
      await unlink(join(userDir, filename))
      return true
    } catch {
      return false
    }
  })
}
