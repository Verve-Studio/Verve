import { execSync, spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
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

// ── Windows ───────────────────────────────────────────────────────────────────

const WIN_PROG_PREFIX = 'VerveApp'

function winProgId(ext: string): string {
  return `${WIN_PROG_PREFIX}.${ext.toUpperCase()}`
}

function runReg(cmd: string): boolean {
  try {
    execSync(cmd, { encoding: 'utf-8', timeout: 3000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

function getRegisteredWindows(): string[] {
  const registered: string[] = []
  for (const { ext } of SUPPORTED_FILE_TYPES) {
    try {
      const result = execSync(
        `reg query "HKCU\\Software\\Classes\\.${ext}" /ve`,
        { encoding: 'utf-8', timeout: 2000, windowsHide: true }
      )
      if (result.includes(winProgId(ext))) registered.push(ext)
    } catch { /* not registered */ }
  }
  return registered
}

function applyWindows(exts: string[], exePath: string): void {
  const toRegister = new Set(exts)
  const current = new Set(getRegisteredWindows())

  // Remove types no longer wanted
  for (const ext of current) {
    if (!toRegister.has(ext)) {
      runReg(`reg delete "HKCU\\Software\\Classes\\.${ext}" /f`)
    }
  }

  // Register/update wanted types
  const exe = exePath.replace(/\\/g, '\\\\')
  for (const ext of exts) {
    const progId = winProgId(ext)
    const label = SUPPORTED_FILE_TYPES.find(t => t.ext === ext)?.label ?? `${ext.toUpperCase()} File`
    runReg(`reg add "HKCU\\Software\\Classes\\${progId}" /ve /d "${label}" /f`)
    runReg(`reg add "HKCU\\Software\\Classes\\${progId}\\DefaultIcon" /ve /d "${exe},0" /f`)
    runReg(`reg add "HKCU\\Software\\Classes\\${progId}\\shell\\open\\command" /ve /d "\\"${exe}\\" \\"%1\\"" /f`)
    runReg(`reg add "HKCU\\Software\\Classes\\.${ext}" /ve /d "${progId}" /f`)
  }

  // Notify the shell of association changes via the proper Win32 SHChangeNotify API.
  // Uses PowerShell P/Invoke — no dependency on legacy IE executables.
  const sysRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
  const ps = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  try {
    spawnSync(ps, [
      '-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -TypeDefinition \'using System.Runtime.InteropServices;' +
      ' public class ShellNotify {' +
      ' [DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, int f, System.IntPtr a, System.IntPtr b);' +
      ' }\';' +
      ' [ShellNotify]::SHChangeNotify(0x8000000, 0, [System.IntPtr]::Zero, [System.IntPtr]::Zero)',
    ], { timeout: 6000 })
  } catch { /* not critical — registry changes take effect regardless */ }
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
  const appIdx = parts.findIndex(p => p.endsWith('.app'))
  return appIdx !== -1
    ? parts.slice(0, appIdx + 1).join('/')
    : app.getPath('exe')
}

function getRegisteredMacOS(): string[] {
  // Check whether our bundle is known to Launch Services at all.
  // If lsregister -dump mentions our bundle path, report all declared types
  // as registered (we can't query per-extension without duti or Swift code).
  try {
    const bundlePath = getAppBundlePath()
    const result = spawnSync(LSREGISTER, ['-dump'], { timeout: 5000, encoding: 'utf-8' })
    if (result.stdout && result.stdout.includes(bundlePath)) {
      return SUPPORTED_FILE_TYPES.map(t => t.ext)
    }
  } catch { /* lsregister unavailable (shouldn't happen on macOS) */ }
  return []
}

function applyMacOS(): void {
  // Re-register the app bundle with Launch Services so Verve appears in every
  // "Open With" menu for all types declared in its Info.plist. No third-party
  // tools required.
  const bundlePath = getAppBundlePath()
  const result = spawnSync(LSREGISTER, ['-f', bundlePath], { timeout: 5000 })
  if (result.error) throw result.error
}

// ── Linux ─────────────────────────────────────────────────────────────────────

function getRegisteredLinux(): string[] {
  const registered: string[] = []
  for (const { ext } of SUPPORTED_FILE_TYPES) {
    const mime = MIME_MAP[ext]
    if (!mime) continue
    try {
      const result = execSync(`xdg-mime query default ${mime}`, {
        timeout: 2000, encoding: 'utf-8',
      }).trim().toLowerCase()
      if (result.includes('verve')) registered.push(ext)
    } catch { /* not registered */ }
  }
  return registered
}

function applyLinux(exts: string[], exePath: string): void {
  const mimeTypes = [...new Set(
    exts.map(ext => MIME_MAP[ext]).filter((m): m is string => !!m)
  )]

  const desktopDir = join(os.homedir(), '.local', 'share', 'applications')
  const desktopPath = join(desktopDir, 'verve.desktop')
  mkdirSync(desktopDir, { recursive: true })

  const content = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Verve',
    'Comment=Image Editor',
    `Exec=${exePath} %f`,
    'Icon=verve',
    `MimeType=${mimeTypes.join(';')};`,
    'Categories=Graphics;2DGraphics;RasterGraphics;',
  ].join('\n')

  writeFileSync(desktopPath, content, 'utf-8')

  try {
    execSync(`xdg-mime default verve.desktop ${mimeTypes.join(' ')}`, { timeout: 5000, encoding: 'utf-8' })
    execSync('update-desktop-database ~/.local/share/applications 2>/dev/null || true', { timeout: 3000, encoding: 'utf-8' })
  } catch { /* best-effort */ }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getRegisteredExtensions(): string[] {
  if (process.platform === 'win32') return getRegisteredWindows()
  if (process.platform === 'darwin') return getRegisteredMacOS()
  return getRegisteredLinux()
}

export function applyExtensions(exts: string[]): void {
  const exePath = process.execPath
  if (process.platform === 'win32') applyWindows(exts, exePath)
  else if (process.platform === 'darwin') applyMacOS()
  else applyLinux(exts, exePath)
}
