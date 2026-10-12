// Multiple documents: each tab keeps its own pixels, layers and undo
// history across switches (pixels are serialized when a tab is
// backgrounded and re-uploaded when it comes back), and closing tabs.
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { historyInfo, inApp, newDocument, snapshot } from './verve'

async function paintedDocument(page: Page, name: string, pixelFormat: 'rgba8' | 'rgba32f', color: number[]): Promise<void> {
  await newDocument(page, { width: 40, height: 30, pixelFormat, background: 'white', name })
  await inApp(
    page,
    async (t, c) => {
      const a = t.automation
      const L = await a.newLayer({ name: `${c.name} paint` })
      await a.selectRect({ x: 5, y: 5, width: 20, height: 12 }, 'set', 0)
      await a.fillLayer(L, c.color)
      await a.deselect()
    },
    { name, color }
  )
}

async function activate(page: Page, name: string): Promise<void> {
  await inApp(
    page,
    async (t, n) => {
      const doc = t.automation.documents().find((d) => d.name === n)
      if (!doc) throw new Error(`no document ${n}`)
      await t.automation.activateDocument(doc)
    },
    name
  )
}

test('switching tabs preserves each document', async ({ page }) => {
  await paintedDocument(page, 'One', 'rgba8', [1, 0, 0, 1])
  const one = await snapshot(page)
  const oneHistory = await historyInfo(page)
  await paintedDocument(page, 'Two', 'rgba32f', [0, 0.4, 1, 0.7])
  const two = await snapshot(page)
  const twoHistory = await historyInfo(page)
  await paintedDocument(page, 'Three', 'rgba8', [0, 1, 0, 1])
  const three = await snapshot(page)

  expect(await inApp(page, (t) => t.automation.documents().map((d) => d.name))).toEqual(['One', 'Two', 'Three'])

  for (const [name, snap, hist] of [
    ['One', one, oneHistory],
    ['Two', two, twoHistory],
    ['One', one, oneHistory],
    ['Three', three, null]
  ] as const) {
    await activate(page, name)
    expect(await inApp(page, (t) => t.automation.document().name)).toBe(name)
    await expect.poll(() => snapshot(page), { message: `${name} after switching back` }).toEqual(snap)
    if (hist) expect(await historyInfo(page)).toEqual(hist)
  }
})

test('undo history stays with its document', async ({ page }) => {
  await paintedDocument(page, 'One', 'rgba8', [1, 0, 0, 1])
  const beforeEdit = await snapshot(page)
  await inApp(page, async (t) => {
    const l = t.automation.layers({}).find((x) => x.name === 'One paint')!
    await t.automation.moveLayer(l, 7, 4, true)
  })
  const afterEdit = await snapshot(page)

  await paintedDocument(page, 'Two', 'rgba8', [0, 0, 1, 1])
  const two = await snapshot(page)
  await activate(page, 'One')
  // Undo in One undoes One's move, not Two's paint.
  await inApp(page, (t) => t.menu.onUndo())
  await expect.poll(() => snapshot(page)).toEqual(beforeEdit)

  await activate(page, 'Two')
  await expect.poll(() => snapshot(page)).toEqual(two)
  await activate(page, 'One')
  await expect.poll(() => snapshot(page)).toEqual(beforeEdit)
  await inApp(page, (t) => t.menu.onRedo())
  await expect.poll(() => snapshot(page)).toEqual(afterEdit)
})

test('closing tabs keeps the others intact', async ({ page }) => {
  await paintedDocument(page, 'One', 'rgba8', [1, 0, 0, 1])
  const one = await snapshot(page)
  await paintedDocument(page, 'Two', 'rgba8', [0, 1, 0, 1])
  await paintedDocument(page, 'Three', 'rgba32f', [0, 0, 1, 1])
  const three = await snapshot(page)

  // Close a background tab, then the active one.
  await inApp(page, async (t) => {
    const docs = t.automation.documents()
    await t.automation.closeDocument(docs.find((d) => d.name === 'Two')!)
  })
  expect(await inApp(page, (t) => t.automation.documents().map((d) => d.name))).toEqual(['One', 'Three'])
  await expect.poll(() => snapshot(page)).toEqual(three)

  await inApp(page, async (t) => {
    await t.automation.closeDocument(t.automation.activeDocument()!)
  })
  expect(await inApp(page, (t) => t.automation.documents().map((d) => d.name))).toEqual(['One'])
  expect(await inApp(page, (t) => t.automation.document().name)).toBe('One')
  await expect.poll(() => snapshot(page)).toEqual(one)

  await inApp(page, async (t) => {
    await t.automation.closeDocument(t.automation.activeDocument()!)
  })
  expect(await inApp(page, (t) => t.automation.documents().length)).toBe(0)
  const err = await inApp(page, (t) => {
    try {
      t.automation.document()
      return null
    } catch (e) {
      return (e as Error).message
    }
  })
  expect(err).not.toBeNull()
})
