// Builds the app for end-to-end tests: a normal `electron-vite build` with
// VITE_VERVE_E2E=1, which keeps `window.__verveTest` in the renderer bundle
// (release builds strip it). Writes to out/, like `npm run build`; run that
// again before packaging.
import { spawnSync } from 'node:child_process'

const result = spawnSync('npx', ['electron-vite', 'build'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, VITE_VERVE_E2E: '1' }
})
process.exit(result.status ?? 1)
