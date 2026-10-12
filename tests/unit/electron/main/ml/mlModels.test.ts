// Model lookup and argument validation of the ML modules. Nothing here
// loads onnxruntime or a model: every case is decided before a session is
// created (validation first, then "model not found" with empty folders).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mlPaths, setMlPaths, type MlPaths } from '../../../../../electron/main/ml/paths'
import { checkIsnetModel, runIsnet } from '../../../../../electron/main/isnet'
import { checkInpaintModel, runInpaint } from '../../../../../electron/main/inpaint'
import { checkMattingModel, refineMatting } from '../../../../../electron/main/matting'
import { checkUpscaleModel, invalidateUpscaleSession, listUpscaleModels, runUpscaleJob } from '../../../../../electron/main/upscale'

let root: string
let paths: MlPaths

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verve-ml-'))
  paths = {
    isPackaged: false,
    resourcesPath: join(root, 'resources-packaged'),
    userData: join(root, 'userData'),
    appRoot: join(root, 'app')
  }
  setMlPaths(paths)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function place(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'onnx')
}

describe('ml paths', () => {
  it('throws a clear error before the host sent the paths', async () => {
    vi.resetModules()
    const fresh = await import('../../../../../electron/main/ml/paths')
    expect(() => fresh.mlPaths()).toThrow('ML model paths have not been initialised')
  })

  it('returns what was set', () => {
    expect(mlPaths()).toBe(paths)
  })
})

describe.each([
  ['isnet', checkIsnetModel, 'isnet', 'isnet-general-use.onnx'],
  ['inpaint', checkInpaintModel, 'lama', 'lama_fp32.onnx'],
  ['matting', checkMattingModel, 'rvm', 'rvm_mobilenetv3_fp32.onnx']
] as const)('%s model lookup', (_name, check, folder, file) => {
  const userPath = () => join(paths.userData, 'models', folder, file)
  const devPath = () => join(paths.appRoot, 'resources', 'models', folder, file)
  const packagedPath = () => join(paths.resourcesPath, 'models', folder, file)

  it('is not ready when no model file exists', async () => {
    const r = await check()
    expect(r.ready).toBe(false)
    expect(r.path).toBeNull()
    if ('searchedPaths' in r) expect(r.searchedPaths).toEqual([userPath(), devPath()])
  })

  it('finds the bundled model in development', async () => {
    place(devPath())
    expect(await check()).toMatchObject({ ready: true, path: devPath() })
  })

  it('finds the bundled model under resourcesPath when packaged', async () => {
    setMlPaths({ ...paths, isPackaged: true })
    place(packagedPath())
    expect(await check()).toMatchObject({ ready: true, path: packagedPath() })
  })

  it('prefers a model in userData over the bundled one', async () => {
    place(devPath())
    place(userPath())
    expect(await check()).toMatchObject({ ready: true, path: userPath() })
  })
})

describe('upscale model lookup', () => {
  it('lists the models with id, label and scale only', () => {
    const models = listUpscaleModels()
    expect(models.length).toBeGreaterThan(0)
    for (const m of models) {
      expect(Object.keys(m).sort()).toEqual(['id', 'label', 'scale'])
      expect(m.scale).toBeGreaterThan(1)
    }
    expect(new Set(models.map((m) => m.id)).size).toBe(models.length)
  })

  it('checks a known model in userData then the bundled folder', async () => {
    const r = await checkUpscaleModel('realesr-general-x4v3')
    expect(r).toEqual({
      ready: false,
      path: null,
      searchedPaths: [
        join(paths.userData, 'models', 'realesrgan', 'realesr-general-x4v3.onnx'),
        join(paths.appRoot, 'resources', 'models', 'realesrgan', 'realesr-general-x4v3.onnx')
      ]
    })
    place(r.searchedPaths[1])
    expect((await checkUpscaleModel('realesr-general-x4v3')).ready).toBe(true)
  })

  it.each(['', 'nope', '../../../etc/passwd', 'realesr-general-x4v3.onnx'])(
    'reports an unknown model id (%j) as not ready without touching the filesystem',
    async (id) => {
      expect(await checkUpscaleModel(id)).toEqual({ ready: false, path: null, searchedPaths: [] })
    }
  )

  it('invalidating a model that was never loaded is a no-op', async () => {
    await expect(invalidateUpscaleSession('realesr-general-x4v3')).resolves.toBeUndefined()
    await expect(invalidateUpscaleSession()).resolves.toBeUndefined()
  })
})

