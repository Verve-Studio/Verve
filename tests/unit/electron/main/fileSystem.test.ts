import { mkdirSync, symlinkSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => import('@tests/fakes/electronMain').then((m) => m.electronModule))

import { disposeFakeElectron, fakeElectron, resetFakeElectron } from '@tests/fakes/electronMain'
import { registerFileSystemHandlers, type FsEntry, type FsStat } from '../../../../electron/main/fileSystem'

let root: string

beforeEach(() => {
  resetFakeElectron()
  registerFileSystemHandlers()
  root = join(fakeElectron.root, 'work')
  mkdirSync(root)
})
afterAll(disposeFakeElectron)

const list = (path: unknown, options?: unknown) =>
  fakeElectron.ipcMain.invoke('fs:list', path, options) as Promise<FsEntry[]>
const stat = (path: unknown) => fakeElectron.ipcMain.invoke('fs:stat', path) as Promise<FsStat>
const names = (entries: FsEntry[]): string[] => entries.map((e) => e.name)

describe('path validation', () => {
  it.each(['fs:list', 'fs:stat', 'fs:mkdir'])('%s rejects relative paths', async (channel) => {
    await expect(fakeElectron.ipcMain.invoke(channel, 'relative/dir')).rejects.toThrow(
      /not an absolute path/
    )
    await expect(fakeElectron.ipcMain.invoke(channel, '../up')).rejects.toThrow(/not an absolute path/)
  })

  it.each(['fs:list', 'fs:stat', 'fs:mkdir'])('%s rejects non-string input', async (channel) => {
    for (const bad of [undefined, null, 1, {}, [], '']) {
      await expect(fakeElectron.ipcMain.invoke(channel, bad)).rejects.toThrow('Invalid path')
    }
  })
})

describe('fs:list', () => {
  beforeEach(() => {
    for (const n of ['img10.png', 'img2.png', 'img1.png']) writeFileSync(join(root, n), 'x')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'deep.png'), 'xyz')
  })

  it('lists files only by default, in natural (numeric) order, with metadata', async () => {
    const entries = await list(root)
    expect(names(entries)).toEqual(['img1.png', 'img2.png', 'img10.png'])
    const first = entries[0]
    expect(first.path).toBe(join(root, 'img1.png'))
    expect(first.isDirectory).toBe(false)
    expect(first.size).toBe(1)
    expect(first.modified).toBeGreaterThan(0)
  })

  it('includes folders when asked and can exclude files', async () => {
    expect(names(await list(root, { folders: true }))).toEqual(['img1.png', 'img2.png', 'img10.png', 'sub'])
    const onlyFolders = await list(root, { folders: true, files: false })
    expect(names(onlyFolders)).toEqual(['sub'])
    expect(onlyFolders[0].isDirectory).toBe(true)
  })

  it('recurses into subfolders when asked', async () => {
    const entries = await list(root, { recursive: true })
    expect(entries.map((e) => e.path)).toContain(join(root, 'sub', 'deep.png'))
    expect(names(await list(root))).not.toContain('deep.png')
  })

  it('treats a null options argument like the defaults', async () => {
    expect(names(await list(root, null))).toEqual(['img1.png', 'img2.png', 'img10.png'])
  })

  it('normalises `..` segments in the root', async () => {
    const entries = await list(join(root, 'sub', '..'))
    expect(entries[0].path).toBe(join(root, 'img1.png'))
  })

  it('fails when the root folder does not exist', async () => {
    await expect(list(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('skips symbolic links (no cycles through linked folders)', async (ctx) => {
    try {
      symlinkSync(root, join(root, 'loop'), 'junction')
    } catch {
      ctx.skip() // creating links needs extra privileges on some systems
    }
    const entries = await list(root, { recursive: true, folders: true })
    expect(names(entries)).not.toContain('loop')
  })
})

describe('fs:stat', () => {
  it('describes a file', async () => {
    const f = join(root, 'a.png')
    writeFileSync(f, 'abcd')
    const s = await stat(f)
    expect(s).toMatchObject({ exists: true, isFile: true, isDirectory: false, size: 4 })
    expect(s.modified).toBeCloseTo(statSync(f).mtimeMs)
  })

  it('describes a folder', async () => {
    expect(await stat(root)).toMatchObject({ exists: true, isFile: false, isDirectory: true })
  })

  it('reports a missing path as not existing instead of failing', async () => {
    expect(await stat(join(root, 'nope'))).toEqual({
      exists: false,
      isDirectory: false,
      isFile: false,
      size: 0,
      modified: 0,
      created: 0
    })
  })
})

describe('fs:mkdir', () => {
  it('creates missing parents and is idempotent', async () => {
    const deep = join(root, 'a', 'b', 'c')
    await fakeElectron.ipcMain.invoke('fs:mkdir', deep)
    await fakeElectron.ipcMain.invoke('fs:mkdir', deep)
    expect(existsSync(deep)).toBe(true)
  })

  it('fails when a file is in the way', async () => {
    writeFileSync(join(root, 'file'), 'x')
    await expect(fakeElectron.ipcMain.invoke('fs:mkdir', join(root, 'file', 'child'))).rejects.toThrow()
  })
})
