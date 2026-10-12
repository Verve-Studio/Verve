// Custom Shader layers that read other layers (Sample Layer by name): the
// other layer is read as it renders, its own effects included, and layers
// sampling each other render without recursing.
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { compositePixel, frames, inApp, newDocument } from './verve'

interface GraphNodeJson {
  id: string
  type: string
  x: number
  y: number
  params: Record<string, unknown>
}

/** A shader graph whose output colour comes from one node (alpha 1). */
function graphFrom(node: Omit<GraphNodeJson, 'x' | 'y'>, port: string): unknown {
  const nodes: GraphNodeJson[] = [
    { ...node, x: 0, y: 0 },
    { id: 'out', type: 'layerOutput', x: 320, y: 0, params: { alpha: 1 } }
  ]
  return {
    id: `g-${node.id}`,
    name: 'Custom Shader',
    domain: 'shader',
    nodes,
    edges: [{ id: 'e1', from: { node: node.id, port }, to: { node: 'out', port: 'color' } }]
  }
}

const solid = (rgba: number[]): unknown => graphFrom({ id: 'c', type: 'color', params: { color: rgba } }, 'color')
const sampling = (layer: string): unknown =>
  graphFrom({ id: 's', type: 'sampleLayer', params: { layer } }, 'color')

/** An empty layer named `name` with a Custom Shader running `graph`. */
async function shaderLayer(page: Page, name: string, graph: unknown): Promise<void> {
  await inApp(
    page,
    async (t, a) => {
      const auto = t.automation
      const layer = await auto.newLayer({ name: a.name })
      const fx = await auto.addEffect({ target: layer, effectType: 'custom-shader', values: {}, bake: false, useSelection: false })
      const state = t.getState().layers.find((l) => l.id === fx.id) as unknown as { params: object }
      t.dispatch({ type: 'UPDATE_ADJUSTMENT_LAYER', payload: { ...state, params: { ...state.params, graph: a.graph } } })
    },
    { name, graph }
  )
  await frames(page, 3)
}

for (const pixelFormat of ['rgba8', 'rgba32f'] as const) {
  test(`Sample Layer reads another layer with its effects (${pixelFormat})`, async ({ page }) => {
    await newDocument(page, { width: 32, height: 24, pixelFormat, background: 'transparent' })
    // A transparent layer that gets its colour only from its shader…
    await shaderLayer(page, 'Source', solid([1, 0, 0, 1]))
    // …read by a layer above it, which covers it completely.
    await shaderLayer(page, 'Reader', sampling('Source'))
    expect(await compositePixel(page, 5, 7)).toEqual([255, 0, 0, 255])
  })
}

test('layers sampling each other render without recursing', async ({ page, log }) => {
  await newDocument(page, { width: 32, height: 24, pixelFormat: 'rgba8', background: 'transparent' })
  await shaderLayer(page, 'A', sampling('B'))
  await shaderLayer(page, 'B', sampling('A'))
  // B (on top) reads A with A's shader, which reads B's raw, transparent
  // pixels where the cycle is cut: black, at the shader's alpha of 1.
  expect(await compositePixel(page, 3, 3)).toEqual([0, 0, 0, 255])
  expect(log.pageErrors).toEqual([])
})

test('the Noise (clouds) node compiles and renders a varied pattern', async ({ page, log }) => {
  await newDocument(page, { width: 64, height: 48, pixelFormat: 'rgba8', background: 'transparent' })
  await shaderLayer(page, 'Clouds', graphFrom({ id: 'n', type: 'noise', params: { scale: 1.5 } }, 'fac'))
  const values = new Set<number>()
  for (const [x, y] of [[2, 2], [20, 9], [40, 30], [60, 44], [11, 37]]) values.add((await compositePixel(page, x, y))[0])
  expect(values.size).toBeGreaterThan(2)
  expect(log.errors.filter((e) => /WGSL|shader|pipeline|validation/i.test(e))).toEqual([])
})

/** Red channel of the composite along row `y`. */
async function row(page: Page, y: number): Promise<number[]> {
  return inApp(
    page,
    async (t, a) => {
      const r = await t.canvas!.rasterizeComposite('sample')
      return Array.from({ length: r.width }, (_, x) => Number(r.data[(a.y * r.width + x) * 4]))
    },
    { y }
  )
}

const roughness = (v: number[]): number => v.slice(1).reduce((s, x, i) => s + Math.abs(x - v[i]), 0) / (v.length - 1)

for (const pixelFormat of ['rgba8', 'rgba32f'] as const) {
  test(`Blur Color blurs a generated pattern on the GPU (${pixelFormat})`, async ({ page, log }) => {
    await newDocument(page, { width: 64, height: 48, pixelFormat, background: 'transparent' })
    const noise = { id: 'n', type: 'noise', x: 0, y: 0, params: { scale: 6 } }
    await shaderLayer(page, 'Sharp', graphFrom(noise, 'color'))
    const sharp = await row(page, 20)
    await inApp(page, async (t) => {
      for (const d of t.automation.documents()) await t.automation.closeDocument(d)
    })
    await newDocument(page, { width: 64, height: 48, pixelFormat, background: 'transparent' })
    await shaderLayer(page, 'Blurred', {
      id: 'g-blur',
      name: 'Custom Shader',
      domain: 'shader',
      nodes: [
        noise,
        { id: 'b', type: 'blurColor', x: 200, y: 0, params: { radius: 6 } },
        { id: 'out', type: 'layerOutput', x: 400, y: 0, params: { alpha: 1 } }
      ],
      edges: [
        { id: 'e1', from: { node: 'n', port: 'color' }, to: { node: 'b', port: 'color' } },
        { id: 'e2', from: { node: 'b', port: 'color' }, to: { node: 'out', port: 'color' } }
      ]
    })
    const blurred = await row(page, 20)
    // Not the passthrough a GPU-rejected shader renders (transparent)…
    expect(new Set(blurred).size).toBeGreaterThan(4)
    // …and much smoother than the same noise unblurred.
    expect(roughness(blurred)).toBeLessThan(roughness(sharp) / 2)
    expect(log.errors.filter((e) => /WGSL|shader|pipeline|validation/i.test(e))).toEqual([])
  })
}
