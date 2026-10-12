// The preload's `window.api` surface, and a cross-check of its channel
// names against what the main process registers: a channel renamed on one
// side only is caught here instead of failing at runtime.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => import('@tests/fakes/electronMain').then((m) => m.electronModule))
vi.mock('@electron-toolkit/utils', () =>
  import('@tests/fakes/electronMain').then((m) => m.toolkitUtilsModule)
)

import {
  disposeFakeElectron,
  fakeElectron,
  resetFakeElectron,
  settleEffectsWatcher
} from '@tests/fakes/electronMain'
import { ELECTRON_DIR } from '@tests/paths'

type AnyFn = (...args: unknown[]) => unknown
type Api = Record<string, unknown>
let api: Api

beforeAll(async () => {
  resetFakeElectron()
  await import('../../../../electron/preload/index')
  api = fakeElectron.exposed.get('api') as Api
})
beforeEach(() => {
  fakeElectron.rendererInvokes.length = 0
  fakeElectron.rendererSends.length = 0
  fakeElectron.rendererListeners.clear()
})
afterAll(disposeFakeElectron)

/** Every function on the api (nested namespaces flattened as `ns.fn`). */
function apiFunctions(obj: Api = api, prefix = ''): Array<[string, AnyFn]> {
  const out: Array<[string, AnyFn]> = []
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'function') out.push([prefix + k, v as AnyFn])
    else if (v && typeof v === 'object') out.push(...apiFunctions(v as Api, `${prefix}${k}.`))
  }
  return out
}

/** Call every api function once and collect the channels it touches. */
function collectChannels(): { invoke: Set<string>; send: Set<string>; listen: Set<string> } {
  for (const [, fn] of apiFunctions()) {
    const r = fn({}, {}, {})
    if (typeof r === 'function') (r as AnyFn)() // listener cleanup
    else if (r instanceof Promise) r.catch(() => undefined)
  }
  return {
    invoke: new Set(fakeElectron.rendererInvokes.map((c) => c.channel)),
    send: new Set(fakeElectron.rendererSends.map((c) => c.channel)),
    listen: new Set(listenedChannels)
  }
}
// Channels subscribed through ipcRenderer.on, recorded before cleanup runs.
const listenedChannels: string[] = []

const mainDir = join(ELECTRON_DIR, 'main')
function mainSources(): string {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) files.push(p)
    }
  }
  walk(mainDir)
  return files.map((f) => readFileSync(f, 'utf-8')).join('\n')
}
const matchAll = (src: string, re: RegExp): Set<string> => new Set([...src.matchAll(re)].map((m) => m[1]))

describe('exposed surface', () => {
  it('exposes only `api` to the page', () => {
    expect([...fakeElectron.exposed.keys()]).toEqual(['api'])
  })

  it('exposes no raw ipcRenderer / generic invoke-or-send escape hatch', () => {
    const names = apiFunctions().map(([n]) => n)
    for (const banned of ['invoke', 'send', 'on', 'ipcRenderer', 'sendSync']) {
      expect(names).not.toContain(banned)
    }
    expect(Object.values(api)).not.toContain(undefined)
  })

  it('exposes the platform string', () => {
    expect(api.platform).toBe(process.platform)
  })
})

