// Fake of the parts of the `electron` module the main process and preload
// use, for unit tests of electron/main and electron/preload.
//
// Usage in a test file (vi.mock is hoisted, so the factory imports lazily):
//
//   vi.mock('electron', () => import('./electronMain').then((m) => m.electronModule))
//   vi.mock('@electron-toolkit/utils', () => import('./electronMain').then((m) => m.toolkitUtilsModule))
//   import { fakeElectron, resetFakeElectron } from './electronMain'
//
// The test and the mocked module share this module instance, so the test can
// drive the fake (queue dialog answers, invoke IPC handlers like the renderer
// would, inspect what was sent to windows) through `fakeElectron`. The state
// is shared through globalThis, so this also holds across vi.resetModules().
//
// Everything is plain functions with explicit state (no vi.fn): the Vitest
// config restores mocks between tests, which would wipe vi.fn implementations.

import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── IPC ──────────────────────────────────────────────────────────────────────

type Handler = (event: FakeInvokeEvent, ...args: unknown[]) => unknown
type Listener = (event: FakeInvokeEvent, ...args: unknown[]) => void

export interface FakeInvokeEvent {
  sender: FakeWebContents
}

export class FakeIpcMain {
  readonly handlers = new Map<string, Handler>()
  readonly listeners = new Map<string, Listener[]>()

