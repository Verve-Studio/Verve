import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => import('@tests/fakes/electronMain').then((m) => m.electronModule))

// fs.watch is replaced by a controllable fake: real watcher events arrive
// with OS-dependent timing, which makes debounce assertions flaky.
const watches = vi.hoisted(() => [] as Array<{
  dir: string
  listener: () => void
  closed: boolean
  emitter: import('node:events').EventEmitter
}>)
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const { EventEmitter } = await import('node:events')
  return {
    ...real,
    watch: (dir: string, listener: () => void) => {
      const emitter = new EventEmitter()
      const w = { dir, listener, closed: false, emitter }
      Object.assign(emitter, { close: () => { w.closed = true } })
      watches.push(w)
      return emitter
    }
  }
})

import {
  FakeBrowserWindow,
  disposeFakeElectron,
  fakeElectron,
  resetFakeElectron,
  settleEffectsWatcher
} from '@tests/fakes/electronMain'
import { registerEffectHandlers, userEffectsDir, type EffectFileEntry } from '../../../../electron/main/effects'

let userDir: string
let bundledDir: string

beforeEach(async () => {
  resetFakeElectron()
  registerEffectHandlers()
  await settleEffectsWatcher()
  userDir = join(fakeElectron.path('userData'), 'effects')
  bundledDir = join(fakeElectron.appPath, 'resources', 'effects')
})
afterEach(() => {
  // Closes the folder watcher (registered on app 'will-quit').
  fakeElectron.emitApp('will-quit')
})
afterAll(disposeFakeElectron)

const invoke = (channel: string, ...args: unknown[]) => fakeElectron.ipcMain.invoke(channel, ...args)
const list = () => invoke('effects:list') as Promise<EffectFileEntry[]>

describe('effects:list', () => {
  it('is empty when neither folder exists', async () => {
    expect(await list()).toEqual([])
  })

  it('lists bundled effects first, then user effects, each sorted by name', async () => {
    mkdirSync(userDir, { recursive: true })
    mkdirSync(bundledDir, { recursive: true })
    writeFileSync(join(userDir, 'b.effect'), 'user-b')
    writeFileSync(join(userDir, 'a.effect'), 'user-a')
    writeFileSync(join(bundledDir, 'Glow.effect'), 'bundled')
    expect(await list()).toEqual([
      { path: join(bundledDir, 'Glow.effect'), source: 'bundled', text: 'bundled' },
      { path: join(userDir, 'a.effect'), source: 'user', text: 'user-a' },
      { path: join(userDir, 'b.effect'), source: 'user', text: 'user-b' }
    ])
  })

  it('ignores files with other extensions and matches the extension case-insensitively', async () => {
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'notes.txt'), 'x')
    writeFileSync(join(userDir, 'x.effect.bak'), 'x')
    writeFileSync(join(userDir, 'Upper.EFFECT'), 'u')
    expect((await list()).map((e) => e.path)).toEqual([join(userDir, 'Upper.EFFECT')])
  })

  it('passes malformed JSON through as text (the renderer validates it)', async () => {
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'broken.effect'), '{ not json')
    expect(await list()).toEqual([{ path: join(userDir, 'broken.effect'), source: 'user', text: '{ not json' }])
  })

  it('reports an oversized file as an error entry instead of reading it', async () => {
    mkdirSync(userDir, { recursive: true })
    const fd = openSync(join(userDir, 'big.effect'), 'w')
    ftruncateSync(fd, 8 * 1024 * 1024 + 1)
    closeSync(fd)
    writeFileSync(join(userDir, 'ok.effect'), 'ok')
    expect(await list()).toEqual([
      { path: join(userDir, 'big.effect'), source: 'user', error: 'File is too large' },
      { path: join(userDir, 'ok.effect'), source: 'user', text: 'ok' }
    ])
  })

  it('reports an unreadable entry (a folder named *.effect) as an error without failing the list', async () => {
    mkdirSync(join(userDir, 'dir.effect'), { recursive: true })
    writeFileSync(join(userDir, 'ok.effect'), 'ok')
    const entries = await list()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ path: join(userDir, 'dir.effect'), source: 'user' })
    expect(entries[0].error).toEqual(expect.any(String))
    expect(entries[0].text).toBeUndefined()
    expect(entries[1]).toEqual({ path: join(userDir, 'ok.effect'), source: 'user', text: 'ok' })
  })

  it('reads bundled effects from resourcesPath in a packaged app', async () => {
    const resources = join(fakeElectron.root, 'packaged-resources')
    mkdirSync(join(resources, 'effects'), { recursive: true })
    writeFileSync(join(resources, 'effects', 'p.effect'), 'p')
    fakeElectron.isPackaged = true
    const desc = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    try {
      expect(await list()).toEqual([{ path: join(resources, 'effects', 'p.effect'), source: 'bundled', text: 'p' }])
    } finally {
      if (desc) Object.defineProperty(process, 'resourcesPath', desc)
      else delete (process as { resourcesPath?: string }).resourcesPath
    }
  })
})

