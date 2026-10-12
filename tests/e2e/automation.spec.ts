// Automation workflows: `.automation` file text is parsed and run the way
// the Automation tab runs it (workflowRunStore → automationRunner → the
// app's AutomationHost), and its effects show up in the app and on disk.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { compositePixel, inApp } from './verve'

interface Node {
  id: string
  type: string
  params?: Record<string, unknown>
}
type Edge = [from: string, fromPort: string, to: string, toPort: string]

/** `.automation` file text for a graph (format of core/nodes/automationFile.ts). */
function automationFile(nodes: Node[], edges: Edge[]): string {
  const graph = {
    id: 'e2e-workflow',
    name: 'E2E',
    domain: 'automation',
    nodes: nodes.map((n, i) => ({ id: n.id, type: n.type, x: i * 200, y: 0, params: n.params ?? {} })),
    edges: edges.map(([from, fromPort, to, toPort], i) => ({
      id: `e${i}`,
      from: { node: from, port: fromPort },
      to: { node: to, port: toPort }
    }))
  }
  return JSON.stringify({ format: 'verve-automation', formatVersion: 1, graph }, null, 2)
}

interface RunResult {
  running: boolean
  errorNodeId: string | null
  log: { kind: string; text: string }[]
}

/** Parse the file text in the app and run it to completion. */
async function runWorkflow(page: Page, text: string): Promise<RunResult> {
  return inApp(
    page,
    async (t, src) => {
      const parsed = t.workflows.parse(src)
      if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`)
      t.workflows.clearLog()
      await t.workflows.run(parsed.graph)
      const s = t.workflows.state()
      return { running: s.running, errorNodeId: s.errorNodeId, log: s.log.map((l) => ({ kind: l.kind, text: l.text })) }
    },
    text
  )
}

test('runs a workflow that creates, paints and exports a document', async ({ page, workDir }) => {
  const out = join(workDir, 'auto', 'result.png')
  const text = automationFile(
    [
      { id: 'run', type: 'onRun' },
      { id: 'doc', type: 'newDocument', params: { width: 32, height: 24, name: 'Auto', format: 'rgba8', background: 'white' } },
      { id: 'layer', type: 'newLayer', params: { name: 'Painted' } },
      { id: 'fill', type: 'fillLayer', params: { color: [1, 0, 0, 1] } },
      { id: 'opacity', type: 'setLayerOpacity', params: { opacity: 0.5 } },
      { id: 'repeat', type: 'repeat', params: { count: 3 } },
      { id: 'extra', type: 'newLayer', params: { name: 'Extra' } },
      { id: 'export', type: 'exportImage', params: { format: 'png', path: out } },
      { id: 'print', type: 'print', params: { message: 'workflow done' } }
    ],
    [
      ['run', 'then', 'doc', 'exec'],
      ['doc', 'then', 'layer', 'exec'],
      ['layer', 'then', 'fill', 'exec'],
      ['layer', 'layer', 'fill', 'layer'],
      ['fill', 'then', 'opacity', 'exec'],
      ['fill', 'layer', 'opacity', 'layer'],
      ['opacity', 'then', 'repeat', 'exec'],
      ['repeat', 'body', 'extra', 'exec'],
      ['repeat', 'completed', 'export', 'exec'],
      ['export', 'then', 'print', 'exec']
    ]
  )

  const result = await runWorkflow(page, text)
  expect(result.errorNodeId, JSON.stringify(result.log)).toBeNull()
  expect(result.running).toBe(false)
  expect(result.log.at(-1)?.kind).toBe('ok')
  expect(result.log.some((l) => l.kind === 'print' && l.text === 'workflow done')).toBe(true)

  expect(await inApp(page, (t) => t.automation.document())).toMatchObject({ name: 'Auto', width: 32, height: 24 })
  const layers = await inApp(page, (t) => t.automation.layers({}).map((l) => t.automation.layerProperties(l)))
  expect(layers.filter((l) => l.name === 'Extra')).toHaveLength(3)
  expect(layers.find((l) => l.name === 'Painted')?.opacity).toBeCloseTo(0.5)
  // 50% red over white.
  const px = await compositePixel(page, 10, 10)
  expect(px[0]).toBe(255)
  expect(Math.abs(px[1] - 128)).toBeLessThanOrEqual(1)
  expect(Math.abs(px[2] - 128)).toBeLessThanOrEqual(1)

  // The export (with Create Folder) wrote the file; it opens with the same pixels.
  expect(existsSync(out)).toBe(true)
  await inApp(page, (t, p) => t.automation.openDocument(p), out)
  expect(await compositePixel(page, 10, 10)).toEqual(px)
})

test('runs a generated effect node', async ({ page }) => {
  const text = automationFile(
    [
      { id: 'run', type: 'onRun' },
      { id: 'doc', type: 'newDocument', params: { width: 16, height: 16, format: 'rgba8', background: 'white' } },
      { id: 'layer', type: 'newLayer', params: { name: 'Paint' } },
      { id: 'fill', type: 'fillLayer', params: { color: [1, 0.5, 0, 1] } },
      { id: 'invert', type: 'effect.color-invert', params: {} }
    ],
    [
      ['run', 'then', 'doc', 'exec'],
      ['doc', 'then', 'layer', 'exec'],
      ['layer', 'then', 'fill', 'exec'],
      ['fill', 'then', 'invert', 'exec'],
      ['fill', 'layer', 'invert', 'layer']
    ]
  )
  const result = await runWorkflow(page, text)
  expect(result.errorNodeId, JSON.stringify(result.log)).toBeNull()
  const kinds = await inApp(page, (t) =>
    t.automation.layers({ attachments: true, recursive: true }).map((l) => t.automation.layerProperties(l).effectType)
  )
  expect(kinds).toContain('color-invert')
  const px = await compositePixel(page, 8, 8)
  expect(px[0]).toBe(0)
  expect(Math.abs(px[1] - 127)).toBeLessThanOrEqual(1)
  expect(px[2]).toBe(255)
})

test('a failing node stops the run and is reported', async ({ page }) => {
  // No document is open: Fill Layer has nothing to act on.
  const text = automationFile(
    [
      { id: 'run', type: 'onRun' },
      { id: 'fill', type: 'fillLayer', params: { color: [1, 0, 0, 1] } },
      { id: 'print', type: 'print', params: { message: 'should not run' } }
    ],
    [
      ['run', 'then', 'fill', 'exec'],
      ['fill', 'then', 'print', 'exec']
    ]
  )
  const result = await runWorkflow(page, text)
  expect(result.errorNodeId).toBe('fill')
  expect(result.log.at(-1)?.kind).toBe('error')
  expect(result.log.some((l) => l.text === 'should not run')).toBe(false)
})

test('rejects files that are not automation workflows', async ({ page }) => {
  const results = await inApp(page, (t) => [
    t.workflows.parse('not json'),
    t.workflows.parse(JSON.stringify({ format: 'verve-effect', formatVersion: 1, graph: {} })),
    t.workflows.parse(JSON.stringify({ format: 'verve-automation', formatVersion: 999, graph: {} }))
  ])
  for (const r of results) expect(r.ok).toBe(false)
})
