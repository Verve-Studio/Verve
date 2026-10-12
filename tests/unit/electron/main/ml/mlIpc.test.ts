import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => import('@tests/fakes/electronMain').then((m) => m.electronModule))

import type { FakeUtilityProcess } from '@tests/fakes/electronMain'

type Fake = typeof import('@tests/fakes/electronMain')
let fake: Fake

beforeEach(async () => {
  // mlHost keeps its worker in module state: fresh modules per test.
  vi.resetModules()
  fake = await import('@tests/fakes/electronMain')
  fake.resetFakeElectron()
  const { registerMlHandlers } = await import('../../../../../electron/main/ml/mlIpc')
  registerMlHandlers()
})
afterEach(() => fake.disposeFakeElectron())

const worker = (): FakeUtilityProcess => fake.fakeElectron.forks[0]
type Run = { type: 'run'; id: number; job: Record<string, unknown> }
const lastRun = (): Run => {
  const r = worker().posted.filter((m): m is Run => (m as { type: string }).type === 'run')
  return r[r.length - 1]
}

describe('ML IPC relay', () => {
  it.each([
    ['isnet:check-model', [], { kind: 'check', model: 'isnet' }],
    ['inpaint:check-model', [], { kind: 'check', model: 'inpaint' }],
    ['matting:check-model', [], { kind: 'check', model: 'matting' }],
    ['upscale:check-model', ['realesr-general-x4v3'], { kind: 'check', model: 'upscale', modelId: 'realesr-general-x4v3' }],
    ['upscale:list-models', [], { kind: 'list-upscale-models' }]
  ])('%s runs the matching worker job', async (channel, args, job) => {
    const p = fake.fakeElectron.ipcMain.invoke(channel, ...args)
    const run = lastRun()
    expect(run.job).toEqual(job)
    worker().reply({ type: 'result', id: run.id, result: 'r' })
    await expect(p).resolves.toBe('r')
  })

  it('passes inference parameters through unchanged (validation happens in the worker)', async () => {
    const params = { rgba: new Uint8Array(8), width: 1, height: 2 }
    const p = fake.fakeElectron.ipcMain.invoke('isnet:run', params)
    expect(lastRun().job).toEqual({ kind: 'isnet', params })
    worker().reply({ type: 'error', id: lastRun().id, message: 'rgba length 8 ≠ 1×2×4' })
    await expect(p).rejects.toThrow('rgba length 8 ≠ 1×2×4')
  })

  it('upscale:run relays tile progress to the calling window', async () => {
    const win = new fake.FakeBrowserWindow()
    const p = fake.fakeElectron.ipcMain.invokeFrom(win.webContents, 'upscale:run', { modelId: 'x' })
    const { id } = lastRun()
    worker().reply({ type: 'progress', id, loaded: 1, total: 4 })
    worker().reply({ type: 'progress', id, loaded: 0, total: 0 })
    worker().reply({ type: 'result', id, result: { rgba: new Uint8Array(4) } })
    await p
    expect(win.webContents.sent).toEqual([
      { channel: 'upscale:progress', args: [{ progress: 0.25, loaded: 1, total: 4 }] },
      { channel: 'upscale:progress', args: [{ progress: 0, loaded: 0, total: 0 }] }
    ])
  })

  it('matting:download-model reports success and relays progress', async () => {
    const win = new fake.FakeBrowserWindow()
    const p = fake.fakeElectron.ipcMain.invokeFrom(win.webContents, 'matting:download-model')
    const { id } = lastRun()
    worker().reply({ type: 'progress', id, loaded: 5, total: 10 })
    worker().reply({ type: 'result', id, result: undefined })
    await expect(p).resolves.toEqual({ success: true })
    expect(win.webContents.sent).toEqual([
      { channel: 'matting:download-progress', args: [{ progress: 0.5, loaded: 5, total: 10 }] }
    ])
  })

  it('matting:download-model returns the error instead of rejecting', async () => {
    const p = fake.fakeElectron.ipcMain.invoke('matting:download-model')
    worker().reply({ type: 'error', id: lastRun().id, message: 'HTTP 404' })
    await expect(p).resolves.toEqual({ error: 'HTTP 404' })
  })

  it('ml:cancel aborts the running job', async () => {
    const p = fake.fakeElectron.ipcMain.invoke('isnet:run', {})
    await fake.fakeElectron.ipcMain.invoke('ml:cancel')
    expect(worker().killed).toBe(true)
    worker().exit(0)
    await expect(p).rejects.toThrow(/cancelled/)
  })

  it('invalidate-session channels do not start a worker', async () => {
    for (const ch of ['isnet:invalidate-session', 'inpaint:invalidate-session', 'matting:invalidate-session', 'upscale:invalidate-session']) {
      await fake.fakeElectron.ipcMain.invoke(ch)
    }
    expect(fake.fakeElectron.forks).toHaveLength(0)
  })
})
