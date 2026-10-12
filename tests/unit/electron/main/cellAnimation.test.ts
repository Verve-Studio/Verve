import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, ftruncateSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => import('@tests/fakes/electronMain').then((m) => m.electronModule))

import { disposeFakeElectron, fakeElectron, resetFakeElectron } from '@tests/fakes/electronMain'
import { CELL_MANIFEST_NAME, registerCellAnimationHandlers } from '../../../../electron/main/cellAnimation'

let folder: string

beforeEach(() => {
  resetFakeElectron()
  registerCellAnimationHandlers()
  folder = join(fakeElectron.root, 'cells')
  mkdirSync(join(folder, '.verve-previews'), { recursive: true })
})
afterAll(disposeFakeElectron)

const invoke = (channel: string, ...args: unknown[]) => fakeElectron.ipcMain.invoke(channel, ...args)

describe('cells:readManifest / cells:writeManifest', () => {
  it('returns null for a folder without a manifest', async () => {
    expect(await invoke('cells:readManifest', folder)).toBeNull()
  })

  it('returns null for a folder that does not exist', async () => {
    expect(await invoke('cells:readManifest', join(folder, 'missing'))).toBeNull()
  })

  it('writes the manifest under its fixed name and reads it back', async () => {
    await invoke('cells:writeManifest', folder, '{"frames":[]}')
    expect(readFileSync(join(folder, CELL_MANIFEST_NAME), 'utf-8')).toBe('{"frames":[]}')
    expect(await invoke('cells:readManifest', folder)).toBe('{"frames":[]}')
  })

  it('refuses a manifest larger than 16 MiB', async () => {
    const fd = openSync(join(folder, CELL_MANIFEST_NAME), 'w')
    ftruncateSync(fd, 16 * 1024 * 1024 + 1)
    closeSync(fd)
    await expect(invoke('cells:readManifest', folder)).rejects.toThrow(/too large/)
  })

  it.each([undefined, null, 5, '', 'relative/folder'])('refuses an invalid folder (%j)', async (bad) => {
    await expect(invoke('cells:readManifest', bad)).rejects.toThrow()
    await expect(invoke('cells:writeManifest', bad, '{}')).rejects.toThrow()
  })

  it('refuses non-string manifest text without writing anything', async () => {
    for (const bad of [undefined, null, 1, { frames: [] }, new Uint8Array(2)]) {
      await expect(invoke('cells:writeManifest', folder, bad)).rejects.toThrow('Invalid manifest')
    }
    expect(existsSync(join(folder, CELL_MANIFEST_NAME))).toBe(false)
  })

  it('always writes the fixed file name, even for a folder path with `..`', async () => {
    await invoke('cells:writeManifest', join(folder, '.verve-previews', '..'), 'x')
    expect(readFileSync(join(folder, CELL_MANIFEST_NAME), 'utf-8')).toBe('x')
  })
})

describe('cells:trash', () => {
  it('moves a frame file to the trash', async () => {
    const frame = join(folder, 'frame-001.verve')
    writeFileSync(frame, 'x')
    await invoke('cells:trash', frame)
    expect(fakeElectron.trashed).toEqual([frame])
  })

  it('accepts .exr frames and upper-case extensions', async () => {
    const a = join(folder, 'f.exr')
    const b = join(folder, 'g.VERVE')
    writeFileSync(a, 'x')
    writeFileSync(b, 'x')
    await invoke('cells:trash', a)
    await invoke('cells:trash', b)
    expect(fakeElectron.trashed).toEqual([a, b])
  })

  it('moves a PNG only when it is a frame preview', async () => {
    const preview = join(folder, '.verve-previews', 'frame-001.png')
    const other = join(folder, 'reference.png')
    writeFileSync(preview, 'x')
    writeFileSync(other, 'x')
    await invoke('cells:trash', preview)
    await expect(invoke('cells:trash', other)).rejects.toThrow(/not a frame preview/)
    expect(fakeElectron.trashed).toEqual([preview])
  })

  it.each(['notes.txt', 'run.exe', 'doc.psd', 'archive'])('refuses to trash %s', async (name) => {
    const p = join(folder, name)
    writeFileSync(p, 'x')
    await expect(invoke('cells:trash', p)).rejects.toThrow(/not a cell frame/)
    expect(fakeElectron.trashed).toEqual([])
  })

  it('judges the resolved path, so `..` cannot dress up another file as a preview', async () => {
    writeFileSync(join(folder, 'reference.png'), 'x')
    const sneaky = join(folder, '.verve-previews', '..', 'reference.png')
    await expect(invoke('cells:trash', sneaky)).rejects.toThrow(/not a frame preview/)
  })

  it('resolves the path it trashes', async () => {
    const frame = join(folder, 'f.verve')
    writeFileSync(frame, 'x')
    await invoke('cells:trash', `${folder}/.verve-previews/../f.verve`)
    expect(fakeElectron.trashed).toEqual([frame])
  })

  it('is a no-op for a file that is already gone', async () => {
    await expect(invoke('cells:trash', join(folder, 'gone.verve'))).resolves.toBeUndefined()
    expect(fakeElectron.trashed).toEqual([])
  })

  it.each([undefined, null, 3, 'relative.verve'])('refuses an invalid path (%j)', async (bad) => {
    await expect(invoke('cells:trash', bad)).rejects.toThrow('Invalid file path')
  })
})
