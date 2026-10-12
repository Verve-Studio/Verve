import { defineConfig } from '@playwright/test'

// End-to-end tests: launch the built Electron app and drive it through
// `window.__verveTest` (see tests/e2e/fixtures.ts). `npm run test:e2e` builds the
// app with the test hook first (scripts/build-e2e.mjs); set
// VERVE_E2E_SKIP_BUILD=1 to reuse an existing e2e build.
export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/globalSetup.ts',
  // One Electron instance (and GPU device) per worker is plenty; the app
  // is heavy and WebGPU adapters don't like many concurrent devices.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results'
})