describe('user folder watcher', () => {
  it('creates the user folder on registration', async () => {
    await vi.waitFor(() => expect(existsSync(userDir)).toBe(true))
  })

  it('watches the user folder', () => {
    expect(watches.at(-1)?.dir).toBe(userDir)
  })

  it('notifies every window once per burst of changes (debounced)', async () => {
    const a = new FakeBrowserWindow()
    const b = new FakeBrowserWindow()
    const w = watches.at(-1)!
    for (let i = 0; i < 5; i++) w.listener()
    const changed = (win: FakeBrowserWindow) =>
      win.webContents.sent.filter((m) => m.channel === 'effects:changed')
    expect(changed(a)).toHaveLength(0)
    await new Promise((r) => setTimeout(r, 300))
    expect(changed(a)).toHaveLength(1)
    expect(changed(b)).toHaveLength(1)
    // A later change notifies again.
    w.listener()
    await new Promise((r) => setTimeout(r, 300))
    expect(changed(a)).toHaveLength(2)
  })

  it('closes the watcher when the app quits', () => {
    const w = watches.at(-1)!
    expect(w.closed).toBe(false)
    fakeElectron.emitApp('will-quit')
    expect(w.closed).toBe(true)
  })

  it('closes the watcher when it errors (e.g. the folder was deleted)', () => {
    const w = watches.at(-1)!
    w.emitter.emit('error', new Error('EPERM'))
    expect(w.closed).toBe(true)
  })

  it('getEffectsFolder returns the user folder', async () => {
    expect(await invoke('effects:folder')).toBe(userEffectsDir())
    expect(userEffectsDir()).toBe(userDir)
  })
})

describe('effects:save', () => {
  it('suggests a sanitised file name in the user folder and writes the chosen path', async () => {
    const target = join(userDir, 'Chosen.effect')
    fakeElectron.answerSave(target)
    expect(await invoke('effects:save', '{"graph":1}', 'My<>:"/\\|?*\u0001 Effect')).toBe(target)
    expect(readFileSync(target, 'utf-8')).toBe('{"graph":1}')
    expect(fakeElectron.saveDialogCalls[0]).toMatchObject({
      defaultPath: join(userDir, 'My Effect.effect'),
      filters: [{ extensions: ['effect'] }]
    })
  })

  it('falls back to "Effect" when the suggested name is empty or not a string', async () => {
    await invoke('effects:save', '{}', '  ')
    await invoke('effects:save', '{}', 42)
    await invoke('effects:save', '{}', '../..')
    const defaults = fakeElectron.saveDialogCalls.map((c) => (c as { defaultPath: string }).defaultPath)
    expect(defaults[0]).toBe(join(userDir, 'Effect.effect'))
    expect(defaults[1]).toBe(join(userDir, 'Effect.effect'))
    // Separators are stripped, so the suggestion cannot leave the folder.
    expect(defaults[2]).toBe(join(userDir, '.....effect'))
  })

  it('returns null when cancelled', async () => {
    expect(await invoke('effects:save', '{}', 'x')).toBeNull()
  })

  it('refuses a chosen path with another extension', async () => {
    const p = join(fakeElectron.root, 'evil.js')
    fakeElectron.answerSave(p)
    await expect(invoke('effects:save', 'x', 'x')).rejects.toThrow(/Refusing to write/)
    expect(existsSync(p)).toBe(false)
  })

  it('refuses non-string data before opening a dialog', async () => {
    await expect(invoke('effects:save', { graph: {} }, 'x')).rejects.toThrow('Invalid effect data')
    expect(fakeElectron.saveDialogCalls).toHaveLength(0)
  })
})

describe('effects:openFile / effects:read / effects:write', () => {
  it('openFile returns the picked file, or null when cancelled', async () => {
    expect(await invoke('effects:openFile')).toBeNull()
    const p = join(fakeElectron.root, 'x.effect')
    writeFileSync(p, 'graph')
    fakeElectron.answerOpen(p)
    expect(await invoke('effects:openFile')).toEqual({ path: p, text: 'graph' })
  })

  it('openFile refuses a picked file with another extension', async () => {
    const p = join(fakeElectron.root, 'x.txt')
    writeFileSync(p, 'x')
    fakeElectron.answerOpen(p)
    await expect(invoke('effects:openFile')).rejects.toThrow(/Refusing to read/)
  })

  it('read returns the text of an .effect file and refuses other files', async () => {
    const p = join(fakeElectron.root, 'x.effect')
    writeFileSync(p, 'graph')
    expect(await invoke('effects:read', p)).toBe('graph')
    const secret = join(fakeElectron.root, 'secret.txt')
    writeFileSync(secret, 'x')
    await expect(invoke('effects:read', secret)).rejects.toThrow(/Refusing to read/)
    await expect(invoke('effects:read', 7)).rejects.toThrow('Invalid file path')
  })

  it('read refuses an oversized file', async () => {
    const p = join(fakeElectron.root, 'big.effect')
    const fd = openSync(p, 'w')
    ftruncateSync(fd, 8 * 1024 * 1024 + 1)
    closeSync(fd)
    await expect(invoke('effects:read', p)).rejects.toThrow(/too large/)
  })

  it('write overwrites an .effect file and refuses other targets / data', async () => {
    const p = join(fakeElectron.root, 'x.effect')
    writeFileSync(p, 'old')
    await invoke('effects:write', p, 'new')
    expect(readFileSync(p, 'utf-8')).toBe('new')
    await expect(invoke('effects:write', join(fakeElectron.root, 'x.cmd'), 'x')).rejects.toThrow(/Refusing to write/)
    await expect(invoke('effects:write', p, null)).rejects.toThrow('Invalid effect data')
    expect(readFileSync(p, 'utf-8')).toBe('new')
  })
})

describe('effects:openFolder', () => {
  it('creates and opens the user folder', async () => {
    await invoke('effects:openFolder')
    expect(fakeElectron.openedPaths).toEqual([userDir])
    expect(existsSync(userDir)).toBe(true)
  })

  it('surfaces the shell error', async () => {
    fakeElectron.openPathError = 'No application is associated'
    await expect(invoke('effects:openFolder')).rejects.toThrow('No application is associated')
  })
})
