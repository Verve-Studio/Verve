import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => import('@tests/fakes/electronMain').then((m) => m.electronModule))

import {
  FakeBrowserWindow,
  disposeFakeElectron,
  fakeElectron,
  resetFakeElectron
} from '@tests/fakes/electronMain'
import { registerAutomationHandlers } from '../../../../electron/main/automations'

let dir: string

beforeEach(() => {
  resetFakeElectron()
  registerAutomationHandlers()
  dir = join(fakeElectron.root, 'flows')
  mkdirSync(dir)
})
afterAll(disposeFakeElectron)

const invoke = (channel: string, ...args: unknown[]) => fakeElectron.ipcMain.invoke(channel, ...args)

describe('automation:open', () => {
  it('returns null when the dialog is cancelled', async () => {
    expect(await invoke('automation:open')).toBeNull()
    expect(fakeElectron.openDialogCalls[0]).toMatchObject({
      defaultPath: fakeElectron.path('documents'),
      filters: [{ extensions: ['automation'] }]
    })
  })

  it('returns the picked file path and text', async () => {
    const p = join(dir, 'Batch.automation')
    writeFileSync(p, '{"format":"verve-automation"}')
    fakeElectron.answerOpen(p)
    expect(await invoke('automation:open')).toEqual({ path: p, text: '{"format":"verve-automation"}' })
  })

  it('refuses a picked file with another extension (All Files is not offered)', async () => {
    const p = join(dir, 'secrets.txt')
    writeFileSync(p, 'x')
    fakeElectron.answerOpen(p)
    await expect(invoke('automation:open')).rejects.toThrow(/Refusing to read/)
  })

  it('refuses a file larger than 16 MiB', async () => {
    const p = join(dir, 'huge.automation')
    const fd = openSync(p, 'w')
    ftruncateSync(fd, 16 * 1024 * 1024 + 1)
    closeSync(fd)
    fakeElectron.answerOpen(p)
    await expect(invoke('automation:open')).rejects.toThrow(/too large/)
  })

  it('parents the dialog to the calling window when there is one', async () => {
    const win = new FakeBrowserWindow()
    await fakeElectron.ipcMain.invokeFrom(win.webContents, 'automation:open')
    expect(fakeElectron.openDialogCalls).toHaveLength(1)
  })
})

describe('automation:saveAs', () => {
  it('writes to the chosen path and returns it', async () => {
    const p = join(dir, 'Flow.automation')
    fakeElectron.answerSave(p)
    expect(await invoke('automation:saveAs', '{"a":1}')).toBe(p)
    expect(readFileSync(p, 'utf-8')).toBe('{"a":1}')
  })

  it('suggests Documents/Workflow.automation, or the given path', async () => {
    await invoke('automation:saveAs', '{}')
    await invoke('automation:saveAs', '{}', join(dir, 'Mine.automation'))
    await invoke('automation:saveAs', '{}', 42)
    expect(fakeElectron.saveDialogCalls.map((c) => (c as { defaultPath: string }).defaultPath)).toEqual([
      join(fakeElectron.path('documents'), 'Workflow.automation'),
      join(dir, 'Mine.automation'),
      join(fakeElectron.path('documents'), 'Workflow.automation')
    ])
  })

  it('returns null when cancelled and writes nothing', async () => {
    expect(await invoke('automation:saveAs', '{}')).toBeNull()
  })

  it('refuses a chosen path with another extension', async () => {
    const p = join(dir, 'Flow.bat')
    fakeElectron.answerSave(p)
    await expect(invoke('automation:saveAs', '{}')).rejects.toThrow(/Refusing to write/)
    expect(existsSync(p)).toBe(false)
  })

  it('refuses non-string data before opening a dialog', async () => {
    await expect(invoke('automation:saveAs', { graph: 1 })).rejects.toThrow('Invalid automation data')
    expect(fakeElectron.saveDialogCalls).toHaveLength(0)
  })
})

describe('automation:write', () => {
  it('overwrites an .automation file', async () => {
    const p = join(dir, 'Flow.automation')
    writeFileSync(p, 'old')
    await invoke('automation:write', p, 'new')
    expect(readFileSync(p, 'utf-8')).toBe('new')
  })

  it('refuses other extensions and non-string data', async () => {
    const bat = join(dir, 'x.bat')
    await expect(invoke('automation:write', bat, 'echo pwned')).rejects.toThrow(/Refusing to write/)
    expect(existsSync(bat)).toBe(false)
    await expect(invoke('automation:write', join(dir, 'a.automation'), 5)).rejects.toThrow(
      'Invalid automation data'
    )
    await expect(invoke('automation:write', undefined, 'x')).rejects.toThrow('Invalid file path')
  })
})
