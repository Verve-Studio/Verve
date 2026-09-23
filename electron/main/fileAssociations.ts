import { execFile, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import os from 'node:os'
import { app } from 'electron'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FileTypeEntry {
  ext: string
  label: string
}

// ─── Supported file types ─────────────────────────────────────────────────────

export const SUPPORTED_FILE_TYPES: FileTypeEntry[] = [
  { ext: 'verve', label: 'Verve Document (.verve)' },
  { ext: 'png',   label: 'PNG Image (.png)' },
  { ext: 'jpg',   label: 'JPEG Image (.jpg)' },
  { ext: 'jpeg',  label: 'JPEG Image (.jpeg)' },
  { ext: 'webp',  label: 'WebP Image (.webp)' },
  { ext: 'gif',   label: 'GIF Image (.gif)' },
  { ext: 'bmp',   label: 'BMP Image (.bmp)' },
  { ext: 'tga',   label: 'TGA Image (.tga)' },
  { ext: 'tif',   label: 'TIFF Image (.tif)' },
  { ext: 'tiff',  label: 'TIFF Image (.tiff)' },
  { ext: 'exr',   label: 'OpenEXR Image (.exr)' },
  { ext: 'hdr',   label: 'Radiance HDR Image (.hdr)' },
]

const MIME_MAP: Record<string, string> = {
  verve: 'application/x-verve',
  png:   'image/png',
  jpg:   'image/jpeg',
  jpeg:  'image/jpeg',
  webp:  'image/webp',
  gif:   'image/gif',
  bmp:   'image/bmp',
  tga:   'image/x-tga',
  tif:   'image/tiff',
  tiff:  'image/tiff',
  exr:   'image/x-exr',
  hdr:   'image/vnd.radiance',
}

// Everything below runs child processes asynchronously. The previous
// execSync/spawnSync version ran ~16 sequential `reg query` calls on open
// and ~64 `reg add/delete` calls plus a PowerShell cold start on apply, all
// on the main thread: the whole app froze for 1–10 s whenever Preferences
// opened or was applied.

const execFileAsync = promisify(execFile)

async function run(
  file: string,
  args: string[],
  timeout: number
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      encoding: 'utf-8',
      timeout,
      windowsHide: true
    })
    return stdout
  } catch {
    return null
  }
}

// ── Windows ───────────────────────────────────────────────────────────────────

const WIN_PROG_PREFIX = 'VerveApp'

function winProgId(ext: string): string {
  return `${WIN_PROG_PREFIX}.${ext.toUpperCase()}`
}

/** `reg` with an argument array (no shell parsing / quoting). */
function reg(args: string[]): Promise<string | null> {
  return run('reg', args, 5000)
}

async function getRegisteredWindows(): Promise<string[]> {
  const results = await Promise.all(
    SUPPORTED_FILE_TYPES.map(async ({ ext }) => {
      const out = await reg(['query', `HKCU\\Software\\Classes\\.${ext}`, '/ve'])
      return out !== null && out.includes(winProgId(ext)) ? ext : null
    })
  )
  return results.filter((e): e is string => e !== null)
}

async function applyWindows(exts: string[], exePath: string): Promise<void> {
  const toRegister = new Set(exts)
  const current = await getRegisteredWindows()

  // Remove types no longer wanted
  await Promise.all(
    current
      .filter((ext) => !toRegister.has(ext))
      .map((ext) => reg(['delete', `HKCU\\Software\\Classes\\.${ext}`, '/f']))
  )

  // Register/update wanted types (extensions in parallel; each extension's
  // keys in order so the ProgID exists before the extension points at it).
  await Promise.all(
    exts.map(async (ext) => {
      const progId = winProgId(ext)
      const label =
        SUPPORTED_FILE_TYPES.find((t) => t.ext === ext)?.label ?? `${ext.toUpperCase()} File`
      const base = `HKCU\\Software\\Classes\\${progId}`
      await reg(['add', base, '/ve', '/d', label, '/f'])
      await reg(['add', `${base}\\DefaultIcon`, '/ve', '/d', `${exePath},0`, '/f'])
      await reg(['add', `${base}\\shell\\open\\command`, '/ve', '/d', `"${exePath}" "%1"`, '/f'])
      await reg(['add', `HKCU\\Software\\Classes\\.${ext}`, '/ve', '/d', progId, '/f'])
    })
  )

  // Notify the shell of association changes via the proper Win32 SHChangeNotify API.
  // Uses PowerShell P/Invoke — no dependency on legacy IE executables.
  const sysRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
  const ps = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  // Not critical — registry changes take effect regardless.
  await run(
    ps,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Add-Type -TypeDefinition 'using System.Runtime.InteropServices;" +
        ' public class ShellNotify {' +
        ' [DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, int f, System.IntPtr a, System.IntPtr b);' +
        " }';" +
        ' [ShellNotify]::SHChangeNotify(0x8000000, 0, [System.IntPtr]::Zero, [System.IntPtr]::Zero)'
    ],
    10000
  )
}

