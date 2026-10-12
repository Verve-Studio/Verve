import { test, expect } from './fixtures'
import { compositePixel, inApp, newDocument } from './verve'

test('starts with a WebGPU device and the test hook', async ({ page }) => {
  expect(await page.evaluate(() => 'gpu' in navigator)).toBe(true)
  const tabs = await inApp(page, (t) => t.automation.documents().length)
  expect(tabs).toBe(0)
})

test('creates a document and renders its background', async ({ page }) => {
  await newDocument(page, { width: 64, height: 48, background: 'white', name: 'E2E' })
  const info = await inApp(page, (t) => t.automation.document())
  expect(info).toMatchObject({ name: 'E2E', width: 64, height: 48, format: 'rgba8' })
  expect(await compositePixel(page, 10, 10)).toEqual([255, 255, 255, 255])
})

for (const pixelFormat of ['rgba8', 'rgba32f'] as const) {
  test(`fills a layer and undoes it (${pixelFormat})`, async ({ page }) => {
    await newDocument(page, { width: 32, height: 32, pixelFormat, background: 'white' })
    await inApp(page, async (t) => {
      const layer = await t.automation.newLayer({ name: 'Paint' })
      await t.automation.fillLayer(layer, [1, 0, 0, 1])
    })
    expect(await compositePixel(page, 5, 5)).toEqual([255, 0, 0, 255])

    await inApp(page, (t) => t.menu.onUndo())
    await expect.poll(() => compositePixel(page, 5, 5)).toEqual([255, 255, 255, 255])

    await inApp(page, (t) => t.menu.onRedo())
    await expect.poll(() => compositePixel(page, 5, 5)).toEqual([255, 0, 0, 255])
  })
}
