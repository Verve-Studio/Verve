import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => import('@tests/fakes/electronMain').then((m) => m.electronModule))

import { disposeFakeElectron, fakeElectron, resetFakeElectron } from '@tests/fakes/electronMain'
import { registerColorProfileHandlers, type CatalogEntry } from '../../../../electron/main/colorProfiles'

const isWin = process.platform === 'win32'
let userDir: string
let sysDir: string | null

beforeEach(() => {
  resetFakeElectron()
  registerColorProfileHandlers()
  userDir = join(fakeElectron.path('userData'), 'color-profiles')
  // On Windows the system folder is derived from %SystemRoot%, so it can be
  // pointed into the temp root; elsewhere it's a fixed absolute path.
  if (isWin) {
    const sysRoot = join(fakeElectron.root, 'Windows')
    vi.stubEnv('SystemRoot', sysRoot)
    sysDir = join(sysRoot, 'System32', 'spool', 'drivers', 'color')
    mkdirSync(sysDir, { recursive: true })
  } else {
    sysDir = null
  }
})
afterEach(() => {
  vi.unstubAllEnvs()
})
afterAll(disposeFakeElectron)

const invoke = (channel: string, ...args: unknown[]) => fakeElectron.ipcMain.invoke(channel, ...args)
const bytes = (v: unknown): number[] => [...(v as Uint8Array)]

describe('cms:listProfiles', () => {
  it('creates the user folder and lists user profiles (only .icc / .icm) first', async () => {
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'Mine.icc'), new Uint8Array(10))
    writeFileSync(join(userDir, 'Other.ICM'), new Uint8Array(3))
    writeFileSync(join(userDir, 'readme.txt'), 'x')
    if (sysDir) writeFileSync(join(sysDir, 'sRGB.icm'), new Uint8Array(5))
    const list = (await invoke('cms:listProfiles')) as CatalogEntry[]
    const user = list.filter((e) => e.source === 'user')
    expect(user.map((e) => e.id).sort()).toEqual(['usr:Mine.icc', 'usr:Other.ICM'])
    expect(user.find((e) => e.id === 'usr:Mine.icc')).toEqual({
      id: 'usr:Mine.icc',
      filename: 'Mine.icc',
      path: join(userDir, 'Mine.icc'),
      source: 'user',
      size: 10
    })
    expect(list.findIndex((e) => e.source === 'system')).not.toBe(0)
    if (sysDir) {
      expect(list.filter((e) => e.source === 'system')).toEqual([
        { id: 'sys:sRGB.icm', filename: 'sRGB.icm', path: join(sysDir, 'sRGB.icm'), source: 'system', size: 5 }
      ])
    }
  })

  it('works when the user folder cannot be created', async () => {
    // userData is a file: mkdir fails, listing continues with system profiles.
    writeFileSync(fakeElectron.path('userData'), 'x')
    const list = (await invoke('cms:listProfiles')) as CatalogEntry[]
    expect(list.filter((e) => e.source === 'user')).toEqual([])
  })
})

