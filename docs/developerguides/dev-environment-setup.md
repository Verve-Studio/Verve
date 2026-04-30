# Dev Environment Setup

This guide walks you through getting Verve running locally for the first time, from a bare machine to a running dev build.

---

## Prerequisites

| Tool | Minimum version | Notes |
|---|---|---|
| **Node.js** | 20 LTS | Use [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm) to manage versions |
| **npm** | 10+ | Bundled with Node 20 |
| **Git** | Any recent | For cloning |
| **Emscripten** | latest | Only needed to rebuild C++/WASM; skip if not touching C++ |
| **macOS** | 13+ | Primary dev platform; Electron also runs on Windows/Linux |

WebGPU requires a relatively recent GPU driver. On macOS this is provided by Metal. On Windows/Linux make sure your Chromium/Electron WebGPU flag is enabled.

---

## First-time setup

### 1. Clone and install JS dependencies

```bash
git clone <repo-url>
cd Verve
npm install
```

### 2. Build or restore the WASM binary

The generated WASM files are **gitignored**. You must either:

**Option A – Build from C++ source (requires Emscripten):**

```bash
# Install Emscripten (one time only):
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh      # macOS/Linux
# On Windows: emsdk_env.bat

cd /path/to/Verve
npm run build:wasm
```

`npm run build:wasm` runs CMake with Emscripten to produce `src/wasm/generated/pixelops.js` and `src/wasm/generated/pixelops.wasm`. You only need to re-run this when you change files under `wasm/src/`.

**Option B – Obtain pre-built binaries:**

Copy the two generated files (`pixelops.js`, `pixelops.wasm`) into `src/wasm/generated/`. They can be extracted from any recent CI build artifact.

### 3. Start the development server

```bash
npm run dev
```

This starts **electron-vite** in dev mode, which:
- Starts a Vite dev server for the renderer (hot module replacement)
- Watches `electron/main/` and `electron/preload/` and rebuilds on change
- Launches an Electron window pointing at the local dev server

Changes to React components and hooks update live without restarting. Changes to `electron/main/index.ts` or IPC handlers require a manual restart (`Ctrl+C`, then `npm run dev` again).

---

## Available scripts

```bash
npm run dev           # Start Electron + Vite in development mode
npm run build         # Production build → out/
npm run build:wasm    # Compile C++ → WASM (Emscripten must be active)
npm run typecheck     # Run tsc --noEmit for both main and renderer
```

`typecheck` runs two TypeScript projects:
- `tsconfig.node.json` — covers `electron/main/` and `electron/preload/`
- `tsconfig.web.json` — covers `src/`

Run it before pushing. The `src/` and `electron/` folders use different TypeScript environments (DOM vs. Node) so they must be checked separately.

---

## Path aliases

The Vite config and both `tsconfig` files resolve `@/` to `src/`:

```typescript
import { useAppContext } from '@/core/store/AppContext'
import { SliderInput } from '@/ux'
import type { AppState } from '@/types'
```

Use `@/` consistently. Never use relative paths like `../../store/AppContext`.

---

## Directory-level TypeScript environments

| Files | tsconfig | Global types available |
|---|---|---|
| `electron/main/**`, `electron/preload/**` | `tsconfig.node.json` | Node.js built-ins, Electron |
| `src/**` | `tsconfig.web.json` | DOM, WebGPU (`@webgpu/types`), React |

**Never** use `electron` or `path`/`fs` Node modules inside `src/`. The renderer has no access to them. Use `window.api.*` instead.

---

## Environment variables

Vite loads `.env` files but uses different prefixes per process:

| Prefix | Available in |
|---|---|
| `MAIN_VITE_` | Electron main process |
| `PRELOAD_VITE_` | Electron preload |
| `RENDERER_VITE_` | React renderer |
| `VITE_` | All three |

There are no required env vars for a basic dev setup.

---

## Adding a new npm dependency

```bash
npm install some-package
```

If the package is needed only in the main process (Node.js), it will be **externalized** automatically by `electron-vite` (not bundled into the renderer). If it is needed in the renderer only, no special steps are required.

If you install a package that ships native Node addons (`.node` files) you will need to configure `externalizeDepsPlugin` in `electron.vite.config.ts`.

---

## Checking for type errors

```bash
npm run typecheck
```

This is equivalent to:

```bash
tsc --project tsconfig.node.json --noEmit
tsc --project tsconfig.web.json --noEmit
```

Common pitfalls:
- **"Cannot find module 'electron'"** — you imported an Electron module inside `src/`. Move it to `electron/main/` and expose it via IPC.
- **"Cannot find name 'GPUDevice'"** — `@webgpu/types` is not declared in scope; check `tsconfig.web.json` includes `@webgpu/types`.
- **"Module '.../pixelops.wasm?url' not found"** — you haven't run `build:wasm` yet; the generated folder is empty.

---

## Production build

```bash
npm run build
```

Outputs to `out/`:
```
out/
  main/index.js       ← compiled main process
  preload/index.js    ← compiled preload
  renderer/           ← compiled React app (HTML + JS bundles)
```

The `out/main/index.js` path is declared in `package.json`'s `"main"` field and is what Electron loads.

To package for distribution (`.dmg`, `.exe`, etc.) you would use `electron-builder` or `electron-forge` configured separately — that step is not automated in this repo yet.

---

## Working with the WASM layer

If you change any `.cpp` or `.h` file under `wasm/src/`, or add a new exported symbol, you must rebuild:

```bash
# Ensure emsdk_env.sh is sourced in your terminal first
source /path/to/emsdk/emsdk_env.sh
npm run build:wasm
```

The build is incremental (CMake tracks dependencies). A clean rebuild:

```bash
rm -rf wasm/build
npm run build:wasm
```

The WASM module is loaded lazily on first use. `src/wasm/index.ts` exports `getPixelOps()` which initialises the module once and caches it:

```typescript
import { floodFill } from '@/wasm'

const result = await floodFill(pixelBuffer, width, height, x, y, r, g, b, a, tolerance)
```

Never import from `src/wasm/generated/` directly.
