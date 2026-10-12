// The ML worker's message protocol, with the model modules stubbed out.
import { EventEmitter } from 'node:events'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as Array<[string, unknown[]]>)
const record =
  (name: string, result: (...args: unknown[]) => unknown = () => name) =>
  async (...args: unknown[]) => {
    calls.push([name, args])
    return result(...args)
  }

vi.mock('../../../../electron/main/isnet', () => ({
  checkIsnetModel: record('checkIsnetModel'),
  runIsnet: record('runIsnet', () => {
    throw new Error('rgba length 3 ≠ 1×1×4')
  }),
  invalidateIsnetSession: record('invalidateIsnetSession', () => undefined)
}))
vi.mock('../../../../electron/main/inpaint', () => ({
  checkInpaintModel: record('checkInpaintModel'),
  runInpaint: record('runInpaint'),
  invalidateInpaintSession: record('invalidateInpaintSession', () => undefined)
}))
vi.mock('../../../../electron/main/matting', () => ({
  checkMattingModel: record('checkMattingModel'),
  downloadMattingModel: record('downloadMattingModel', (onProgress) => {
    ;(onProgress as (l: number, t: number) => void)(3, 9)
  }),
  refineMatting: record('refineMatting'),
  invalidateMattingSession: record('invalidateMattingSession', () => undefined)
}))
vi.mock('../../../../electron/main/upscale', () => ({
  checkUpscaleModel: record('checkUpscaleModel'),
  listUpscaleModels: record('listUpscaleModels'),
  runUpscaleJob: record('runUpscaleJob', (_p, onProgress) => {
    ;(onProgress as (l: number, t: number) => void)(1, 2)
    return 'upscaled'
  }),
  invalidateUpscaleSession: record('invalidateUpscaleSession', () => undefined)
}))

import { mlPaths } from '../../../../electron/main/ml/paths'

class FakeParentPort extends EventEmitter {
  readonly posted: Array<Record<string, unknown>> = []
  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message)
  }
  deliver(data: unknown): void {
    this.emit('message', { data })
  }
}

const port = new FakeParentPort()
const hadParentPort = 'parentPort' in process
const proc = process as unknown as { parentPort?: unknown }

beforeAll(async () => {
  proc.parentPort = port
  await import('../../../../electron/main/mlWorker')
})
afterAll(() => {
  if (!hadParentPort) delete proc.parentPort
})
beforeEach(() => {
  calls.length = 0
  port.posted.length = 0
})

/** Send a job and wait for its result / error message. */
async function run(id: number, job: unknown): Promise<Record<string, unknown>> {
  port.deliver({ type: 'run', id, job })
  await vi.waitFor(() => {
    if (!port.posted.some((m) => m.id === id && m.type !== 'progress')) throw new Error('waiting')
  })
  return port.posted.find((m) => m.id === id && m.type !== 'progress')!
}

describe('mlWorker protocol', () => {
  it('init stores the model paths for the model modules', () => {
    const paths = { isPackaged: true, resourcesPath: '/r', userData: '/u', appRoot: '/a' }
    port.deliver({ type: 'init', paths })
    expect(mlPaths()).toEqual(paths)
    expect(port.posted).toEqual([])
  })

  it.each([
    [{ kind: 'check', model: 'isnet' }, 'checkIsnetModel'],
    [{ kind: 'check', model: 'inpaint' }, 'checkInpaintModel'],
    [{ kind: 'check', model: 'matting' }, 'checkMattingModel'],
    [{ kind: 'check', model: 'upscale', modelId: 'm' }, 'checkUpscaleModel'],
    [{ kind: 'list-upscale-models' }, 'listUpscaleModels'],
    [{ kind: 'inpaint', params: { p: 1 } }, 'runInpaint'],
    [{ kind: 'matting', params: { p: 2 } }, 'refineMatting']
  ])('dispatches %j to %s and posts its result', async (job, fn) => {
    const msg = await run(10, job)
    expect(msg).toEqual({ type: 'result', id: 10, result: fn })
    expect(calls.map((c) => c[0])).toEqual([fn])
  })

  it('passes params to the model function', async () => {
    await run(11, { kind: 'inpaint', params: { width: 3 } })
    expect(calls[0][1][0]).toEqual({ width: 3 })
    await run(12, { kind: 'check', model: 'upscale' })
    // A missing model id is passed as an empty string (unknown model).
    expect(calls[1]).toEqual(['checkUpscaleModel', ['']])
  })

  it('posts a failing job as an error message carrying the message text', async () => {
    const msg = await run(20, { kind: 'isnet', params: {} })
    expect(msg).toEqual({ type: 'error', id: 20, message: 'rgba length 3 ≠ 1×1×4' })
  })

  it('reports an unknown job kind as an empty result instead of crashing', async () => {
    const msg = await run(21, { kind: 'bogus' })
    expect(msg).toEqual({ type: 'result', id: 21, result: undefined })
  })

  it('streams upscale progress tagged with the job id before the result', async () => {
    const msg = await run(30, { kind: 'upscale', params: {} })
    expect(port.posted).toEqual([
      { type: 'progress', id: 30, loaded: 1, total: 2 },
      { type: 'result', id: 30, result: 'upscaled' }
    ])
    expect(msg.result).toBe('upscaled')
  })

  it('download-matting streams progress and then drops the matting session', async () => {
    await run(31, { kind: 'download-matting' })
    expect(port.posted[0]).toEqual({ type: 'progress', id: 31, loaded: 3, total: 9 })
    expect(calls.map((c) => c[0])).toEqual(['downloadMattingModel', 'invalidateMattingSession'])
  })

  it.each([
    ['isnet', 'invalidateIsnetSession'],
    ['inpaint', 'invalidateInpaintSession'],
    ['matting', 'invalidateMattingSession'],
    ['upscale', 'invalidateUpscaleSession']
  ])('invalidate %s calls %s', async (model, fn) => {
    await run(40, { kind: 'invalidate', model, modelId: 'x' })
    expect(calls[0][0]).toBe(fn)
    if (model === 'upscale') expect(calls[0][1]).toEqual(['x'])
  })
})
