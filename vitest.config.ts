import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Unit and component tests. End-to-end tests (the built Electron app) run
// under Playwright instead: see playwright.config.ts and tests/e2e/.
//
//   tests/unit/**/*.test.ts   → node environment (pure logic, main-process modules, WASM)
//   tests/unit/**/*.test.tsx  → jsdom environment (React components and hooks)
//
// tests/unit mirrors the repository: the tests for src/core/store/foo.ts are
// in tests/unit/src/core/store/foo.test.ts. Shared fakes and helpers are
// imported as @tests/... (tests/unit/fakes, tests/unit/paths.ts).
const alias = [
  { find: '@', replacement: resolve(__dirname, 'src') },
  { find: '@renderer', replacement: resolve(__dirname, 'src') },
  { find: '@tests', replacement: resolve(__dirname, 'tests/unit') },
  // The WASM loader asks Vite for the binary's URL; Node needs a file path.
  {
    find: /^\.\/generated\/pixelops\.wasm\?url$/,
    replacement: resolve(__dirname, 'tests/unit/stubs/pixelopsWasmUrl.ts')
  }
]

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    setupFiles: [resolve(__dirname, 'tests/unit/setup.ts')],
    restoreMocks: true,
    unstubGlobals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['tests/unit/**/*.test.tsx'],
          setupFiles: [resolve(__dirname, 'tests/unit/setup.dom.ts')]
        }
      }
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'electron/**/*.ts'],
      exclude: ['src/wasm/generated/**', '**/*.d.ts'],
      reporter: ['text-summary', 'html', 'lcov']
    }
  }
})
