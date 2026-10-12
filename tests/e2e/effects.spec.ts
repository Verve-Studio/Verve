// Every registered effect (adjustments, effects, filters) applied on an
// rgba8 and an rgba32f document, with its default params and then with a
// sweep of non-default params (every enum option, numbers across their
// range): its pipelines must compile and validate (no GPU / WGSL errors in
// the console), the composite must stay finite, and baking it (rasterize,
// the unified rasterization pipeline) must work.
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import type { EffectInfo } from './verve'
import { frames, inApp, newDocument, paintPattern } from './verve'

/** Console errors from the GPU device (uncaptured validation errors, shader
 *  compilation) or the render loop. */
const GPU_ERROR = /GpuDevice|WGSL|WebGPU|pipeline|shader|validation|GPUValidationError|Invalid|render/i

/** At most this many param variants per effect. */
const MAX_VARIANTS = 8

type Values = Record<string, unknown>

/** Non-default param sets that, together, use every enum option and move
 *  every bounded number / bool / colour away from its default. */
function variants(effect: EffectInfo): Values[] {
  const enumSizes = effect.fields.map((f) => (f.spec.kind === 'enum' ? (f.spec.options?.length ?? 0) : 0))
  const n = Math.min(MAX_VARIANTS, Math.max(2, ...enumSizes))
  const out: Values[] = []
  for (let k = 0; k < n; k++) {
    const v: Values = {}
    for (const f of effect.fields) {
      const { kind, min, max, options } = f.spec
      if ((kind === 'float' || kind === 'int') && min !== undefined && max !== undefined) {
        const x = min + (k % 2 === 0 ? 0.7 : 0.3) * (max - min)
        v[f.id] = kind === 'int' ? Math.round(x) : x
      } else if (kind === 'bool') {
        v[f.id] = k % 2 === 0
      } else if (kind === 'enum' && options?.length) {
        v[f.id] = options[k % options.length].value
      } else if (kind === 'color') {
        v[f.id] = k % 2 === 0 ? [0.85, 0.3, 0.1, 1] : [0.1, 0.55, 0.9, 1]
      }
    }
    out.push(v)
  }
  return out
}

interface EffectRun {
  problem: string | null
  /** Default params left the composite unchanged (identity defaults). */
  unchanged: boolean
}

// One Electron instance runs every effect for a format (a launch per effect
// would take minutes); each effect gets a fresh document.
for (const pixelFormat of ['rgba8', 'rgba32f'] as const) {
  test(`every effect renders and rasterizes (${pixelFormat})`, async ({ page, log }) => {
    test.setTimeout(300_000)
    const effects = await inApp(page, (t) => t.effects())
    expect(effects.length).toBeGreaterThan(40)

    const failures: string[] = []
    const unchangedIds: string[] = []
    for (const effect of effects) {
      const errorsBefore = log.errors.length
      const pageErrorsBefore = log.pageErrors.length
      let problem: string | null = null
      try {
        const r = await runEffect(page, effect, pixelFormat)
        problem = r.problem
        if (r.unchanged) unchangedIds.push(effect.id)
      } catch (err) {
        problem = `threw: ${(err as Error).message}`
      }
      // GPU validation errors are reported asynchronously.
      await frames(page, 2)
      const newErrors = log.errors.slice(errorsBefore).filter((e) => GPU_ERROR.test(e))
      const newPageErrors = log.pageErrors.slice(pageErrorsBefore)
      const parts = [
        problem,
        ...newErrors.map((e) => `console: ${e.slice(0, 300)}`),
        ...newPageErrors.map((e) => `uncaught: ${e.slice(0, 300)}`)
      ].filter(Boolean)
      if (parts.length) failures.push(`${effect.id} (${effect.root}): ${parts.join(' | ')}`)
      // Reported above, per effect; keep the fixture from failing on them again.
      log.pageErrors.splice(pageErrorsBefore)
    }
    // Informational: effects whose default params are an identity.
    test.info().annotations.push({ type: 'unchanged-by-defaults', description: unchangedIds.join(', ') || 'none' })
    expect(failures, `effects failing on ${pixelFormat}`).toEqual([])
  })
}

