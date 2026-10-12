// Saving and exporting through the real main-process file IPC (atomic
// writes, the fileAccess extension allowlist) and opening the result again.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import type { DocSnapshot } from './verve'
import { inApp, newDocument, paintPattern, snapshot } from './verve'

const W = 32
const H = 24

interface Composite {
  float: boolean
  width: number
  height: number
  data: number[]
}

async function composite(page: Page): Promise<Composite> {
  return inApp(page, async (t) => {
    const r = await t.canvas!.rasterizeComposite('sample')
    return { float: r.data instanceof Float32Array, width: r.width, height: r.height, data: Array.from(r.data) }
  })
}

/** Document with a transparent background and one patterned layer (colour
 *  gradients, a hard block, a half-transparent band at the bottom). */
async function patternDocument(page: Page, pixelFormat: 'rgba8' | 'rgba32f'): Promise<void> {
  await newDocument(page, { width: W, height: H, pixelFormat, background: 'transparent', name: 'Source' })
  const id = await inApp(page, async (t) => (await t.automation.newLayer({ name: 'Pattern' })).id)
  await paintPattern(page, id)
}

async function closeAll(page: Page): Promise<void> {
  await inApp(page, async (t) => {
    for (const d of t.automation.documents()) await t.automation.closeDocument(d)
  })
}

/** Snapshot without the parts a reload may legitimately renumber. */
function comparable(s: DocSnapshot | null): unknown {
  if (!s) return s
  return { ...s, layers: JSON.parse(s.layers) }
}

test.describe('.verve documents', () => {
  for (const pixelFormat of ['rgba8', 'rgba32f', 'indexed8'] as const) {
    test(`save and reopen preserves layers and pixels (${pixelFormat})`, async ({ page, workDir }) => {
      await newDocument(page, { width: W, height: H, pixelFormat, background: 'white', name: 'Doc' })
      await inApp(page, async (t) => {
        const a = t.automation
        const A = await a.newLayer({ name: 'A' })
        await a.selectRect({ x: 2, y: 3, width: 14, height: 10 }, 'set', 0)
        await a.fillLayer(A, [1, 0, 0, 1])
        const B = await a.newLayer({ name: 'B' })
        await a.selectRect({ x: 10, y: 8, width: 15, height: 12 }, 'set', 0)
        await a.fillLayer(B, [0, 0.5, 1, 0.75])
        await a.setLayerProperties(B, { opacity: 0.6, blendMode: 'multiply' })
        await a.selectRect({ x: 0, y: 0, width: 20, height: 24 }, 'set', 0)
        await a.addLayerMask(B, true)
        await a.deselect()
        await a.groupLayers([A, B], { name: 'Group', kind: 'group' })
        const C = await a.newLayer({ name: 'C' })
        await a.selectRect({ x: 20, y: 1, width: 8, height: 8 }, 'set', 0)
        await a.fillLayer(C, [0.2, 0.9, 0.3, 1])
        await a.deselect()
        await a.moveLayer(C, 2, 3, true)
      })
      if (pixelFormat !== 'indexed8') {
        await inApp(page, async (t) => {
          const C = t.automation.layers({}).find((l) => l.name === 'C')!
          await t.automation.addEffect({ target: C, effectType: 'hue-saturation', values: {}, bake: false, useSelection: false })
        })
      }
      const before = await snapshot(page)
      const path = join(workDir, 'doc.verve')
      await inApp(page, (t, p) => t.automation.saveDocument(p), path)
      expect(statSync(path).size).toBeGreaterThan(0)
      expect(await inApp(page, (t) => t.automation.document())).toMatchObject({ path, dirty: false })

      await closeAll(page)
      await inApp(page, (t, p) => t.automation.openDocument(p), path)
      expect(await inApp(page, (t) => t.automation.document())).toMatchObject({
        name: expect.stringMatching(/doc/i),
        width: W,
        height: H,
        format: pixelFormat,
        dirty: false
      })
      await expect.poll(async () => comparable(await snapshot(page))).toEqual(comparable(before))
    })
  }

  test('save a copy leaves the document attached to its own file', async ({ page, workDir }) => {
    await patternDocument(page, 'rgba8')
    const main = join(workDir, 'main.verve')
    const copy = join(workDir, 'copy.verve')
    await inApp(page, (t, p) => t.automation.saveDocument(p), main)
    await inApp(page, (t, p) => t.automation.saveDocument(p, true), copy)
    expect(existsSync(copy)).toBe(true)
    expect(await inApp(page, (t) => t.automation.document().path)).toBe(main)
    const before = await composite(page)
    await inApp(page, (t, p) => t.automation.openDocument(p), copy)
    expect(await inApp(page, (t) => t.automation.documents().length)).toBe(2)
    expect(await composite(page)).toEqual(before)
  })

  test('refuses to save to a non-.verve path', async ({ page, workDir }) => {
    await patternDocument(page, 'rgba8')
    const err = await inApp(
      page,
      (t, p) => t.automation.saveDocument(p).then(() => null, (e: Error) => e.message),
      join(workDir, 'evil.exe')
    )
    expect(err).not.toBeNull()
    expect(existsSync(join(workDir, 'evil.exe'))).toBe(false)
  })
})

