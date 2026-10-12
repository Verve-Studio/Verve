import { app } from 'electron'
import { resolve } from 'path'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { is } from '@electron-toolkit/utils'

/**
 * Pure helpers used by `index.ts` (window guards, startup file detection).
 * They live here so they can be unit-tested without importing `index.ts`,
 * which boots the app at module load.
 */

export function detectStartupFileFromArgs(argv: string[] = process.argv): string | null {
  // argv[0] is the executable. Don't skip by position beyond that: in dev the
  // app path (`electron .`) is in there too, and `second-instance` argv has
  // Chromium's switches reordered and extra ones inserted. Instead skip the
  // app path explicitly and accept only regular files.
  const appPath = resolve(app.getAppPath())
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    try {
      if (resolve(arg) === appPath) continue
      if (statSync(arg).isFile()) return arg
    } catch { /* skip missing / invalid paths */ }
  }
  return null
}

/** http(s)/mailto links only — anything else is refused. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

/** The renderer's own URL: the dev server in development (same origin, path
 *  under the dev URL's path), otherwise exactly `rendererIndexPath` — the
 *  bundled index.html the window loads — as a local file:// URL (empty host).
 *  Query and hash are ignored. */
export function isAppUrl(url: string, rendererIndexPath: string): boolean {
  const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  try {
    const target = new URL(url)
    if (devUrl) {
      const dev = new URL(devUrl)
      if (target.origin === 'null' || target.origin !== dev.origin) return false
      const base = dev.pathname.endsWith('/') ? dev.pathname : `${dev.pathname}/`
      return target.pathname === dev.pathname || target.pathname.startsWith(base)
    }
    if (target.protocol !== 'file:' || target.host !== '') return false
    return samePath(fileURLToPath(target), rendererIndexPath)
  } catch {
    return false
  }
}

function samePath(a: string, b: string): boolean {
  const ra = resolve(a)
  const rb = resolve(b)
  // Windows file systems are case-insensitive.
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
}