// Self-check of the detection above: a shader that fails to compile must
// show up as a console error the sweep catches.
test('reports an effect whose WGSL does not compile', async ({ page, log }) => {
  await page.evaluate(`(() => {
    const create = GPUDevice.prototype.createShaderModule
    GPUDevice.prototype.createShaderModule = function (desc) {
      if (desc.code.includes('struct VignetteParams')) desc = { ...desc, code: desc.code + ' fn broken( {' }
      return create.call(this, desc)
    }
  })()`)
  const vignette = (await inApp(page, (t) => t.effects())).find((e) => e.id === 'vignette')!
  await runEffect(page, vignette, 'rgba8').catch(() => {})
  await expect.poll(async () => {
    await frames(page, 1)
    return log.errors.filter((e) => GPU_ERROR.test(e)).length
  }).toBeGreaterThan(0)
  log.pageErrors.length = 0
})

/** Applies one effect on a fresh document, sweeps its params, rasterizes. */
async function runEffect(page: Page, effect: EffectInfo, pixelFormat: 'rgba8' | 'rgba32f'): Promise<EffectRun> {
  await inApp(page, async (t) => {
    for (const d of t.automation.documents()) await t.automation.closeDocument(d)
  })
  await newDocument(page, { width: 48, height: 40, pixelFormat, background: 'transparent', name: effect.id })
  const layerId = await inApp(page, async (t) => (await t.automation.newLayer({ name: 'Content' })).id)
  await paintPattern(page, layerId)
  return inApp(
    page,
    async (t, a): Promise<EffectRun> => {
      const auto = t.automation
      let unchanged = false
      const fail = (problem: string): EffectRun => ({ problem, unchanged })
      const nextFrames = (): Promise<unknown> =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const check = (data: Uint8Array | Float32Array, w: number, h: number, what: string): string | null => {
        if (data.length !== w * h * 4) return `${what}: wrong size ${data.length}`
        if (data instanceof Float32Array) {
          for (let i = 0; i < data.length; i++) {
            if (!Number.isFinite(data[i])) return `${what}: non-finite value at pixel ${(i / 4) | 0}`
          }
        }
        return null
      }

      const layer = auto.layers({}).find((l) => l.id === a.layerId)!
      const before = await t.canvas!.rasterizeComposite('sample')
      const fx = await auto.addEffect({ target: layer, effectType: a.id, values: {}, bake: false, useSelection: false })
      const props = auto.layerProperties(fx)
      if (props.kind !== 'effect' || props.effectType !== a.id) return fail(`added layer is ${props.kind}/${props.effectType}`)

      // Screen render, then the rasterization pipeline.
      await nextFrames()
      const comp = await t.canvas!.rasterizeComposite('sample')
      const bad = check(comp.data, comp.width, comp.height, 'defaults')
      if (bad) return fail(bad)
      const tol = comp.data instanceof Float32Array ? 1e-4 : 0
      unchanged = !comp.data.some((v, i) => Math.abs(v - before.data[i]) > tol)

      for (let k = 0; k < a.variants.length; k++) {
        try {
          await auto.setEffectValues(fx, a.variants[k])
        } catch (err) {
          return fail(`setEffectValues ${JSON.stringify(a.variants[k])}: ${(err as Error).message}`)
        }
        await nextFrames()
        const r = await t.canvas!.rasterizeComposite('sample')
        const badV = check(r.data, r.width, r.height, `variant ${JSON.stringify(a.variants[k])}`)
        if (badV) return fail(badV)
      }

      const baked = await auto.rasterizeLayer(layer)
      const bakedProps = auto.layerProperties(baked)
      if (bakedProps.kind !== 'pixel') return fail(`rasterized layer is ${bakedProps.kind}`)
      if (auto.layers({ attachments: true, recursive: true }).some((l) => auto.layerProperties(l).kind === 'effect')) {
        return fail('effect layer left behind after rasterize')
      }
      const raw = t.canvas!.getLayerCanvasData(baked.id)
      if (!raw) return fail('rasterized layer has no pixels')
      const { width, height } = t.getState().canvas
      const bad2 = check(raw, width, height, 'rasterized')
      if (bad2) return fail(bad2)
      return { problem: null, unchanged }
    },
    { id: effect.id, layerId, variants: variants(effect) }
  )
}
