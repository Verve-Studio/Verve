// Typed helpers around `window.__verveTest` (src/core/services/useDevTestHook.ts).
// Everything runs inside the renderer via page.evaluate, so arguments and
// results must be structured-cloneable.
import type { Page } from '@playwright/test'
import type { AutomationHost } from '../../src/core/nodes/automationHost'
import type { AppState } from '../../src/types'
import type { CanvasHandle } from '../../src/ux/main/Canvas/canvasHandle'
import type { activeScope } from '../../src/core/store/scope'

type ActiveScope = ReturnType<typeof activeScope>

export interface VerveTestHook {
  getState(): AppState
  dispatch(action: unknown): void
  readonly canvas: CanvasHandle | null
  readonly menu: Record<string, (...args: unknown[]) => unknown>
  readonly automation: AutomationHost
  readonly scope: () => ActiveScope
  effects(): EffectInfo[]
  readonly workflows: {
    parse(text: string): { ok: true; graph: unknown } | { ok: false; error: string }
    run(graph: unknown): Promise<void>
    state(): { running: boolean; errorNodeId: string | null; log: readonly { kind: string; text: string }[] }
    clearLog(): void
  }
}

export interface EffectInfo {
  id: string
  label: string
  root: 'adjustments' | 'effects' | 'filters'
  submenu: string | null
  /** `paramFields` (editor specs without defaults). */
  fields: { id: string; label: string; spec: { kind: string; min?: number; max?: number; options?: { value: string | number }[] } }[]
}

declare global {
  interface Window {
    __verveTest: VerveTestHook
  }
}

/** Runs `fn(hook, arg)` in the renderer. `fn` must be self-contained (it is
 *  sent as source text, like any Playwright page function); `arg` must be
 *  JSON-serialisable. */
export function inApp<R, A = undefined>(
  page: Page,
  fn: (hook: VerveTestHook, arg: A) => R | Promise<R>,
  arg?: A
): Promise<R> {
  // A string expression goes through CDP Runtime.evaluate, which the
  // renderer's CSP (no 'unsafe-eval') doesn't apply to.
  return page.evaluate(
    `(${fn.toString()})(window.__verveTest, ${JSON.stringify(arg ?? null)})`
  ) as Promise<R>
}

export async function newDocument(
  page: Page,
  opts: { width: number; height: number; pixelFormat?: 'rgba8' | 'rgba32f' | 'indexed8'; background?: 'white' | 'black' | 'transparent'; name?: string }
): Promise<void> {
  await inApp(
    page,
    (t, o) =>
      t.automation.newDocument({
        name: o.name,
        width: o.width,
        height: o.height,
        pixelFormat: o.pixelFormat ?? 'rgba8',
        background: o.background ?? 'white'
      }),
    opts
  )
}

/** The flattened document as sRGB bytes (float documents are converted). */
export async function compositePixel(page: Page, x: number, y: number): Promise<number[]> {
  return inApp(
    page,
    async (t, p) => {
      const r = await t.canvas!.rasterizeComposite('sample')
      const i = (p.y * r.width + p.x) * 4
      const px = Array.from(r.data.slice(i, i + 4))
      if (!(r.data instanceof Float32Array)) return px
      const enc = (c: number): number =>
        Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055))
      return [enc(px[0]), enc(px[1]), enc(px[2]), Math.round(px[3] * 255)]
    },
    { x, y }
  )
}

/** Writes a deterministic, non-uniform pattern into a pixel layer (whole
 *  canvas): colour gradients, a hard-edged block, and a band with partial
 *  alpha, in the layer's native format. */
