import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: true,
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main/index.ts'),
          // ML inference runs in a utility process (see electron/main/ml/mlHost.ts)
          mlWorker: resolve(__dirname, 'electron/main/mlWorker.ts')
        },
        output: {
          // Rolldown places its runtime helpers in the first entry and makes
          // every other entry require it. The ML worker must not load
          // index.js (it would start a second copy of the main process), so
          // give the runtime its own chunk.
          manualChunks: (id: string) =>
            id.includes('rolldown/runtime') || id.includes('rolldown:runtime')
              ? 'runtime'
              : undefined
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: true,
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname),
    build: {
      minify: true,
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html')
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@renderer': resolve(__dirname, 'src')
      }
    },
    plugins: [react()],
    css: {
      preprocessorOptions: {
        scss: {}
      }
    }
  }
})
