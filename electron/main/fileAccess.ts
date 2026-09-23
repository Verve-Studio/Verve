import { extname, resolve } from 'node:path'

/**
 * Guards for the file IPC handlers, which take paths straight from the
 * renderer. Without them a compromised renderer (e.g. a crafted PSD or SVG
 * exploiting a decoder bug) could read any file the user can (SSH keys,
 * browser profiles) or write anywhere (e.g. a script into the Startup
 * folder).
 *
 * The rules are by file type rather than a strict "only paths from a
 * dialog" allowlist, because legitimate paths also come from drag & drop,
 * recent files, linked-layer sources and remembered export locations:
 *  - writes must have an extension the handler legitimately produces;
 *  - reads must have a supported extension, or be a file the user picked
 *    in an open dialog during this session (covers "All Files" picks).
 */

export const IMAGE_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp', 'tga', 'pcx', 'tif',
  'tiff', 'exr', 'hdr', 'dds', 'psd', 'ico', 'svg'
] as const

/** Formats the exporters write (images + PDF). */
export const EXPORT_EXTENSIONS = [...IMAGE_EXTENSIONS, 'pdf'] as const

const pickedPaths = new Set<string>()

function key(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

function extensionOf(path: string): string {
  return extname(path).slice(1).toLowerCase()
}

/** Remember paths the user chose in an open dialog. */
export function grantPicked(paths: string | readonly string[] | null | undefined): void {
  if (!paths) return
  for (const p of typeof paths === 'string' ? [paths] : paths) pickedPaths.add(key(p))
}

export function assertReadable(path: unknown, allowed: readonly string[]): string {
  if (typeof path !== 'string' || path.length === 0) throw new Error('Invalid file path')
  if (pickedPaths.has(key(path)) || allowed.includes(extensionOf(path))) return path
  throw new Error(`Refusing to read "${path}": unsupported file type`)
}

export function assertWritable(path: unknown, allowed: readonly string[]): string {
  if (typeof path !== 'string' || path.length === 0) throw new Error('Invalid file path')
  if (allowed.includes(extensionOf(path))) return path
  throw new Error(
    `Refusing to write "${path}": expected a .${allowed.join(' / .')} file`
  )
}
