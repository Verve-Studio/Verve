// Stands in for `./generated/pixelops.wasm?url` under Vitest. In the app Vite
// serves the file and hands back its URL; under Node the Emscripten loader
// reads it from disk, so give it the absolute path.
import { existsSync } from 'fs'
import { resolve } from 'path'

const wasmPath = resolve(__dirname, '../../../src/wasm/generated/pixelops.wasm')

if (!existsSync(wasmPath)) {
  throw new Error(
    `WASM module not built (${wasmPath} is missing). Run \`npm run build:wasm\` before the tests.`
  )
}

export default wasmPath
