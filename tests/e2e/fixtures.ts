import { test as base, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(__dirname, '../..')

/** Messages the renderer logged as errors, plus uncaught exceptions. Tests
 *  fail on uncaught exceptions; console errors are attached for diagnosis
 *  and can be asserted with `expectNoConsoleErrors`. */
export interface RendererLog {
  readonly errors: string[]
  readonly pageErrors: string[]
}

interface Fixtures {
  /** A scratch directory deleted after the test (exports, saved files). */
  workDir: string
  electronApp: ElectronApplication
  page: Page
  log: RendererLog
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  workDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'verve-e2e-work-'))
    await use(dir)
    rmSync(dir, { recursive: true, force: true })
  },

  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const userData = mkdtempSync(join(tmpdir(), 'verve-e2e-profile-'))
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    // Set by VS Code / some shells; makes Electron run as plain Node.
    delete env.ELECTRON_RUN_AS_NODE
    env.VERVE_USER_DATA_DIR = userData
    // CI machines have no GPU: use Electron's software WebGPU adapter.
    if (process.env.CI && env.VERVE_SOFTWARE_WEBGPU === undefined) env.VERVE_SOFTWARE_WEBGPU = '1'

    const app = await electron.launch({ args: [root], cwd: root, env })
    await use(app)

    // Skip the unsaved-changes prompt: tests leave dirty documents behind.
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app.close().catch(() => {})
    rmSync(userData, { recursive: true, force: true })
  },

  log: async ({}, use) => {
    await use({ errors: [], pageErrors: [] })
  },

  page: async ({ electronApp, log }, use, testInfo) => {
    const page = await electronApp.firstWindow()
    page.on('console', (msg) => {
      if (msg.type() === 'error') log.errors.push(msg.text())
    })
    page.on('pageerror', (err) => log.pageErrors.push(err.stack ?? err.message))

    // The hook appears once App has mounted; the automation host once the
    // services are wired up.
    await page.waitForFunction(() => {
      const t = (window as unknown as { __verveTest?: { automation?: unknown } }).__verveTest
      return !!t?.automation
    }, undefined, { timeout: 30_000 })

    await use(page)

    if (log.errors.length) {
      await testInfo.attach('renderer-console-errors', { body: log.errors.join('\n\n') })
    }
    expect(log.pageErrors, 'uncaught exceptions in the renderer').toEqual([])
  }
})

export { expect }