export async function paintPattern(page: Page, layerId: string): Promise<void> {
  await inApp(
    page,
    (t, id) => {
      const s = t.getState()
      const w = s.canvas.width
      const h = s.canvas.height
      const gpu = t.canvas!.getGpuLayer(id)
      if (!gpu) throw new Error(`no GPU layer ${id}`)
      const isFloat = gpu.format === 'rgba32f'
      if (gpu.format === 'indexed8') {
        const idx = new Uint8Array(w * h)
        const n = Math.max(1, Math.min(254, s.swatches.length))
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) idx[y * w + x] = ((x >> 2) + (y >> 2)) % n
        t.canvas!.writeLayerCanvasData(id, idx)
        return
      }
      const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
      const data = isFloat ? new Float32Array(w * h * 4) : new Uint8Array(w * h * 4)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          let r = x / (w - 1)
          let g = y / (h - 1)
          let b = ((x * 7 + y * 13) % 17) / 16
          let a = 1
          if (x > w / 4 && x < w / 2 && y > h / 4 && y < (3 * h) / 4) {
            r = 1
            g = 0.1
            b = 0.2
          }
          if (y > (3 * h) / 4) a = 0.5
          if (isFloat) {
            data[i] = lin(r)
            data[i + 1] = lin(g)
            data[i + 2] = lin(b)
            data[i + 3] = a
          } else {
            data[i] = Math.round(r * 255)
            data[i + 1] = Math.round(g * 255)
            data[i + 2] = Math.round(b * 255)
            data[i + 3] = Math.round(a * 255)
          }
        }
      }
      t.canvas!.writeLayerCanvasData(id, data)
    },
    layerId
  )
}

/** Waits `n` animation frames in the renderer. */
export async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate(
    `new Promise((res) => { let k = ${n}; const f = () => (--k <= 0 ? res(null) : requestAnimationFrame(f)); requestAnimationFrame(f) })`
  )
}

/** What undo/redo must restore: the canvas, the layer stack (JSON), each
 *  layer's pixels (hash of its canvas-sized native buffer) and the
 *  composite (hash). */
export interface DocSnapshot {
  width: number
  height: number
  pixelFormat: string
  layers: string
  pixels: Record<string, string | null>
  composite: string
}

export async function snapshot(page: Page): Promise<DocSnapshot | null> {
  return inApp(page, async (t) => {
    const c = t.canvas
    if (!c) return null
    const hash = (d: Uint8Array | Float32Array | null): string | null => {
      if (!d) return null
      const b = new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
      let h = 0x811c9dc5
      for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193)
      return `${d.constructor.name}:${d.length}:${(h >>> 0).toString(16)}`
    }
    const s = t.getState()
    const pixels: Record<string, string | null> = {}
    for (const l of s.layers) pixels[l.id] = hash(c.getLayerCanvasData(l.id))
    let composite: string
    try {
      composite = hash((await c.rasterizeComposite('sample')).data)!
    } catch (err) {
      composite = `error: ${(err as Error).message}`
    }
    return {
      width: s.canvas.width,
      height: s.canvas.height,
      pixelFormat: s.pixelFormat,
      layers: JSON.stringify(s.layers),
      pixels,
      composite
    }
  })
}

/** Window (CSS px) coordinates of the centre of document pixel (x, y): maps
 *  through the on-screen document canvas the way useCanvas maps pointer
 *  events back (rect size / document size). */
export async function canvasPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return inApp(
    page,
    (t, p) => {
      const { width, height } = t.getState().canvas
      // The document canvas: sized to the document's aspect and on top at
      // its centre (overlays above it don't take pointer events).
      for (const el of Array.from(document.querySelectorAll('canvas'))) {
        const r = el.getBoundingClientRect()
        if (r.width < 4 || r.height < 4) continue
        if (Math.abs(r.width / r.height - width / height) > 0.02) continue
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        if (hit !== el) continue
        return {
          x: r.left + ((p.x + 0.5) * r.width) / width,
          y: r.top + ((p.y + 0.5) * r.height) / height
        }
      }
      throw new Error('document canvas not found on screen')
    },
    { x, y }
  )
}

/** Undo history of the active document. */
export async function historyInfo(page: Page): Promise<{ count: number; index: number; labels: string[] }> {
  return inApp(page, (t) => {
    const h = t.scope().history
    return { count: h.entries.length, index: h.currentIndex, labels: h.entries.map((e) => e.label) }
  })
}

/** A pixel of a layer in canvas space, in the layer's native format
 *  (0–255 for rgba8; floats for rgba32f). */
export async function layerPixel(page: Page, layerId: string, x: number, y: number): Promise<number[]> {
  return inApp(
    page,
    (t, p) => {
      const d = t.canvas!.getLayerCanvasData(p.layerId)
      if (!d) throw new Error(`layer ${p.layerId} has no pixels`)
      const w = t.getState().canvas.width
      const i = (p.y * w + p.x) * 4
      return Array.from(d.slice(i, i + 4))
    },
    { layerId, x, y }
  )
}