describe('cms:readProfileBytes', () => {
  beforeEach(() => {
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'Mine.icc'), new Uint8Array([1, 2, 3]))
    // A file the renderer must not be able to reach through a profile id.
    writeFileSync(join(fakeElectron.path('userData'), 'secret.icc'), new Uint8Array([6, 6, 6]))
  })

  it('reads a user profile by id', async () => {
    expect(bytes(await invoke('cms:readProfileBytes', 'usr:Mine.icc'))).toEqual([1, 2, 3])
  })

  it.runIf(isWin)('reads a system profile by id', async () => {
    writeFileSync(join(sysDir!, 'sRGB.icm'), new Uint8Array([4, 5]))
    expect(bytes(await invoke('cms:readProfileBytes', 'sys:sRGB.icm'))).toEqual([4, 5])
  })

  it('returns null for a missing profile or an unknown id scheme', async () => {
    expect(await invoke('cms:readProfileBytes', 'usr:Nope.icc')).toBeNull()
    expect(await invoke('cms:readProfileBytes', 'sys:Nope.icc')).toBeNull()
    expect(await invoke('cms:readProfileBytes', 'Mine.icc')).toBeNull()
    expect(await invoke('cms:readProfileBytes', join(userDir, 'Mine.icc'))).toBeNull()
  })

  it.each([
    'usr:../secret.icc',
    'usr:..\\secret.icc',
    'usr:..',
    'usr:.',
    'usr:',
    'usr:sub/../../secret.icc',
    `usr:${join(fakeElectron.root, 'userData', 'secret.icc')}`,
    'sys:../../secret.icc',
    'sys:..\\..\\..\\..\\secret.icc'
  ])('refuses a traversal id %s', async (id) => {
    expect(await invoke('cms:readProfileBytes', id)).toBeNull()
  })

  it('refuses an absolute path smuggled into a user id', async () => {
    const abs = join(fakeElectron.path('userData'), 'secret.icc')
    expect(await invoke('cms:readProfileBytes', `usr:${abs}`)).toBeNull()
  })

  it.runIf(isWin)('refuses Windows drive-relative and UNC names', async () => {
    expect(await invoke('cms:readProfileBytes', 'usr:C:secret.icc')).toBeNull()
    expect(await invoke('cms:readProfileBytes', 'usr:\\\\server\\share\\x.icc')).toBeNull()
  })

  it('rejects a non-string id instead of crashing the handler', async () => {
    await expect(invoke('cms:readProfileBytes', 42)).rejects.toThrow()
    await expect(invoke('cms:readProfileBytes', null)).rejects.toThrow()
  })
})

describe('cms:deleteUserProfile', () => {
  beforeEach(() => {
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'Mine.icc'), 'x')
    writeFileSync(join(fakeElectron.path('userData'), 'keep.icc'), 'x')
  })

  it('deletes a user profile', async () => {
    expect(await invoke('cms:deleteUserProfile', 'usr:Mine.icc')).toBe(true)
    expect(existsSync(join(userDir, 'Mine.icc'))).toBe(false)
  })

  it('returns false for a missing profile', async () => {
    expect(await invoke('cms:deleteUserProfile', 'usr:Gone.icc')).toBe(false)
  })

  it('never deletes system profiles', async () => {
    if (sysDir) writeFileSync(join(sysDir, 'sRGB.icm'), 'x')
    expect(await invoke('cms:deleteUserProfile', 'sys:sRGB.icm')).toBe(false)
    if (sysDir) expect(existsSync(join(sysDir, 'sRGB.icm'))).toBe(true)
  })

  it.each(['usr:../keep.icc', 'usr:..\\keep.icc', 'usr:..', 'usr:'])(
    'refuses a traversal id %s and deletes nothing',
    async (id) => {
      expect(await invoke('cms:deleteUserProfile', id)).toBe(false)
      expect(existsSync(join(fakeElectron.path('userData'), 'keep.icc'))).toBe(true)
    }
  )

  it('refuses an absolute path smuggled into the id', async () => {
    const keep = join(fakeElectron.path('userData'), 'keep.icc')
    expect(await invoke('cms:deleteUserProfile', `usr:${keep}`)).toBe(false)
    expect(existsSync(keep)).toBe(true)
  })
})

describe('cms:importProfileDialog', () => {
  it('copies the picked profile into the user folder', async () => {
    const src = join(fakeElectron.root, 'Downloaded.icc')
    writeFileSync(src, new Uint8Array([9, 8, 7]))
    fakeElectron.answerOpen(src)
    const entry = await invoke('cms:importProfileDialog')
    expect(entry).toEqual({
      id: 'usr:Downloaded.icc',
      filename: 'Downloaded.icc',
      path: join(userDir, 'Downloaded.icc'),
      source: 'user',
      size: 3
    })
    expect([...readFileSync(join(userDir, 'Downloaded.icc'))]).toEqual([9, 8, 7])
  })

  it('returns null when cancelled', async () => {
    expect(await invoke('cms:importProfileDialog')).toBeNull()
  })
})
