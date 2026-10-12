// Tools driven by real pointer input on the document canvas (page.mouse →
// useCanvas → the tool handler): paint lands where the pointer went, nowhere
// else, and each gesture is one history entry.
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { canvasPoint, frames, historyInfo, inApp, layerPixel, newDocument } from './verve'

const W = 64
const H = 48

/** White document with an empty, active pixel layer "Paint"; primary red. */
async function setup(page: Page, tool: string): Promise<string> {
  await newDocument(page, { width: W, height: H, background: 'white' })
  const id = await inApp(page, async (t) => (await t.automation.newLayer({ name: 'Paint' })).id)
  await inApp(
    page,
    (t, tool) => {
      t.dispatch({ type: 'SET_PRIMARY_COLOR', payload: { r: 255, g: 0, b: 0, a: 1 } })
      t.dispatch({ type: 'SET_TOOL', payload: tool })
    },
    tool
  )
  await frames(page, 2)
  return id
}

/** Fill a rect of the active layer through the automation host (one history entry). */
async function fillRect(page: Page, layerId: string, rect: { x: number; y: number; width: number; height: number }, color: number[]): Promise<void> {
  await inApp(
    page,
    async (t, a) => {
      const l = t.automation.layers({}).find((x) => x.id === a.layerId)!
      await t.automation.selectRect(a.rect, 'set', 0)
      await t.automation.fillLayer(l, a.color)
      await t.automation.deselect()
      await t.automation.setActiveLayer(l)
    },
    { layerId, rect, color }
  )
}

/** Press at `from`, move through `to` in small steps, release (document px). */
async function drag(page: Page, from: [number, number], to: [number, number], steps = 12): Promise<void> {
  const a = await canvasPoint(page, from[0], from[1])
  const b = await canvasPoint(page, to[0], to[1])
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps })
  // Let smoothing stabilizers catch up with the last position.
  await frames(page, 3)
  await page.mouse.up()
  await frames(page, 3)
}

async function click(page: Page, x: number, y: number): Promise<void> {
  const p = await canvasPoint(page, x, y)
  await page.mouse.click(p.x, p.y)
  await frames(page, 3)
}

for (const tool of ['pencil', 'brush'] as const) {
  test(`${tool} paints along the stroke`, async ({ page }) => {
    const layer = await setup(page, tool)
    const h0 = await historyInfo(page)
    await drag(page, [8, 20], [56, 20])

    await expect.poll(async () => (await layerPixel(page, layer, 32, 20))[3]).toBeGreaterThan(200)
    const mid = await layerPixel(page, layer, 32, 20)
    expect(mid[0]).toBeGreaterThan(200)
    expect(mid[1]).toBeLessThan(40)
    expect(mid[2]).toBeLessThan(40)
    // Far from the stroke: untouched.
    expect(await layerPixel(page, layer, 32, 42)).toEqual([0, 0, 0, 0])
    expect(await layerPixel(page, layer, 2, 2)).toEqual([0, 0, 0, 0])

    const h1 = await historyInfo(page)
    expect(h1.count).toBe(h0.count + 1)
    expect(h1.index).toBe(h0.index + 1)

    await inApp(page, (t) => t.menu.onUndo())
    await expect.poll(() => layerPixel(page, layer, 32, 20)).toEqual([0, 0, 0, 0])
  })
}

test('two strokes are two history entries', async ({ page }) => {
  const layer = await setup(page, 'pencil')
  const h0 = await historyInfo(page)
  await drag(page, [8, 10], [56, 10])
  await drag(page, [8, 30], [56, 30])
  expect((await historyInfo(page)).count).toBe(h0.count + 2)
  await inApp(page, (t) => t.menu.onUndo())
  await expect.poll(() => layerPixel(page, layer, 32, 30)).toEqual([0, 0, 0, 0])
  expect((await layerPixel(page, layer, 32, 10))[3]).toBeGreaterThan(200)
})

