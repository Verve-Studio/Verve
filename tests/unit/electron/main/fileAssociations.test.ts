import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => import('@tests/fakes/electronMain').then((m) => m.electronModule))

// Child processes are faked: `execFile` calls are recorded and answered by
// `hooks.answer`; the real `reg` / `xdg-mime` / PowerShell never run.
const hooks = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[] }>,
  answer: null as null | ((file: string, args: string[]) => string | Error)
}))
vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void
  ) => {
    hooks.calls.push({ file, args })
    const out = hooks.answer?.(file, args) ?? ''
    queueMicrotask(() => (out instanceof Error ? cb(out) : cb(null, { stdout: out, stderr: '' })))
  },
  spawn: () => {
    throw new Error('spawn is not expected in these tests')
  }
}))

import { disposeFakeElectron } from '@tests/fakes/electronMain'
import { SUPPORTED_FILE_TYPES, applyExtensions, getRegisteredExtensions } from '../../../../electron/main/fileAssociations'

const realPlatform = process.platform
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

beforeEach(() => {
  hooks.calls = []
  hooks.answer = null
})
afterEach(() => {
  setPlatform(realPlatform)
})
afterAll(disposeFakeElectron)

const regCalls = () => hooks.calls.filter((c) => c.file === 'reg')

describe('SUPPORTED_FILE_TYPES', () => {
  it('has unique, lower-case extensions with labels', () => {
    const exts = SUPPORTED_FILE_TYPES.map((t) => t.ext)
    expect(new Set(exts).size).toBe(exts.length)
    for (const t of SUPPORTED_FILE_TYPES) {
      expect(t.ext).toMatch(/^[a-z0-9]+$/)
      expect(t.label).toContain(`.${t.ext}`)
    }
  })
})

describe('Windows', () => {
  beforeEach(() => setPlatform('win32'))

  it('reports an extension as registered only when its default value is our ProgID', async () => {
    hooks.answer = (_f, args) => {
      if (args[1] === 'HKCU\\Software\\Classes\\.png') return '    (Default)    REG_SZ    VerveApp.PNG'
      if (args[1] === 'HKCU\\Software\\Classes\\.jpg') return '    (Default)    REG_SZ    OtherApp.jpg'
      if (args[1] === 'HKCU\\Software\\Classes\\.exr') return new Error('key not found')
      return ''
    }
    expect(await getRegisteredExtensions()).toEqual(['png'])
    expect(regCalls()).toHaveLength(SUPPORTED_FILE_TYPES.length)
    for (const c of regCalls()) expect(c.args[0]).toBe('query')
  })

  it('registers each requested extension with argument arrays (no shell quoting)', async () => {
    await applyExtensions(['png'])
    const adds = regCalls().filter((c) => c.args[0] === 'add')
    const exe = process.execPath
    expect(adds.map((c) => c.args)).toEqual([
      ['add', 'HKCU\\Software\\Classes\\VerveApp.PNG', '/ve', '/d', 'PNG Image (.png)', '/f'],
      ['add', 'HKCU\\Software\\Classes\\VerveApp.PNG\\DefaultIcon', '/ve', '/d', `${exe},0`, '/f'],
      ['add', 'HKCU\\Software\\Classes\\VerveApp.PNG\\shell\\open\\command', '/ve', '/d', `"${exe}" "%1"`, '/f'],
      ['add', 'HKCU\\Software\\Classes\\.png', '/ve', '/d', 'VerveApp.PNG', '/f']
    ])
    // Everything stays under the per-user hive.
    for (const c of regCalls()) expect(c.args[1].startsWith('HKCU\\Software\\Classes\\')).toBe(true)
  })

  it('removes our registrations that are no longer wanted, and only those', async () => {
    hooks.answer = (_f, args) => {
      if (args[0] !== 'query') return ''
      if (args[1].endsWith('\\.gif')) return 'REG_SZ VerveApp.GIF'
      if (args[1].endsWith('\\.png')) return 'REG_SZ VerveApp.PNG'
      return 'REG_SZ SomeoneElse'
    }
    await applyExtensions(['png'])
    const deletes = regCalls().filter((c) => c.args[0] === 'delete')
    expect(deletes.map((c) => c.args)).toEqual([['delete', 'HKCU\\Software\\Classes\\.gif', '/f']])
  })

  it('notifies the shell through PowerShell under %SystemRoot%', async () => {
    vi.stubEnv('SystemRoot', 'D:\\Win')
    try {
      await applyExtensions([])
    } finally {
      vi.unstubAllEnvs()
    }
    const ps = hooks.calls.find((c) => c.file.endsWith('powershell.exe'))
    expect(ps?.file).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(ps?.args.slice(0, 2)).toEqual(['-NoProfile', '-NonInteractive'])
  })

  it('does not fail when individual reg calls fail (best effort)', async () => {
    hooks.answer = () => new Error('access denied')
    await expect(applyExtensions(['png', 'jpg'])).resolves.toBeUndefined()
  })
})

describe('Linux', () => {
  let home: string
  beforeEach(() => {
    setPlatform('linux')
    home = mkdtempSync(join(os.tmpdir(), 'verve-home-'))
    vi.spyOn(os, 'homedir').mockReturnValue(home)
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('reports extensions whose default handler is verve', async () => {
    hooks.answer = (_f, args) => (args[2] === 'image/png' ? 'verve.desktop\n' : 'gimp.desktop\n')
    expect(await getRegisteredExtensions()).toEqual(['png'])
  })

  it('writes a desktop entry with the requested MIME types (deduplicated) and sets it as default', async () => {
    await applyExtensions(['jpg', 'jpeg', 'png'])
    const desktop = readFileSync(join(home, '.local', 'share', 'applications', 'verve.desktop'), 'utf-8')
    expect(desktop).toContain(`Exec=${process.execPath} %f`)
    expect(desktop).toContain('MimeType=image/jpeg;image/png;')
    const xdg = hooks.calls.find((c) => c.file === 'xdg-mime' && c.args[0] === 'default')
    expect(xdg?.args).toEqual(['default', 'verve.desktop', 'image/jpeg', 'image/png'])
  })

  it('skips xdg-mime when nothing is requested', async () => {
    await applyExtensions([])
    expect(hooks.calls.some((c) => c.file === 'xdg-mime')).toBe(false)
    expect(hooks.calls.some((c) => c.file === 'update-desktop-database')).toBe(true)
  })
})