interface ExportCase {
  format: string
  ext: string
  doc: 'rgba8' | 'rgba32f'
  /** Max per-channel difference after reopening (0 = lossless). */
  tolerance: number
  /** Block-compressed: `tolerance` bounds the mean difference, not the max
   *  (the pattern's per-pixel noise is hostile to 4×4 blocks). */
  lossy?: boolean
  /** Format has no alpha: compare RGB on the opaque rows only. */
  opaqueOnly?: boolean
  settings?: Record<string, unknown>
}

const exportCases: ExportCase[] = [
  { format: 'png', ext: 'png', doc: 'rgba8', tolerance: 0 },
  { format: 'tga', ext: 'tga', doc: 'rgba8', tolerance: 0 },
  { format: 'tiff', ext: 'tiff', doc: 'rgba8', tolerance: 0 },
  { format: 'psd', ext: 'psd', doc: 'rgba8', tolerance: 0 },
  { format: 'webp', ext: 'webp', doc: 'rgba8', tolerance: 40 / 255, settings: { webpQuality: 100 } },
  { format: 'jpeg', ext: 'jpg', doc: 'rgba8', tolerance: 40 / 255, opaqueOnly: true, settings: { jpegQuality: 100 } },
  { format: 'dds', ext: 'dds', doc: 'rgba8', tolerance: 0.03, lossy: true, settings: { ddsCompression: 'bc7' } },
  {
    format: 'png',
    ext: 'png',
    doc: 'rgba32f',
    tolerance: 1 / 255 + 1e-6,
    opaqueOnly: true,
    settings: { toneMapping: { operator: 'clamp', exposureEV: 0 } }
  },
  { format: 'exr', ext: 'exr', doc: 'rgba32f', tolerance: 0 },
  { format: 'exr', ext: 'exr', doc: 'rgba32f', tolerance: 0, settings: { exrCompression: 1 } },
  { format: 'exr', ext: 'exr', doc: 'rgba32f', tolerance: 1e-3, settings: { exrHalfFloat: true, exrCompression: 3 } },
  { format: 'tiff32', ext: 'tiff', doc: 'rgba32f', tolerance: 0 },
  { format: 'dds', ext: 'dds', doc: 'rgba32f', tolerance: 0, settings: { ddsCompression: 'rgba32f' } },
  { format: 'hdr', ext: 'hdr', doc: 'rgba32f', tolerance: 0.02, opaqueOnly: true }
]