  handle(channel: string, handler: Handler): void {
    // Same rule as Electron: one handler per channel.
    if (this.handlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`)
    }
    this.handlers.set(channel, handler)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  on(channel: string, listener: Listener): this {
    const list = this.listeners.get(channel) ?? []
    list.push(listener)
    this.listeners.set(channel, list)
    return this
  }

  /** `ipcRenderer.invoke(channel, ...args)` from the default window. */
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return this.invokeFrom(fakeElectron.defaultSender(), channel, ...args)
  }

  /** `ipcRenderer.invoke` from a specific renderer. Like Electron, the
   *  result is always a promise, and a throwing handler rejects it. */
  async invokeFrom(sender: FakeWebContents, channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`No handler registered for '${channel}'`)
    return handler({ sender }, ...args)
  }

  /** `ipcRenderer.send(channel, ...args)`. */
  send(channel: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(channel) ?? []) l({ sender: fakeElectron.defaultSender() }, ...args)
  }
}

// ─── Windows ──────────────────────────────────────────────────────────────────

let nextWebContentsId = 1

export class FakeWebContents extends EventEmitter {
  readonly id = nextWebContentsId++
  readonly sent: Array<{ channel: string; args: unknown[] }> = []
  destroyed = false
  /** Answer for `print(options, callback)`; null = never call back. */
  printResult: { success: boolean; reason: string } | null = { success: true, reason: '' }
  printed: unknown[] = []

  send(channel: string, ...args: unknown[]): void {
    if (this.destroyed) throw new Error('Object has been destroyed')
    this.sent.push({ channel, args })
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  /** Simulate the renderer going away (window closed / crashed). */
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }

  async getPrintersAsync(): Promise<unknown[]> {
    return fakeElectron.printers
  }

  print(options: unknown, callback: (success: boolean, reason: string) => void): void {
    this.printed.push(options)
    const r = this.printResult
    if (r) callback(r.success, r.reason)
  }

  openDevTools(): void {
    fakeElectron.devToolsOpened++
  }
}

export class FakeBrowserWindow {
  readonly webContents = new FakeWebContents()
  destroyed = false
  loadedFiles: string[] = []

  constructor(readonly options: unknown = {}) {
    fakeElectron.windows.push(this)
  }

  static getAllWindows(): FakeBrowserWindow[] {
    return fakeElectron.windows.filter((w) => !w.destroyed)
  }

  static getFocusedWindow(): FakeBrowserWindow | null {
    return fakeElectron.focusedWindow
  }

  static fromWebContents(wc: FakeWebContents): FakeBrowserWindow | null {
    return fakeElectron.windows.find((w) => w.webContents === wc) ?? null
  }

  async loadFile(path: string): Promise<void> {
    this.loadedFiles.push(path)
    await fakeElectron.onLoadFile?.(path)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyed = true
  }
}

// ─── Utility process (ML worker) ─────────────────────────────────────────────

export class FakeUtilityProcess extends EventEmitter {
  readonly posted: unknown[] = []
  killed = false

  constructor(readonly modulePath: string) {
    super()
  }

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  /** Like Electron, `kill` only requests termination; the `exit` event
   *  arrives later. Tests call `exit()` to deliver it. */
  kill(): boolean {
    this.killed = true
    return true
  }

  /** Deliver the process's `exit` event. */
  exit(code = 0): void {
    this.emit('exit', code)
  }

  /** A message from the worker to the host. */
  reply(message: unknown): void {
    this.emit('message', message)
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

interface OpenDialogAnswer {
  canceled: boolean
  filePaths: string[]
}
interface SaveDialogAnswer {
  canceled: boolean
  filePath?: string
}

function createState() {
  const root = mkdtempSync(join(tmpdir(), 'verve-electron-'))
  return {
    /** Per-reset temp root; every `app.getPath` lives below it. */
    root,
    appPath: join(root, 'app'),
    isPackaged: false,
    ipcMain: new FakeIpcMain(),
    windows: [] as FakeBrowserWindow[],
    focusedWindow: null as FakeBrowserWindow | null,
    appListeners: new Map<string, Array<(...args: unknown[]) => void>>(),
    quitCalls: 0,
    devToolsOpened: 0,
    /** Queued dialog answers (FIFO); an empty queue answers "cancelled". */
    openDialogAnswers: [] as OpenDialogAnswer[],
    saveDialogAnswers: [] as SaveDialogAnswer[],
    openDialogCalls: [] as unknown[],
    saveDialogCalls: [] as unknown[],
    openedPaths: [] as string[],
    openPathError: '',
    trashed: [] as string[],
    applicationMenu: null as unknown,
    clipboardImage: null as { width: number; height: number; bitmap: Uint8Array } | null,
    clipboardWrites: [] as Array<{ width: number; height: number; bitmap: Uint8Array }>,
    printers: [] as unknown[],
    gpuInfo: {} as unknown,
    forks: [] as FakeUtilityProcess[],
    onLoadFile: null as ((path: string) => void | Promise<void>) | null,
    exposed: new Map<string, unknown>(),
    rendererInvokes: [] as Array<{ channel: string; args: unknown[] }>,
    rendererSends: [] as Array<{ channel: string; args: unknown[] }>,
    rendererListeners: new Map<string, Array<(...args: unknown[]) => void>>(),
    /** Fallback sender for `ipcMain.invoke`; created on demand. */
    defaultWindow: null as FakeBrowserWindow | null
  }
}

type State = ReturnType<typeof createState> & {
  defaultSender(): FakeWebContents
  path(name: string): string
  answerOpen(...filePaths: string[]): void
  answerSave(filePath: string | null): void
  emitApp(event: string, ...args: unknown[]): void
}

function decorate(s: ReturnType<typeof createState>): State {
  return Object.assign(s, {
    defaultSender(): FakeWebContents {
      s.defaultWindow ??= new FakeBrowserWindow()
      return s.defaultWindow.webContents
    },
    path(name: string): string {
      return join(s.root, name)
    },
    answerOpen(...filePaths: string[]): void {
      s.openDialogAnswers.push({ canceled: filePaths.length === 0, filePaths })
    },
    answerSave(filePath: string | null): void {
      s.saveDialogAnswers.push(
        filePath === null ? { canceled: true } : { canceled: false, filePath }
      )
    },
    emitApp(event: string, ...args: unknown[]): void {
      for (const l of s.appListeners.get(event) ?? []) l(...args)
    }
  })
}

// The state lives on globalThis so that every copy of this module shares it:
// `vi.resetModules()` (used to reload modules with module-level state) makes
// the test and the mocked `electron` import separate instances of this file.
interface Holder {
  state: State
  /** Every temp root created; removed on reset / dispose / process exit, as
   *  async code under test (e.g. a `mkdir -p`) can re-create a removed one. */
  roots: Set<string>
}
const holder: Holder = ((globalThis as { __verveFakeElectron?: Holder }).__verveFakeElectron ??= (() => {
  const h: Holder = { state: decorate(createState()), roots: new Set() }
  h.roots.add(h.state.root)
  process.once('exit', () => removeRoots(h, true))
  return h
})())

/** Remove every temp root except the current state's (or all of them). */
function removeRoots(h: Holder, includeCurrent = false): void {
  for (const r of h.roots) {
    if (r === h.state.root && !includeCurrent) continue
    try {
      // Kept in the set: async code can still re-create it.
      rmSync(r, { recursive: true, force: true })
    } catch {
      // Still in use (e.g. a folder watcher): retried on the next cleanup.
    }
  }
}

/** Live state of the fake. Always reads the current state, also after
 *  `resetFakeElectron` replaced it. */
export const fakeElectron: State = new Proxy({} as State, {
  get: (_t, key) => Reflect.get(holder.state, key),
  set: (_t, key, value) => Reflect.set(holder.state, key, value)
})

/** Fresh state (new temp root, no handlers, no windows). Removes the
 *  previous temp roots. Call in `beforeEach`. */
export function resetFakeElectron(): State {
  holder.state.emitApp('will-quit')
  holder.state = decorate(createState())
  holder.roots.add(holder.state.root)
  removeRoots(holder)
  return fakeElectron
}

/** Wait until the effects-folder watcher that `registerEffectHandlers`
 *  starts asynchronously is attached, so the next reset's `will-quit`
 *  closes it (an unclosed watcher keeps the temp folder alive). */
export async function settleEffectsWatcher(): Promise<void> {
  const dir = join(fakeElectron.path('userData'), 'effects')
  for (let i = 0; i < 200 && !existsSync(dir); i++) await new Promise((r) => setTimeout(r, 5))
  await new Promise((r) => setTimeout(r, 20))
}

/** Remove the temp roots (call in `afterAll` / `afterEach`). */
export function disposeFakeElectron(): void {
  holder.state.emitApp('will-quit')
  removeRoots(holder, true)
}

// ─── Module surface ───────────────────────────────────────────────────────────

const app = {
  get isPackaged(): boolean {
    return fakeElectron.isPackaged
  },
  getPath(name: string): string {
    return fakeElectron.path(name)
  },
  setPath(): void {},
  getAppPath(): string {
    return fakeElectron.appPath
  },
  on(event: string, listener: (...args: unknown[]) => void) {
    const list = fakeElectron.appListeners.get(event) ?? []
    list.push(listener)
    fakeElectron.appListeners.set(event, list)
    return app
  },
  quit(): void {
    fakeElectron.quitCalls++
  },
  async getGPUInfo(): Promise<unknown> {
    return fakeElectron.gpuInfo
  }
}

const ipcMain = {
  handle: (channel: string, handler: Handler) => fakeElectron.ipcMain.handle(channel, handler),
  removeHandler: (channel: string) => fakeElectron.ipcMain.removeHandler(channel),
  on: (channel: string, listener: Listener) => fakeElectron.ipcMain.on(channel, listener)
}

const dialog = {
  async showOpenDialog(...args: unknown[]): Promise<OpenDialogAnswer> {
    fakeElectron.openDialogCalls.push(args[args.length - 1])
    return fakeElectron.openDialogAnswers.shift() ?? { canceled: true, filePaths: [] }
  },
  async showSaveDialog(...args: unknown[]): Promise<SaveDialogAnswer> {
    fakeElectron.saveDialogCalls.push(args[args.length - 1])
    return fakeElectron.saveDialogAnswers.shift() ?? { canceled: true }
  }
}

const shell = {
  async openPath(path: string): Promise<string> {
    fakeElectron.openedPaths.push(path)
    return fakeElectron.openPathError
  },
  async trashItem(path: string): Promise<void> {
    fakeElectron.trashed.push(path)
  },
  async openExternal(): Promise<void> {}
}

const Menu = {
  buildFromTemplate(template: unknown) {
    return { template }
  },
  setApplicationMenu(menu: unknown): void {
    fakeElectron.applicationMenu = menu
  }
}

const nativeImage = {
  createFromBitmap(buffer: Uint8Array, size: { width: number; height: number }) {
    return { bitmap: new Uint8Array(buffer), ...size }
  }
}

const clipboard = {
  writeImage(img: { width: number; height: number; bitmap: Uint8Array }): void {
    fakeElectron.clipboardWrites.push(img)
  },
  readImage() {
    const img = fakeElectron.clipboardImage
    return {
      isEmpty: () => img === null,
      getSize: () => ({ width: img?.width ?? 0, height: img?.height ?? 0 }),
      toBitmap: () => Buffer.from(img?.bitmap ?? new Uint8Array(0))
    }
  }
}

const utilityProcess = {
  fork(modulePath: string): FakeUtilityProcess {
    const child = new FakeUtilityProcess(modulePath)
    fakeElectron.forks.push(child)
    return child
  }
}

// Preload side.
const contextBridge = {
  exposeInMainWorld(key: string, value: unknown): void {
    fakeElectron.exposed.set(key, value)
  }
}

const ipcRenderer = {
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    fakeElectron.rendererInvokes.push({ channel, args })
    return undefined
  },
  send(channel: string, ...args: unknown[]): void {
    fakeElectron.rendererSends.push({ channel, args })
  },
  on(channel: string, listener: (...args: unknown[]) => void) {
    const list = fakeElectron.rendererListeners.get(channel) ?? []
    list.push(listener)
    fakeElectron.rendererListeners.set(channel, list)
    return ipcRenderer
  },
  removeListener(channel: string, listener: (...args: unknown[]) => void) {
    const list = fakeElectron.rendererListeners.get(channel) ?? []
    fakeElectron.rendererListeners.set(
      channel,
      list.filter((l) => l !== listener)
    )
    return ipcRenderer
  }
}

export const electronModule = {
  app,
  ipcMain,
  dialog,
  shell,
  Menu,
  BrowserWindow: FakeBrowserWindow,
  nativeImage,
  clipboard,
  utilityProcess,
  contextBridge,
  ipcRenderer
}

/** Stand-in for `@electron-toolkit/utils`, which reads `app.isPackaged`
 *  at import time. */
export const toolkitUtilsModule = {
  is: {
    get dev(): boolean {
      return !fakeElectron.isPackaged
    }
  },
  electronApp: { setAppUserModelId(): void {} },
  optimizer: { watchWindowShortcuts(): void {} }
}