// ── macOS ─────────────────────────────────────────────────────────────────────
//
// macOS uses a declaration-based model: the app's Info.plist declares which
// UTIs / extensions it handles via CFBundleDocumentTypes. The OS then lists
// Verve in every "Open With" menu for those types automatically.
//
// Programmatically forcing Verve to be the *default* handler is intentionally
// not supported here — that would require either a deprecated private API or a
// third-party tool. Instead we call `lsregister` to ensure the bundle is fully
// registered with Launch Services so it appears in "Open With". The user can
// then set it as the default via Finder > Get Info > Open With > Change All —
// the standard macOS flow.

// Absolute path to lsregister — stable across all modern macOS versions.
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework' +
  '/Versions/A/Frameworks/LaunchServices.framework' +
  '/Versions/A/Support/lsregister'

function getAppBundlePath(): string {
  // process.execPath is e.g. /Applications/Verve.app/Contents/MacOS/Verve
  // Walk up to find the .app bundle root.
  const parts = process.execPath.split('/')
  const appIdx = parts.findIndex((p) => p.endsWith('.app'))
  return appIdx !== -1 ? parts.slice(0, appIdx + 1).join('/') : app.getPath('exe')
}

/**
 * Whether `lsregister -dump` mentions our bundle. The dump is many MB —
 * far beyond spawnSync's default 1 MB maxBuffer, so the old check always
 * failed. Stream it and stop as soon as the path shows up.
 */
function lsregisterKnowsBundle(bundlePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(LSREGISTER, ['-dump'])
    let tail = ''
    let done = false
    const finish = (found: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill()
      resolve(found)
    }
    const timer = setTimeout(() => finish(false), 15000)
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      const text = tail + chunk
      if (text.includes(bundlePath)) finish(true)
      // Keep enough overlap to match a path split across chunks.
      tail = text.slice(-bundlePath.length)
    })
    child.on('error', () => finish(false))
    child.on('close', () => finish(false))
  })
}

async function getRegisteredMacOS(): Promise<string[]> {
  // If Launch Services knows our bundle, report all declared types as
  // registered (we can't query per-extension without duti or Swift code).
  return (await lsregisterKnowsBundle(getAppBundlePath()))
    ? SUPPORTED_FILE_TYPES.map((t) => t.ext)
    : []
}

async function applyMacOS(): Promise<void> {
  // Re-register the app bundle with Launch Services so Verve appears in every
  // "Open With" menu for all types declared in its Info.plist. No third-party
  // tools required.
  await execFileAsync(LSREGISTER, ['-f', getAppBundlePath()], { timeout: 10000 })
}

// ── Linux ─────────────────────────────────────────────────────────────────────

async function getRegisteredLinux(): Promise<string[]> {
  const results = await Promise.all(
    SUPPORTED_FILE_TYPES.map(async ({ ext }) => {
      const mime = MIME_MAP[ext]
      if (!mime) return null
      const out = await run('xdg-mime', ['query', 'default', mime], 5000)
      return out !== null && out.trim().toLowerCase().includes('verve') ? ext : null
    })
  )
  return results.filter((e): e is string => e !== null)
}

async function applyLinux(exts: string[], exePath: string): Promise<void> {
  const mimeTypes = [
    ...new Set(exts.map((ext) => MIME_MAP[ext]).filter((m): m is string => !!m))
  ]

  const desktopDir = join(os.homedir(), '.local', 'share', 'applications')
  const desktopPath = join(desktopDir, 'verve.desktop')
  await mkdir(desktopDir, { recursive: true })

  const content = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Verve',
    'Comment=Image Editor',
    `Exec=${exePath} %f`,
    'Icon=verve',
    `MimeType=${mimeTypes.join(';')};`,
    'Categories=Graphics;2DGraphics;RasterGraphics;'
  ].join('\n')

  await writeFile(desktopPath, content, 'utf-8')

  // Best-effort.
  if (mimeTypes.length > 0) {
    await run('xdg-mime', ['default', 'verve.desktop', ...mimeTypes], 10000)
  }
  await run('update-desktop-database', [desktopDir], 10000)
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getRegisteredExtensions(): Promise<string[]> {
  if (process.platform === 'win32') return getRegisteredWindows()
  if (process.platform === 'darwin') return getRegisteredMacOS()
  return getRegisteredLinux()
}

export async function applyExtensions(exts: string[]): Promise<void> {
  const exePath = process.execPath
  if (process.platform === 'win32') await applyWindows(exts, exePath)
  else if (process.platform === 'darwin') await applyMacOS()
  else await applyLinux(exts, exePath)
}
