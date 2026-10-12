// Layer and image operations through the automation host (the same commands
// the menus use), each checked with an undo / redo round trip: undo must
// restore the layer stack, every layer's pixels and the composite exactly,
// and redo must bring back the result.
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import type { VerveTestHook } from './verve'
import { inApp, newDocument, snapshot } from './verve'

type Format = 'rgba8' | 'rgba32f' | 'indexed8'

/** Background + two overlapping pixel layers "A" (red) and "B" (blue, 80%). */
async function setup(page: Page, pixelFormat: Format = 'rgba8'): Promise<void> {
  await newDocument(page, { width: 40, height: 32, pixelFormat, background: 'white' })
  await inApp(page, async (t) => {
    const a = t.automation
    const A = await a.newLayer({ name: 'A' })
    await a.selectRect({ x: 4, y: 4, width: 16, height: 12 }, 'set', 0)
    await a.fillLayer(A, [1, 0, 0, 1])
    const B = await a.newLayer({ name: 'B' })
    await a.selectRect({ x: 14, y: 10, width: 16, height: 14 }, 'set', 0)
    await a.fillLayer(B, [0, 0, 1, 0.8])
    await a.deselect()
  })
}

/** Runs `action`, then checks undo restores the state before it and redo
 *  the state after it. */
async function roundTrip(page: Page, action: (t: VerveTestHook) => Promise<unknown>): Promise<void> {
  const before = await snapshot(page)
  expect(before).not.toBeNull()
  await inApp(page, action)
  const after = await snapshot(page)
  expect(after, 'the action changed nothing').not.toEqual(before)

  await inApp(page, (t) => t.menu.onUndo())
  await expect.poll(() => snapshot(page), { message: 'undo restores the document' }).toEqual(before)
  await inApp(page, (t) => t.menu.onRedo())
  await expect.poll(() => snapshot(page), { message: 'redo re-applies the action' }).toEqual(after)
}

interface Case {
  name: string
  format?: Format
  /** Extra setup (not part of the round trip). */
  prepare?: (t: VerveTestHook) => Promise<unknown>
  action: (t: VerveTestHook) => Promise<unknown>
}