describe('runIsnet validation', () => {
  it('rejects an rgba buffer that does not match the size', async () => {
    await expect(runIsnet({ rgba: new Uint8Array(15), width: 2, height: 2 })).rejects.toThrow(
      'rgba length 15 ≠ 2×2×4'
    )
  })

  it('reports a missing model with the folders to put it in', async () => {
    const err = await runIsnet({ rgba: new Uint8Array(16), width: 2, height: 2 }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('isnet-general-use.onnx" not found')
    expect((err as Error).message).toContain(join(paths.userData, 'models', 'isnet'))
  })
})

describe('runInpaint validation', () => {
  it('rejects an rgba buffer that does not match the size', async () => {
    await expect(
      runInpaint({ rgba: new Uint8Array(4), mask: new Uint8Array(4), width: 2, height: 2 })
    ).rejects.toThrow('rgba length 4 ≠ 2×2×4')
  })

  it('rejects a mask that does not match the size', async () => {
    await expect(
      runInpaint({ rgba: new Uint8Array(16), mask: new Uint8Array(3), width: 2, height: 2 })
    ).rejects.toThrow('mask length 3 ≠ 2×2')
  })
})

describe('refineMatting validation', () => {
  const base = { width: 2, height: 2, bandRadius: 1, mode: 'hair' as const }

  it('rejects an image buffer that does not match the size', async () => {
    await expect(
      refineMatting({ ...base, imageRgba: new Uint8Array(4), selectionMask: new Uint8Array(4) })
    ).rejects.toThrow('imageRgba length 4 ≠ 2×2×4')
  })

  it('rejects a selection mask that does not match the size', async () => {
    await expect(
      refineMatting({ ...base, imageRgba: new Uint8Array(16), selectionMask: new Uint8Array(5) })
    ).rejects.toThrow('selectionMask length 5 ≠ 2×2')
  })

  it('reports a missing model', async () => {
    await expect(
      refineMatting({ ...base, imageRgba: new Uint8Array(16), selectionMask: new Uint8Array(4) })
    ).rejects.toThrow('RVM model file not found')
  })
})

// The renderer's sizes arrive over IPC: a length check alone accepts e.g.
// -1 × -1 with a 4-byte buffer ((-1)·(-1)·4 = 4).
const badSizes: Array<[string, number, number, number]> = [
  ['-1 × -1 with a matching product', -1, -1, 4],
  ['zero width', 0, 2, 0],
  ['fractional size', 1.5, 2, 12],
  ['NaN height', 2, Number.NaN, 0],
  ['infinite width', Number.POSITIVE_INFINITY, 1, 4],
  ['oversized side', 32769, 1, 32769 * 4],
  ['string size', '1' as unknown as number, 1, 4]
]

describe('image size validation (isnet / inpaint / matting)', () => {
  it.each(badSizes)('runIsnet rejects %s', async (_label, width, height, len) => {
    await expect(runIsnet({ rgba: new Uint8Array(len), width, height })).rejects.toThrow(
      /Invalid image size/
    )
  })

  it.each(badSizes)('runInpaint rejects %s', async (_label, width, height, len) => {
    await expect(
      runInpaint({ rgba: new Uint8Array(len), mask: new Uint8Array(len / 4), width, height })
    ).rejects.toThrow(/Invalid image size/)
  })

  it.each(badSizes)('refineMatting rejects %s', async (_label, width, height, len) => {
    await expect(
      refineMatting({
        imageRgba: new Uint8Array(len),
        selectionMask: new Uint8Array(len / 4),
        width,
        height,
        bandRadius: 1,
        mode: 'hair'
      })
    ).rejects.toThrow(/Invalid image size/)
  })

  it('rejects buffers that are not Uint8Arrays', async () => {
    const fake = { length: 4 } as unknown as Uint8Array
    await expect(runIsnet({ rgba: fake, width: 1, height: 1 })).rejects.toThrow(
      'rgba must be a Uint8Array'
    )
    await expect(
      runInpaint({ rgba: new Uint8Array(4), mask: [0] as unknown as Uint8Array, width: 1, height: 1 })
    ).rejects.toThrow('mask must be a Uint8Array')
  })

  it.each([
    ['negative band radius', { bandRadius: -1 }, /Invalid band radius/],
    ['NaN band radius', { bandRadius: Number.NaN }, /Invalid band radius/],
    ['unknown mode', { mode: 'evil' as 'hair' }, /Invalid matting mode/]
  ])('refineMatting rejects %s', async (_label, patch, message) => {
    await expect(
      refineMatting({
        imageRgba: new Uint8Array(16),
        selectionMask: new Uint8Array(4),
        width: 2,
        height: 2,
        bandRadius: 1,
        mode: 'hair',
        ...patch
      })
    ).rejects.toThrow(message)
  })

  it('accepts the maximum side length (and then checks the buffer)', async () => {
    await expect(runIsnet({ rgba: new Uint8Array(4), width: 32768, height: 1 })).rejects.toThrow(
      'rgba length 4 ≠ 32768×1×4'
    )
  })
})

describe('runUpscaleJob validation', () => {
  const ok = {
    rgba: new Uint8Array(16),
    width: 2,
    height: 2,
    modelId: 'realesr-general-x4v3',
    targetWidth: 8,
    targetHeight: 8
  }
  const noProgress = (): void => undefined

  it('rejects an unknown model', async () => {
    await expect(runUpscaleJob({ ...ok, modelId: 'evil' }, noProgress)).rejects.toThrow(
      'Unknown upscale model: evil'
    )
  })

  it.each([
    ['zero width', { width: 0 }],
    ['negative height', { height: -2 }],
    ['fractional width', { width: 1.5 }],
    ['NaN height', { height: Number.NaN }],
    ['infinite target', { targetWidth: Number.POSITIVE_INFINITY }],
    ['oversized source', { width: 32769 }],
    ['oversized target', { targetHeight: 32769 }],
    ['string size', { width: '2' as unknown as number }],
    ['-1 × -1 with a matching product', { width: -1, height: -1, rgba: new Uint8Array(4) }]
  ])('rejects %s before allocating anything', async (_label, patch) => {
    await expect(runUpscaleJob({ ...ok, ...patch }, noProgress)).rejects.toThrow(/Invalid upscale size/)
  })

  it('accepts the maximum side length (and then checks the buffer)', async () => {
    await expect(
      runUpscaleJob({ ...ok, width: 32768, height: 1, targetWidth: 32768, targetHeight: 1 }, noProgress)
    ).rejects.toThrow('rgba length 16 ≠ 32768×1×4')
  })

  it('rejects an rgba buffer that does not match the size', async () => {
    await expect(runUpscaleJob({ ...ok, rgba: new Uint8Array(15) }, noProgress)).rejects.toThrow(
      'rgba length 15 ≠ 2×2×4'
    )
  })

  it('reports a missing model file', async () => {
    await expect(runUpscaleJob(ok, noProgress)).rejects.toThrow(/not found|Place it/i)
  })
})