test('eraser clears along the stroke', async ({ page }) => {
  const layer = await setup(page, 'pencil')
  await fillRect(page, layer, { x: 0, y: 0, width: W, height: H }, [0, 0, 1, 1])
  await inApp(page, (t) => t.dispatch({ type: 'SET_TOOL', payload: 'eraser' }))
  await frames(page, 2)
  const h0 = await historyInfo(page)
  await drag(page, [4, 24], [60, 24])

  await expect.poll(async () => (await layerPixel(page, layer, 32, 24))[3]).toBe(0)
  expect(await layerPixel(page, layer, 32, 2)).toEqual([0, 0, 255, 255])
  expect((await historyInfo(page)).count).toBe(h0.count + 1)
})

test('fill floods the clicked region only', async ({ page }) => {
  const layer = await setup(page, 'fill')
  // A blue square; filling inside it must stop at its edge.
  await fillRect(page, layer, { x: 10, y: 10, width: 20, height: 16 }, [0, 0, 1, 1])
  await inApp(page, (t) => t.dispatch({ type: 'SET_TOOL', payload: 'fill' }))
  await frames(page, 2)
  const h0 = await historyInfo(page)
  await click(page, 20, 18)

  await expect.poll(() => layerPixel(page, layer, 20, 18)).toEqual([255, 0, 0, 255])
  expect(await layerPixel(page, layer, 10, 10)).toEqual([255, 0, 0, 255])
  expect(await layerPixel(page, layer, 29, 25)).toEqual([255, 0, 0, 255])
  expect(await layerPixel(page, layer, 40, 18)).toEqual([0, 0, 0, 0])
  expect(await layerPixel(page, layer, 9, 18)).toEqual([0, 0, 0, 0])
  expect((await historyInfo(page)).count).toBe(h0.count + 1)
})

test('rectangular select drags out a selection', async ({ page }) => {
  await setup(page, 'select')
  await drag(page, [10, 8], [30, 20])
  const bounds = await inApp(page, (t) => t.automation.selectionBounds())
  expect(bounds).not.toBeNull()
  // The drag covers pixels 10..30 / 8..20 (± a pixel for the edge convention).
  expect(Math.abs(bounds!.x - 10)).toBeLessThanOrEqual(1)
  expect(Math.abs(bounds!.y - 8)).toBeLessThanOrEqual(1)
  expect(Math.abs(bounds!.x + bounds!.width - 31)).toBeLessThanOrEqual(1)
  expect(Math.abs(bounds!.y + bounds!.height - 21)).toBeLessThanOrEqual(1)

  // Painting is then confined to the selection.
  const layer = await inApp(page, (t) => t.automation.activeLayer()!.id)
  await inApp(page, (t) => t.dispatch({ type: 'SET_TOOL', payload: 'pencil' }))
  await frames(page, 2)
  await drag(page, [2, 14], [60, 14])
  await expect.poll(async () => (await layerPixel(page, layer, 20, 14))[3]).toBe(255)
  expect(await layerPixel(page, layer, 5, 14)).toEqual([0, 0, 0, 0])
  expect(await layerPixel(page, layer, 45, 14)).toEqual([0, 0, 0, 0])
})

test('move tool drags the layer content', async ({ page }) => {
  const layer = await setup(page, 'move')
  await fillRect(page, layer, { x: 10, y: 10, width: 12, height: 10 }, [0, 0, 1, 1])
  await inApp(page, (t) => t.dispatch({ type: 'SET_TOOL', payload: 'move' }))
  await frames(page, 2)
  const h0 = await historyInfo(page)
  await drag(page, [15, 15], [27, 21])

  // Moved by (+12, +6).
  await expect.poll(() => layerPixel(page, layer, 30, 22)).toEqual([0, 0, 255, 255])
  expect(await layerPixel(page, layer, 12, 12)).toEqual([0, 0, 0, 0])
  expect((await historyInfo(page)).count).toBe(h0.count + 1)

  await inApp(page, (t) => t.menu.onUndo())
  await expect.poll(() => layerPixel(page, layer, 12, 12)).toEqual([0, 0, 255, 255])
})