// Actions run in the renderer: each is self-contained (no closures).
const cases: Case[] = [
  { name: 'new layer', action: (t) => t.automation.newLayer({ name: 'New' }) },
  {
    name: 'duplicate layer',
    action: (t) => t.automation.duplicateLayer(t.automation.layers({}).find((l) => l.name === 'B')!, 'B copy')
  },
  {
    name: 'delete layer',
    action: (t) => t.automation.deleteLayer(t.automation.layers({}).find((l) => l.name === 'B')!)
  },
  {
    name: 'group layers',
    action: (t) => {
      const ls = t.automation.layers({}).filter((l) => l.name === 'A' || l.name === 'B')
      return t.automation.groupLayers(ls, { name: 'G', kind: 'group' })
    }
  },
  {
    name: 'ungroup layers',
    prepare: (t) => {
      const ls = t.automation.layers({}).filter((l) => l.name === 'A' || l.name === 'B')
      return t.automation.groupLayers(ls, { name: 'G', kind: 'group' })
    },
    action: (t) => t.automation.ungroupLayers(t.automation.layers({}).find((l) => l.name === 'G')!)
  },
  {
    name: 'merge down',
    action: (t) => t.automation.mergeDown(t.automation.layers({}).find((l) => l.name === 'B')!)
  },
  { name: 'merge visible', action: (t) => t.automation.mergeVisible() },
  { name: 'flatten image', action: (t) => t.automation.flattenImage() },
  { name: 'flatten image (rgba32f)', format: 'rgba32f', action: (t) => t.automation.flattenImage() },
  {
    name: 'move layer',
    action: (t) => t.automation.moveLayer(t.automation.layers({}).find((l) => l.name === 'B')!, 3, -2, true)
  },
  {
    name: 'layer opacity',
    action: (t) => t.automation.setLayerProperties(t.automation.layers({}).find((l) => l.name === 'B')!, { opacity: 0.35 })
  },
  {
    name: 'layer blend mode',
    action: (t) =>
      t.automation.setLayerProperties(t.automation.layers({}).find((l) => l.name === 'B')!, { blendMode: 'multiply' })
  },
  {
    name: 'layer visibility',
    action: (t) => t.automation.setLayerProperties(t.automation.layers({}).find((l) => l.name === 'A')!, { visible: false })
  },
  {
    name: 'arrange layers',
    action: (t) => t.automation.arrangeLayers([t.automation.layers({}).find((l) => l.name === 'B')!], 'backward')
  },
  {
    name: 'layer mask from selection',
    prepare: (t) => t.automation.selectRect({ x: 0, y: 0, width: 22, height: 32 }, 'set', 0),
    action: (t) => t.automation.addLayerMask(t.automation.layers({}).find((l) => l.name === 'B')!, true)
  },
  {
    name: 'rotate layer 90°',
    action: (t) => t.automation.rotateLayers([t.automation.layers({}).find((l) => l.name === 'B')!], '90cw')
  },
  {
    name: 'flip layer',
    action: (t) => t.automation.flipLayers([t.automation.layers({}).find((l) => l.name === 'A')!], 'horizontal')
  },
  { name: 'rotate image 90°', action: (t) => t.automation.rotateImage('90cw') },
  { name: 'flip image', action: (t) => t.automation.flipImage('vertical') },
  { name: 'resize image', action: (t) => t.automation.resizeImage(60, 48, 'bilinear') },
  { name: 'resize image (rgba32f)', format: 'rgba32f', action: (t) => t.automation.resizeImage(20, 16, 'nearest') },
  { name: 'resize canvas', action: (t) => t.automation.resizeCanvas(50, 40, { col: 1, row: 1 }) },
  { name: 'crop', action: (t) => t.automation.cropImage({ x: 5, y: 3, width: 24, height: 20 }) },
  { name: 'convert rgba8 → rgba32f', action: (t) => t.automation.convertColorMode('rgba32f') },
  { name: 'convert rgba32f → rgba8', format: 'rgba32f', action: (t) => t.automation.convertColorMode('rgba8') },
  { name: 'convert rgba8 → indexed8', action: (t) => t.automation.convertColorMode('indexed8') },
  { name: 'convert indexed8 → rgba8', format: 'indexed8', action: (t) => t.automation.convertColorMode('rgba8') },
  {
    name: 'add effect layer',
    action: (t) =>
      t.automation.addEffect({
        target: t.automation.layers({}).find((l) => l.name === 'B')!,
        effectType: 'gaussian-blur',
        values: {},
        bake: false,
        useSelection: false
      })
  },
  {
    name: 'rasterize effect',
    prepare: (t) =>
      t.automation.addEffect({
        target: t.automation.layers({}).find((l) => l.name === 'B')!,
        effectType: 'color-invert',
        values: {},
        bake: false,
        useSelection: false
      }),
    action: (t) => t.automation.rasterizeLayer(t.automation.layers({}).find((l) => l.name === 'B')!)
  }
]

for (const c of cases) {
  test(`${c.name}: undo / redo round trip`, async ({ page }) => {
    await setup(page, c.format)
    if (c.prepare) await inApp(page, c.prepare)
    await roundTrip(page, c.action)
  })
}

test('several operations undo back to the start, one step each', async ({ page }) => {
  await setup(page)
  const steps: ((t: VerveTestHook) => Promise<unknown>)[] = [
    (t) => t.automation.moveLayer(t.automation.layers({}).find((l) => l.name === 'B')!, -2, 1, true),
    (t) => t.automation.setLayerProperties(t.automation.layers({}).find((l) => l.name === 'A')!, { opacity: 0.5 }),
    (t) => t.automation.duplicateLayer(t.automation.layers({}).find((l) => l.name === 'A')!, 'A2'),
    (t) => t.automation.mergeDown(t.automation.layers({}).find((l) => l.name === 'B')!)
  ]
  const states = [await snapshot(page)]
  for (const step of steps) {
    await inApp(page, step)
    states.push(await snapshot(page))
  }
  for (let i = states.length - 2; i >= 0; i--) {
    await inApp(page, (t) => t.menu.onUndo())
    await expect.poll(() => snapshot(page), { message: `undo to step ${i}` }).toEqual(states[i])
  }
  for (let i = 1; i < states.length; i++) {
    await inApp(page, (t) => t.menu.onRedo())
    await expect.poll(() => snapshot(page), { message: `redo to step ${i}` }).toEqual(states[i])
  }
})
