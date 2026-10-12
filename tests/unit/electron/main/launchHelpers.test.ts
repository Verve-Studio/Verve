import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => import('@tests/fakes/electronMain').then((m) => m.electronModule))
vi.mock('@electron-toolkit/utils', () =>
  import('@tests/fakes/electronMain').then((m) => m.toolkitUtilsModule)
)

import { disposeFakeElectron, fakeElectron, resetFakeElectron } from '@tests/fakes/electronMain'
import { detectStartupFileFromArgs, isAppUrl, isSafeExternalUrl } from '../../../../electron/main/launchHelpers'

beforeEach(() => {
  resetFakeElectron()
})
afterEach(() => {
  vi.unstubAllEnvs()
})
afterAll(disposeFakeElectron)

describe('isSafeExternalUrl', () => {
  it.each([
    'https://example.com/docs',
    'http://example.com',
    'HTTPS://EXAMPLE.COM',
    'mailto:support@example.com'
  ])('allows %s', (url) => {
    expect(isSafeExternalUrl(url)).toBe(true)
  })

  it.each([
    'file:///C:/Windows/System32/calc.exe',
    'file://server/share/payload.exe',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ms-msdt:/id PCWDiagnostic /skip force',
    'search-ms:query=x&crumb=location:\\\\evil\\share',
    'ms-settings:privacy',
    'vbscript:msgbox(1)',
    'smb://server/share',
    '\\\\server\\share\\payload.exe',
    '//server/share',
    'C:\\Windows\\System32\\calc.exe',
    '/etc/passwd',
    'example.com',
    '',
    '   '
  ])('refuses %s', (url) => {
    expect(isSafeExternalUrl(url)).toBe(false)
  })

  it('ignores leading whitespace tricks the URL parser strips', () => {
    // The parser trims C0 control/space; the protocol is still checked.
    expect(isSafeExternalUrl(' javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('\tfile:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl(' https://example.com')).toBe(true)
  })
})

describe('isAppUrl (packaged build)', () => {
  let bundled: string
  beforeEach(() => {
    fakeElectron.isPackaged = true
    bundled = join(fakeElectron.root, 'resources', 'app.asar', 'out', 'renderer', 'index.html')
  })

  it('accepts the bundled renderer index.html', () => {
    expect(isAppUrl(pathToFileURL(bundled).href, bundled)).toBe(true)
  })

  it('accepts the bundled page with a query or hash', () => {
    const page = join(fakeElectron.root, 'out', 'renderer', 'index.html')
    const href = pathToFileURL(page).href
    expect(isAppUrl(`${href}#/doc`, page)).toBe(true)
    expect(isAppUrl(`${href}?a=1`, page)).toBe(true)
  })

  it.each([
    'https://example.com/renderer/index.html',
    'http://localhost:5173/',
    'file:///C:/Users/me/Downloads/page.html',
    'file:///C:/out/renderer/index.html.evil',
    'about:blank',
    'javascript:alert(1)',
    'not a url'
  ])('refuses %s', (url) => {
    expect(isAppUrl(url, bundled)).toBe(false)
  })

  it('ignores ELECTRON_RENDERER_URL outside development', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'https://evil.example')
    expect(isAppUrl('https://evil.example/', bundled)).toBe(false)
  })

  it('refuses a renderer/index.html that is not the bundled one', () => {
    expect(isAppUrl('file:///C:/Users/me/Downloads/renderer/index.html', bundled)).toBe(false)
    expect(isAppUrl('file://evil-host/share/renderer/index.html', bundled)).toBe(false)
    // Same path on another host (UNC) is not the local bundle either.
    const remote = pathToFileURL(bundled)
    remote.host = 'evil-host'
    expect(isAppUrl(remote.href, bundled)).toBe(false)
  })
})

describe('isAppUrl (development)', () => {
  const bundled = join('out', 'renderer', 'index.html')
  beforeEach(() => {
    fakeElectron.isPackaged = false
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
  })

  it('accepts dev-server URLs', () => {
    expect(isAppUrl('http://localhost:5173', bundled)).toBe(true)
    expect(isAppUrl('http://localhost:5173/', bundled)).toBe(true)
    expect(isAppUrl('http://localhost:5173/index.html#x', bundled)).toBe(true)
  })

  it('refuses other origins', () => {
    expect(isAppUrl('https://example.com/', bundled)).toBe(false)
    expect(isAppUrl('http://localhost:3000/', bundled)).toBe(false)
  })

  it('refuses hosts and ports that merely share the dev URL as a prefix', () => {
    expect(isAppUrl('http://localhost:5173.evil.example/', bundled)).toBe(false)
    expect(isAppUrl('http://localhost:51730/', bundled)).toBe(false)
    expect(isAppUrl('http://localhost:5173@evil.example/', bundled)).toBe(false)
  })

  it('compares the dev URL path by segment', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173/app')
    expect(isAppUrl('http://localhost:5173/app', bundled)).toBe(true)
    expect(isAppUrl('http://localhost:5173/app/x', bundled)).toBe(true)
    expect(isAppUrl('http://localhost:5173/apple', bundled)).toBe(false)
  })

  it('falls back to the file check when the dev URL is not set', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    expect(isAppUrl('http://localhost:5173/', bundled)).toBe(false)
  })
})

describe('detectStartupFileFromArgs', () => {
  let files: string
  beforeEach(() => {
    files = join(fakeElectron.root, 'files')
    mkdirSync(files)
    mkdirSync(fakeElectron.appPath)
  })

  it('returns the first existing regular file after the executable', () => {
    const a = join(files, 'a.png')
    const b = join(files, 'b.png')
    writeFileSync(a, 'x')
    writeFileSync(b, 'x')
    expect(detectStartupFileFromArgs(['verve.exe', a, b])).toBe(a)
  })

  it('ignores switches, missing files, folders and the app path', () => {
    const doc = join(files, 'doc.verve')
    writeFileSync(doc, 'x')
    const argv = [
      'electron.exe',
      '--inspect=5858',
      '-flag',
      fakeElectron.appPath,
      '.',
      files,
      join(files, 'missing.png'),
      doc
    ]
    expect(detectStartupFileFromArgs(argv)).toBe(doc)
  })

  it('never returns the executable itself', () => {
    const exe = join(files, 'verve.exe')
    writeFileSync(exe, 'x')
    expect(detectStartupFileFromArgs([exe])).toBeNull()
  })

  it('returns null when nothing qualifies', () => {
    expect(detectStartupFileFromArgs(['verve.exe'])).toBeNull()
    expect(detectStartupFileFromArgs(['verve.exe', '--allow-file-access-from-files', 'nope.png'])).toBeNull()
    expect(detectStartupFileFromArgs([])).toBeNull()
  })

  it('tolerates odd arguments (empty, NUL bytes)', () => {
    expect(detectStartupFileFromArgs(['verve.exe', '', 'a\u0000b'])).toBeNull()
  })
})
