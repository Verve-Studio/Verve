import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => import('@tests/fakes/electronMain').then((m) => m.electronModule))

import { disposeFakeElectron, fakeElectron, resetFakeElectron } from '@tests/fakes/electronMain'
import { registerPreferencesHandlers, type AppPreferences } from '../../../../electron/main/preferences'

const GB = 1024 * 1024 * 1024
let userData: string
let prefsFile: string

beforeEach(() => {
  resetFakeElectron()
  registerPreferencesHandlers()
  userData = fakeElectron.path('userData')
  mkdirSync(userData, { recursive: true })
  prefsFile = join(userData, 'preferences.json')
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterAll(disposeFakeElectron)

const load = () => fakeElectron.ipcMain.invoke('prefs:load') as Promise<AppPreferences>
const save = (p: unknown) => fakeElectron.ipcMain.invoke('prefs:save', p)

describe('prefs:load', () => {
  it('returns the defaults on first run (no file)', async () => {
    const prefs = await load()
    expect(prefs).toMatchObject({
      theme: 'dark',
      historyMemoryBytes: 4 * GB,
      bufferMemoryBytes: 8 * GB,
      bufferMemoryMaxOut: false,
      colorImportIntent: 'perceptual',
      colorConvertIntent: 'relative-colorimetric',
      colorUseBpc: true,
      colorMissingProfilePolicy: 'assume-working-space'
    })
    // Left unset so the renderer can seed it from the platform.
    expect(prefs.unifiedMemory).toBeUndefined()
  })

  it('returns a fresh object each time (callers cannot mutate the defaults)', async () => {
    const a = await load()
    a.historyMemoryBytes = 1
    expect((await load()).historyMemoryBytes).toBe(4 * GB)
  })

  it('fills fields missing from an older file with defaults and keeps the saved ones', async () => {
    writeFileSync(prefsFile, JSON.stringify({ theme: 'light', historyMemoryBytes: 123 }))
    expect(await load()).toMatchObject({
      theme: 'light',
      historyMemoryBytes: 123,
      bufferMemoryBytes: 8 * GB,
      colorUseBpc: true
    })
  })

  it('a saved value overrides a default even when it is falsy', async () => {
    writeFileSync(prefsFile, JSON.stringify({ colorUseBpc: false, unifiedMemory: false }))
    const prefs = await load()
    expect(prefs.colorUseBpc).toBe(false)
    expect(prefs.unifiedMemory).toBe(false)
  })

  it('falls back to defaults on corrupt JSON and keeps a backup of the unreadable file', async () => {
    writeFileSync(prefsFile, '{ "theme": "light", ')
    const prefs = await load()
    expect(prefs.theme).toBe('dark')
    const backups = readdirSync(userData).filter((n) => n.startsWith('preferences.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(userData, backups[0]), 'utf-8')).toBe('{ "theme": "light", ')
    // The original stays until the next save replaces it.
    expect(readFileSync(prefsFile, 'utf-8')).toBe('{ "theme": "light", ')
  })

  it('treats a JSON `null` file as empty', async () => {
    writeFileSync(prefsFile, 'null')
    expect((await load()).historyMemoryBytes).toBe(4 * GB)
  })
})

describe('prefs:save', () => {
  it('round-trips through load and writes pretty JSON', async () => {
    await save({ theme: 'auto', historyMemoryBytes: 2 * GB, bufferMemoryBytes: GB, bufferMemoryMaxOut: true, unifiedMemory: true })
    const text = readFileSync(prefsFile, 'utf-8')
    expect(text).toContain('\n  "theme": "auto"')
    expect(await load()).toMatchObject({
      theme: 'auto',
      historyMemoryBytes: 2 * GB,
      bufferMemoryBytes: GB,
      bufferMemoryMaxOut: true,
      unifiedMemory: true,
      colorImportIntent: 'perceptual'
    })
  })

  it('completes a partial object with defaults before writing', async () => {
    await save({ theme: 'light' })
    const written = JSON.parse(readFileSync(prefsFile, 'utf-8'))
    expect(written).toMatchObject({ theme: 'light', historyMemoryBytes: 4 * GB, colorUseBpc: true })
  })

  it('writes the defaults when given null / undefined', async () => {
    await save(null)
    expect(JSON.parse(readFileSync(prefsFile, 'utf-8')).bufferMemoryBytes).toBe(8 * GB)
    await save(undefined)
    expect(JSON.parse(readFileSync(prefsFile, 'utf-8')).bufferMemoryBytes).toBe(8 * GB)
  })

  it('replaces a corrupt file', async () => {
    writeFileSync(prefsFile, 'garbage')
    await save({ theme: 'light' })
    expect((await load()).theme).toBe('light')
  })

  it('leaves no temp files behind', async () => {
    await save({ theme: 'light' })
    expect(readdirSync(userData).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('surfaces a write failure to the renderer', async () => {
    // userData is a file: the write cannot succeed.
    resetFakeElectron()
    registerPreferencesHandlers()
    writeFileSync(fakeElectron.path('userData'), 'not a folder')
    await expect(save({ theme: 'light' })).rejects.toThrow()
  })
})

describe('sanitising', () => {
  const wrongTyped = {
    theme: 'neon',
    historyMemoryBytes: '1000',
    bufferMemoryBytes: -5,
    bufferMemoryMaxOut: 'yes',
    unifiedMemory: 1,
    colorImportIntent: 'vivid',
    colorConvertIntent: null,
    colorUseBpc: 'false',
    colorMissingProfilePolicy: 42
  }

  it('prefs:load replaces wrong-typed fields with the defaults', async () => {
    writeFileSync(prefsFile, JSON.stringify(wrongTyped))
    const prefs = await load()
    expect(prefs).toMatchObject({
      theme: 'dark',
      historyMemoryBytes: 4 * GB,
      bufferMemoryBytes: 8 * GB,
      bufferMemoryMaxOut: false,
      colorImportIntent: 'perceptual',
      colorConvertIntent: 'relative-colorimetric',
      colorUseBpc: true,
      colorMissingProfilePolicy: 'assume-working-space'
    })
    expect(prefs.unifiedMemory).toBeUndefined()
  })

  it('prefs:load keeps the valid fields next to invalid ones', async () => {
    writeFileSync(prefsFile, JSON.stringify({ ...wrongTyped, theme: 'light', colorUseBpc: false }))
    const prefs = await load()
    expect(prefs.theme).toBe('light')
    expect(prefs.colorUseBpc).toBe(false)
    expect(prefs.historyMemoryBytes).toBe(4 * GB)
  })

  it.each([
    ['null', { historyMemoryBytes: null }],
    ['zero', { historyMemoryBytes: 0 }],
    ['an object', { historyMemoryBytes: { n: 1 } }]
  ])('rejects a %s memory size', async (_label, value) => {
    writeFileSync(prefsFile, JSON.stringify(value))
    expect((await load()).historyMemoryBytes).toBe(4 * GB)
  })

  it.each([
    ['an array', '[1, 2, 3]'],
    ['a string', '"dark"'],
    ['a number', '42'],
    ['a boolean', 'true']
  ])('prefs:load treats a file containing %s as empty', async (_label, text) => {
    writeFileSync(prefsFile, text)
    const prefs = await load()
    expect(prefs).toMatchObject({ theme: 'dark', historyMemoryBytes: 4 * GB })
    expect(Object.keys(prefs).some((k) => /^\d+$/.test(k))).toBe(false)
  })

  it('prefs:load drops fields that are not preferences', async () => {
    writeFileSync(prefsFile, JSON.stringify({ theme: 'light', evil: '<script>', __proto__x: 1 }))
    const prefs = (await load()) as unknown as Record<string, unknown>
    expect(prefs.theme).toBe('light')
    expect('evil' in prefs).toBe(false)
    expect('__proto__x' in prefs).toBe(false)
  })

  it('prefs:save writes only valid fields', async () => {
    await save({ ...wrongTyped, theme: 'auto', extra: 'x' })
    const written = JSON.parse(readFileSync(prefsFile, 'utf-8'))
    expect(written).toMatchObject({ theme: 'auto', historyMemoryBytes: 4 * GB, colorUseBpc: true })
    expect(written.extra).toBeUndefined()
    expect(written.unifiedMemory).toBeUndefined()
  })

  it.each([
    ['a string', 'dark'],
    ['an array', ['light']],
    ['a number', 7]
  ])('prefs:save writes the defaults for %s', async (_label, value) => {
    await save(value)
    const written = JSON.parse(readFileSync(prefsFile, 'utf-8'))
    expect(written).toMatchObject({ theme: 'dark', bufferMemoryBytes: 8 * GB })
    expect(written['0']).toBeUndefined()
  })
})

describe('system:totalMemoryBytes', () => {
  it('reports the machine RAM', async () => {
    expect(await fakeElectron.ipcMain.invoke('system:totalMemoryBytes')).toBe(totalmem())
  })
})