describe('channel cross-check with the main process', () => {
  let mainHandles: Set<string>
  let mainListens: Set<string>
  let mainSends: Set<string>
  let preload: ReturnType<typeof collectChannels>

  beforeAll(async () => {
    // Record ipcRenderer.on channels before the cleanup functions remove them.
    const origOn = fakeElectron.rendererListeners.set.bind(fakeElectron.rendererListeners)
    fakeElectron.rendererListeners.set = (k, v) => {
      listenedChannels.push(k)
      return origOn(k, v)
    }
    preload = collectChannels()

    // Handlers registered at runtime by the register* functions…
    const { registerIpcHandlers } = await import('../../../../electron/main/ipc')
    const { registerPreferencesHandlers } = await import('../../../../electron/main/preferences')
    const { registerColorProfileHandlers } = await import('../../../../electron/main/colorProfiles')
    registerIpcHandlers()
    registerPreferencesHandlers()
    registerColorProfileHandlers()
    mainHandles = new Set(fakeElectron.ipcMain.handlers.keys())
    mainListens = new Set(fakeElectron.ipcMain.listeners.keys())
    await settleEffectsWatcher()
    fakeElectron.emitApp('will-quit') // close the effects folder watcher

    // …plus the ones index.ts registers inline (it boots the app on import,
    // so it's read as source), and every channel the main process sends.
    const src = mainSources()
    for (const c of matchAll(src, /ipcMain\.handle\(\s*'([^']+)'/g)) mainHandles.add(c)
    for (const c of matchAll(src, /ipcMain\.on\(\s*'([^']+)'/g)) mainListens.add(c)
    mainSends = matchAll(src, /\.send\(\s*'([^']+)'/g)
  })

  it('found channels on both sides (sanity)', () => {
    expect(preload.invoke.size).toBeGreaterThan(80)
    expect(mainHandles.size).toBeGreaterThan(80)
    expect(preload.listen.size).toBeGreaterThan(3)
  })

  it('every channel the preload invokes has a main-process handler', () => {
    const missing = [...preload.invoke].filter((c) => !mainHandles.has(c))
    expect(missing).toEqual([])
  })

  it('every main-process handler is reachable from the preload', () => {
    const orphaned = [...mainHandles].filter((c) => !preload.invoke.has(c))
    expect(orphaned).toEqual([])
  })

  it('every channel the preload sends has a main-process listener', () => {
    const missing = [...preload.send].filter((c) => !mainListens.has(c))
    expect(missing).toEqual([])
    expect([...preload.send].sort()).toEqual(['app:unsaved-documents', 'menu:rebuild'])
  })

  it('every channel the preload listens on is sent by the main process', () => {
    const missing = [...preload.listen].filter((c) => !mainSends.has(c))
    expect(missing).toEqual([])
  })

  it('the preload listens to every channel the main process sends to the renderer', () => {
    const unheard = [...mainSends].filter((c) => !preload.listen.has(c))
    expect(unheard).toEqual([])
  })
})

describe('argument forwarding', () => {
  const last = () => fakeElectron.rendererInvokes[fakeElectron.rendererInvokes.length - 1]
  const fn = (path: string): AnyFn =>
    path.split('.').reduce<unknown>((o, k) => (o as Api)[k], api) as AnyFn

  it.each([
    ['writeJsonFile', ['p.json', '{}'], 'file:writeJson', ['p.json', '{}']],
    ['saveverveChunk', [3, new Uint8Array([1])], 'file:saveverveChunk', [3, new Uint8Array([1])]],
    ['exportImage', ['a.png', new Uint8Array([2])], 'file:exportImage', ['a.png', new Uint8Array([2])]],
    ['clipboardWriteImage', [new Uint8Array(4), 1, 1], 'clipboard:write-image', [new Uint8Array(4), 1, 1]],
    ['listDirectory', ['/x', { recursive: true }], 'fs:list', ['/x', { recursive: true }]],
    ['writeCellManifest', ['/f', '{}'], 'cells:writeManifest', ['/f', '{}']],
    ['saveAutomationFileAs', ['{}', '/a.automation'], 'automation:saveAs', ['{}', '/a.automation']],
    ['saveEffectFile', ['{}', 'Glow'], 'effects:save', ['{}', 'Glow']],
    ['upscale.checkModel', ['m'], 'upscale:check-model', ['m']],
    ['upscale.invalidateSession', [undefined], 'upscale:invalidate-session', [undefined]],
    ['applyFileAssoc', [['png']], 'fileAssoc:apply', [['png']]]
  ])('%s(…) invokes %s with the arguments in order', (name, args, channel, expected) => {
    void fn(name)(...args)
    expect(last()).toEqual({ channel, args: expected })
  })

  it('ML run calls forward only the documented fields', () => {
    const rgba = new Uint8Array(4)
    void fn('isnet.run')({ rgba, width: 1, height: 1, extra: 'dropped' })
    expect(last()).toEqual({ channel: 'isnet:run', args: [{ rgba, width: 1, height: 1 }] })
    void fn('inpaint.run')({ rgba, mask: rgba, width: 1, height: 1, extra: 1 })
    expect(last().args).toEqual([{ rgba, mask: rgba, width: 1, height: 1 }])
    void fn('upscale.run')({ rgba, width: 1, height: 1, modelId: 'm', targetWidth: 4, targetHeight: 4, x: 1 })
    expect(last().args).toEqual([{ rgba, width: 1, height: 1, modelId: 'm', targetWidth: 4, targetHeight: 4 }])
    void fn('matting.refine')({
      imageRgba: rgba, width: 1, height: 1, selectionMask: rgba, bandRadius: 2, mode: 'hair', y: 1
    })
    expect(last().args).toEqual([
      { imageRgba: rgba, width: 1, height: 1, selectionMask: rgba, bandRadius: 2, mode: 'hair' }
    ])
  })

  it('fire-and-forget calls use send, not invoke', () => {
    ;(api.setUnsavedDocuments as AnyFn)(['a', 'b'])
    ;(api.rebuildNativeMenu as AnyFn)([{ label: 'File' }])
    expect(fakeElectron.rendererSends).toEqual([
      { channel: 'app:unsaved-documents', args: [['a', 'b']] },
      { channel: 'menu:rebuild', args: [[{ label: 'File' }]] }
    ])
    expect(fakeElectron.rendererInvokes).toEqual([])
  })
})

describe('event subscriptions', () => {
  const emit = (channel: string, ...args: unknown[]): void => {
    for (const l of fakeElectron.rendererListeners.get(channel) ?? []) l({ sender: null }, ...args)
  }

  it.each([
    ['onOpenFile', 'app:open-file', ['/x.png'], ['/x.png']],
    ['onMenuAction', 'menu:action', ['file.save'], ['file.save']],
    ['onEffectsChanged', 'effects:changed', [], []],
    ['upscale.onProgress', 'upscale:progress', [{ progress: 1, loaded: 1, total: 1 }], [{ progress: 1, loaded: 1, total: 1 }]],
    ['matting.onDownloadProgress', 'matting:download-progress', [{ progress: 0, loaded: 0, total: 0 }], [{ progress: 0, loaded: 0, total: 0 }]]
  ])('%s delivers %s payloads without the IPC event, and unsubscribes', (name, channel, payload, expected) => {
    const received: unknown[][] = []
    const subscribe = name.split('.').reduce<unknown>((o, k) => (o as Api)[k], api) as (
      cb: (...a: unknown[]) => void
    ) => () => void
    const off = subscribe((...a) => received.push(a))
    emit(channel, ...payload)
    expect(received).toEqual([expected])
    off()
    emit(channel, ...payload)
    expect(received).toHaveLength(1)
    expect(fakeElectron.rendererListeners.get(channel)).toEqual([])
  })

  it('unsubscribing one listener leaves others subscribed', () => {
    const a: unknown[] = []
    const b: unknown[] = []
    const onMenuAction = api.onMenuAction as (cb: (id: string) => void) => () => void
    const offA = onMenuAction((id) => a.push(id))
    onMenuAction((id) => b.push(id))
    offA()
    emit('menu:action', 'x')
    expect(a).toEqual([])
    expect(b).toEqual(['x'])
  })
})