test.describe('export and reopen', () => {
  for (const c of exportCases) {
    const label = `${c.format} from ${c.doc}${c.settings ? ` ${JSON.stringify(c.settings)}` : ''}`
    test(`${label}${c.opaqueOnly ? ' (opaque pixels)' : ''}`, async ({ page, workDir }) => {
      await patternDocument(page, c.doc)
      const src = await composite(page)
      const filePath = join(workDir, `out.${c.ext}`)
      await inApp(
        page,
        (t, s) =>
          t.automation.exportImage({
            format: 'png',
            jpegQuality: 92,
            jpegBackground: '#ffffff',
            webpQuality: 90,
            exrCompression: 0,
            exrHalfFloat: false,
            ddsCompression: 'bc7',
            ddsMipLevels: 1,
            layerMode: 'single',
            ...(s as object)
          } as Parameters<typeof t.automation.exportImage>[0]),
        { ...c.settings, format: c.format, filePath }
      )
      expect(statSync(filePath).size).toBeGreaterThan(0)

      await inApp(page, (t, p) => t.automation.openDocument(p), filePath)
      const out = await composite(page)
      expect([out.width, out.height]).toEqual([W, H])
      const floatOut = c.doc === 'rgba32f' && !['png', 'jpeg', 'webp', 'tga', 'tiff', 'psd'].includes(c.format) && !(c.format === 'dds' && c.settings?.ddsCompression !== 'rgba32f')
      expect(out.float, 'reopened file has the exported bit depth').toBe(floatOut)
      // An 8-bit export of a float document: compare against the sRGB-encoded source.
      const enc = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)
      const srcValue = (i: number): number =>
        !src.float ? src.data[i] / 255 : out.float || i % 4 === 3 ? src.data[i] : enc(src.data[i])
      const outValue = (i: number): number => (out.float ? out.data[i] : out.data[i] / 255)

      // Compare channel by channel (0–1 scale).
      let maxDiff = 0
      let sum = 0
      let n = 0
      let where = ''
      const rows = c.opaqueOnly ? Math.floor((3 * H) / 4) : H
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < W; x++) {
          for (let ch = 0; ch < (c.opaqueOnly ? 3 : 4); ch++) {
            const i = (y * W + x) * 4 + ch
            const d = Math.abs(outValue(i) - srcValue(i))
            sum += d
            n++
            if (d > maxDiff) {
              maxDiff = d
              where = `(${x},${y}) ch${ch}: ${srcValue(i)} → ${outValue(i)}`
            }
          }
        }
      }
      if (c.lossy) expect(sum / n, 'mean channel difference').toBeLessThanOrEqual(c.tolerance)
      else expect(maxDiff, `max channel difference at ${where}`).toBeLessThanOrEqual(c.tolerance)
    })
  }

  test('pdf export writes a PDF file', async ({ page, workDir }) => {
    await patternDocument(page, 'rgba8')
    const filePath = join(workDir, 'out.pdf')
    await inApp(
      page,
      (t, p) =>
        t.automation.exportImage({
          filePath: p,
          format: 'pdf',
          jpegQuality: 92,
          jpegBackground: '#ffffff',
          webpQuality: 90,
          exrCompression: 0,
          exrHalfFloat: false,
          ddsCompression: 'bc7',
          ddsMipLevels: 1,
          layerMode: 'single'
        }),
      filePath
    )
    expect(readFileSync(filePath).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  test('float-only formats are refused for 8-bit documents', async ({ page, workDir }) => {
    await patternDocument(page, 'rgba8')
    const filePath = join(workDir, 'out.exr')
    const err = await inApp(
      page,
      (t, p) =>
        t.automation
          .exportImage({
            filePath: p,
            format: 'exr',
            jpegQuality: 92,
            jpegBackground: '#ffffff',
            webpQuality: 90,
            exrCompression: 0,
            exrHalfFloat: false,
            ddsCompression: 'bc7',
            ddsMipLevels: 1,
            layerMode: 'single'
          })
          .then(() => null, (e: Error) => e.message),
      filePath
    )
    expect(err).toMatch(/32-bit float/)
    expect(existsSync(filePath)).toBe(false)
  })

  test('import exported PNG as a layer', async ({ page, workDir }) => {
    await patternDocument(page, 'rgba8')
    const src = await composite(page)
    const filePath = join(workDir, 'layer.png')
    await inApp(
      page,
      (t, p) =>
        t.automation.exportImage({
          filePath: p,
          format: 'png',
          jpegQuality: 92,
          jpegBackground: '#ffffff',
          webpQuality: 90,
          exrCompression: 0,
          exrHalfFloat: false,
          ddsCompression: 'bc7',
          ddsMipLevels: 1,
          layerMode: 'single'
        }),
      filePath
    )
    await newDocument(page, { width: W, height: H, pixelFormat: 'rgba8', background: 'transparent' })
    await inApp(page, (t, p) => t.automation.importImageAsLayer(p, { name: 'Imported', position: { x: 0, y: 0 } }), filePath)
    const names = await inApp(page, (t) => t.automation.layers({}).map((l) => l.name))
    expect(names).toContain('Imported')
    expect((await composite(page)).data).toEqual(src.data)
  })
})
