import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export default function globalSetup(): void {
  const root = resolve(__dirname, '../..')
  if (!existsSync(resolve(root, 'src/wasm/generated/pixelops.wasm'))) {
    throw new Error('WASM module not built. Run `npm run build:wasm` first.')
  }
  if (process.env.VERVE_E2E_SKIP_BUILD === '1') {
    if (!existsSync(resolve(root, 'out/main/index.js'))) {
      throw new Error('VERVE_E2E_SKIP_BUILD=1 but out/ is empty. Run `npm run build:e2e`.')
    }
    return
  }
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/build-e2e.mjs')], {
    cwd: root,
    stdio: 'inherit'
  })
  if (result.status !== 0) throw new Error('e2e build failed')
}
