import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => import('@tests/fakes/electronMain').then((m) => m.electronModule))

import type { FakeUtilityProcess } from '@tests/fakes/electronMain'

// mlHost keeps the worker in module state: load a fresh copy per test. A
// module reset also re-creates the fake electron module, so import it again
// alongside to share the instance mlHost sees.
type Fake = typeof import('@tests/fakes/electronMain')
type MlHost = typeof import('../../../../../electron/main/ml/mlHost')
let fake: Fake
let host: MlHost

beforeEach(async () => {
  vi.resetModules()
  fake = await import('@tests/fakes/electronMain')
  fake.resetFakeElectron()
  host = await import('../../../../../electron/main/ml/mlHost')
})
afterEach(() => {
  vi.useRealTimers()
  fake.disposeFakeElectron()
})

const worker = (i = 0): FakeUtilityProcess => fake.fakeElectron.forks[i]
type Run = { type: 'run'; id: number; job: unknown }
const runs = (w: FakeUtilityProcess): Run[] =>
  w.posted.filter((m): m is Run => (m as { type: string }).type === 'run')

describe('worker lifecycle', () => {
  it('does not start a worker until the first job', () => {
    expect(fake.fakeElectron.forks).toHaveLength(0)
    void host.runMlJob({ kind: 'list-upscale-models' })
    expect(fake.fakeElectron.forks).toHaveLength(1)
    expect(worker().modulePath.endsWith('mlWorker.js')).toBe(true)
  })

  it('initialises the worker with the model paths before the first job', () => {
    void host.runMlJob({ kind: 'list-upscale-models' })
    const [init, run] = worker().posted as Array<{ type: string; paths?: unknown }>
    expect(init.type).toBe('init')
    expect(init.paths).toMatchObject({
      isPackaged: false,
      userData: fake.fakeElectron.path('userData')
    })
    expect(run.type).toBe('run')
  })

  it('reuses one worker for concurrent jobs, with distinct ids', () => {
    void host.runMlJob({ kind: 'list-upscale-models' })
    void host.runMlJob({ kind: 'check', model: 'isnet' })
    expect(fake.fakeElectron.forks).toHaveLength(1)
    const ids = runs(worker()).map((r) => r.id)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('results', () => {
  it('resolves each job with its own result, in any order', async () => {
    const a = host.runMlJob<string>({ kind: 'check', model: 'isnet' })
    const b = host.runMlJob<string>({ kind: 'check', model: 'inpaint' })
    const [ra, rb] = runs(worker())
    worker().reply({ type: 'result', id: rb.id, result: 'B' })
    worker().reply({ type: 'result', id: ra.id, result: 'A' })
    await expect(a).resolves.toBe('A')
    await expect(b).resolves.toBe('B')
  })

  it('rejects with the worker error message', async () => {
    const p = host.runMlJob({ kind: 'isnet', params: { rgba: new Uint8Array(4), width: 1, height: 1 } })
    worker().reply({ type: 'error', id: runs(worker())[0].id, message: 'rgba length 4 ≠ 2×2×4' })
    await expect(p).rejects.toThrow('rgba length 4 ≠ 2×2×4')
  })

  it('forwards progress to the job that asked for it', async () => {
    const progress: Array<[number, number]> = []
    const p = host.runMlJob({ kind: 'download-matting' }, (l, t) => progress.push([l, t]))
    const id = runs(worker())[0].id
    worker().reply({ type: 'progress', id, loaded: 1, total: 4 })
    worker().reply({ type: 'progress', id, loaded: 4, total: 4 })
    worker().reply({ type: 'result', id, result: null })
    await p
    expect(progress).toEqual([[1, 4], [4, 4]])
  })

  it('ignores messages for unknown or finished jobs', async () => {
    const p = host.runMlJob<number>({ kind: 'list-upscale-models' })
    const id = runs(worker())[0].id
    worker().reply({ type: 'result', id: 999, result: 'stray' })
    worker().reply({ type: 'result', id, result: 1 })
    worker().reply({ type: 'result', id, result: 2 })
    worker().reply({ type: 'progress', id, loaded: 1, total: 1 })
    await expect(p).resolves.toBe(1)
  })
})

describe('crashes', () => {
  it('rejects every pending job when the worker dies, with a helpful message', async () => {
    const a = host.runMlJob({ kind: 'check', model: 'isnet' })
    const b = host.runMlJob({ kind: 'check', model: 'matting' })
    worker().exit(3221225477)
    await expect(a).rejects.toThrow(/stopped unexpectedly \(exit code 3221225477\)/)
    await expect(b).rejects.toThrow(/stopped unexpectedly/)
  })

  it('starts a fresh worker for the next job after a crash', async () => {
    const a = host.runMlJob({ kind: 'check', model: 'isnet' })
    worker(0).exit(1)
    await expect(a).rejects.toThrow()
    const b = host.runMlJob<string>({ kind: 'check', model: 'isnet' })
    expect(fake.fakeElectron.forks).toHaveLength(2)
    expect((worker(1).posted[0] as { type: string }).type).toBe('init')
    worker(1).reply({ type: 'result', id: runs(worker(1))[0].id, result: 'ok' })
    await expect(b).resolves.toBe('ok')
  })
})

describe('cancellation', () => {
  it('cancel kills the worker and rejects pending jobs as cancelled', async () => {
    const a = host.runMlJob({ kind: 'upscale', params: {} as never })
    host.cancelMlJobs()
    expect(worker().killed).toBe(true)
    worker().exit(0)
    await expect(a).rejects.toThrow('The AI operation was cancelled.')
  })

  it('cancel with no worker running is a no-op', () => {
    expect(() => host.cancelMlJobs()).not.toThrow()
    expect(fake.fakeElectron.forks).toHaveLength(0)
  })

  it('after a cancel, a later crash is reported as a crash, not a cancel', async () => {
    const a = host.runMlJob({ kind: 'check', model: 'isnet' })
    host.cancelMlJobs()
    worker(0).exit(0)
    await expect(a).rejects.toThrow(/cancelled/)
    const b = host.runMlJob({ kind: 'check', model: 'isnet' })
    worker(1).exit(5)
    await expect(b).rejects.toThrow(/stopped unexpectedly/)
  })

  it('a job submitted after cancel (before the old worker exits) is not cancelled', async () => {
    const a = host.runMlJob({ kind: 'check', model: 'isnet' })
    host.cancelMlJobs()
    const b = host.runMlJob<string>({ kind: 'check', model: 'isnet' })
    b.catch(() => undefined) // asserted below; avoid an unhandled rejection
    worker(0).exit(0)
    await expect(a).rejects.toThrow(/cancelled/)
    const fresh = fake.fakeElectron.forks[1]
    expect(fresh).toBeDefined()
    fresh.reply({ type: 'result', id: runs(fresh)[0].id, result: 'ok' })
    await expect(b).resolves.toBe('ok')
  })
})

describe('idle shutdown', () => {
  it('stops the worker after 3 minutes without jobs', async () => {
    vi.useFakeTimers()
    const p = host.runMlJob({ kind: 'check', model: 'isnet' })
    worker().reply({ type: 'result', id: runs(worker())[0].id, result: 1 })
    await p
    vi.advanceTimersByTime(3 * 60_000 - 1)
    expect(worker().killed).toBe(false)
    vi.advanceTimersByTime(1)
    expect(worker().killed).toBe(true)
  })

  it('does not stop the worker while a job is still running', async () => {
    vi.useFakeTimers()
    const a = host.runMlJob({ kind: 'check', model: 'isnet' })
    const b = host.runMlJob({ kind: 'upscale', params: {} as never })
    worker().reply({ type: 'result', id: runs(worker())[0].id, result: 1 })
    await a
    vi.advanceTimersByTime(10 * 60_000)
    expect(worker().killed).toBe(false)
    worker().reply({ type: 'result', id: runs(worker())[1].id, result: 2 })
    await b
  })

  it('a job submitted after the idle shutdown (before the old worker exits) runs on a fresh worker', async () => {
    vi.useFakeTimers()
    const a = host.runMlJob({ kind: 'check', model: 'isnet' })
    worker(0).reply({ type: 'result', id: runs(worker(0))[0].id, result: 1 })
    await a
    vi.advanceTimersByTime(3 * 60_000)
    expect(worker(0).killed).toBe(true)
    const b = host.runMlJob<string>({ kind: 'check', model: 'isnet' })
    b.catch(() => undefined)
    expect(fake.fakeElectron.forks).toHaveLength(2)
    expect(runs(worker(0))).toHaveLength(1)
    worker(0).exit(0)
    worker(1).reply({ type: 'result', id: runs(worker(1))[0].id, result: 'ok' })
    await expect(b).resolves.toBe('ok')
  })

  it('a dying worker cannot answer jobs of its replacement', async () => {
    const a = host.runMlJob({ kind: 'check', model: 'isnet' })
    a.catch(() => undefined)
    host.cancelMlJobs()
    const b = host.runMlJob<string>({ kind: 'check', model: 'isnet' })
    const id = runs(worker(1))[0].id
    worker(0).reply({ type: 'result', id, result: 'stale' })
    worker(1).reply({ type: 'result', id, result: 'fresh' })
    await expect(b).resolves.toBe('fresh')
  })

  it('a new job cancels the pending idle shutdown', async () => {
    vi.useFakeTimers()
    const a = host.runMlJob({ kind: 'check', model: 'isnet' })
    worker().reply({ type: 'result', id: runs(worker())[0].id, result: 1 })
    await a
    vi.advanceTimersByTime(2 * 60_000)
    void host.runMlJob({ kind: 'check', model: 'isnet' })
    vi.advanceTimersByTime(5 * 60_000)
    expect(worker().killed).toBe(false)
    expect(fake.fakeElectron.forks).toHaveLength(1)
  })
})

describe('invalidateMlSession / shutdownMlHost', () => {
  it('invalidate is a no-op when no worker is running (no worker is started)', async () => {
    await host.invalidateMlSession('isnet')
    expect(fake.fakeElectron.forks).toHaveLength(0)
  })

  it('invalidate sends an invalidate job to a running worker', async () => {
    void host.runMlJob({ kind: 'check', model: 'isnet' })
    const p = host.invalidateMlSession('upscale', 'realesrgan-x4plus')
    const inv = runs(worker())[1]
    expect(inv.job).toEqual({ kind: 'invalidate', model: 'upscale', modelId: 'realesrgan-x4plus' })
    worker().reply({ type: 'result', id: inv.id, result: undefined })
    await expect(p).resolves.toBeUndefined()
  })

  it('shutdown kills a running worker and pending jobs reject as cancelled', async () => {
    const a = host.runMlJob({ kind: 'check', model: 'isnet' })
    host.shutdownMlHost()
    expect(worker().killed).toBe(true)
    worker().exit(0)
    await expect(a).rejects.toThrow(/cancelled/)
  })

  it('shutdown without a worker is a no-op', () => {
    expect(() => host.shutdownMlHost()).not.toThrow()
  })
})
