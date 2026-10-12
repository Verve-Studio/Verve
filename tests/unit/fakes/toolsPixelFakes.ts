// CPU-only stand-ins for the parts of WebGPURenderer / GpuLayer that the
// tool pixel helpers (blendPixelOver, stroke modules, stamp engine) touch.
// Pixel reads/writes go through the real format strategies so indexed8 /
// rgba32f semantics match production.
import type { GpuLayer, WebGPURenderer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { getStrategy } from "@/graphics/webgpu/layers/formats";
import type { PixelFormat } from "@/types";
import { makeTouchedBuffer, type TouchedBuffer } from "@/core/tools/_shared/primitives";

export interface DirtyRect {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
}

export interface FakeRenderer {
  pixelWidth: number;
  pixelHeight: number;
  /** Every markDirtyRect call, per layer id (layer-local, exclusive right/bottom). */
  dirty: Map<string, DirtyRect[]>;
  flushed: string[];
  samplePixel(layer: GpuLayer, x: number, y: number): [number, number, number, number];
  drawPixel(layer: GpuLayer, x: number, y: number, r: number, g: number, b: number, a: number): void;
  markDirtyRect(layer: GpuLayer, lx: number, ly: number, rx: number, ry: number): void;
  hasPendingUpload(layer: GpuLayer): boolean;
  flushLayer(layer: GpuLayer): void;
  replaceLayerData(layer: GpuLayer, data: Uint8Array | Float32Array, format: PixelFormat): void;
  strokeEnd(): void;
}

export function makeFakeRenderer(width: number, height: number): FakeRenderer {
  const dirty = new Map<string, DirtyRect[]>();
  const flushed: string[] = [];
  return {
    pixelWidth: width,
    pixelHeight: height,
    dirty,
    flushed,
    samplePixel: (layer, x, y) => getStrategy(layer.format).samplePixel(layer, x, y),
    drawPixel: (layer, x, y, r, g, b, a) =>
      getStrategy(layer.format).drawPixel(layer, x, y, r, g, b, a),
    markDirtyRect(layer, lx, ly, rx, ry) {
      const list = dirty.get(layer.id) ?? [];
      list.push({ lx, ly, rx, ry });
      dirty.set(layer.id, list);
    },
    hasPendingUpload: (layer) => (dirty.get(layer.id)?.length ?? 0) > 0,
    flushLayer(layer) {
      flushed.push(layer.id);
      dirty.delete(layer.id);
    },
    replaceLayerData(layer, data, format) {
      layer.data = data;
      layer.format = format;
      flushed.push(layer.id);
    },
    strokeEnd() {},
  };
}

/** Cast for APIs typed as the real renderer. */
export const asRenderer = (r: FakeRenderer): WebGPURenderer => r as unknown as WebGPURenderer;

let layerSeq = 0;

export function makeLayer(
  format: PixelFormat,
  width: number,
  height: number,
  opts: { offsetX?: number; offsetY?: number; fill?: readonly number[] } = {},
): GpuLayer {
  const n = width * height;
  const data =
    format === "rgba32f"
      ? new Float32Array(n * 4)
      : format === "indexed8"
        ? new Uint8Array(n).fill(255)
        : new Uint8Array(n * 4);
  if (opts.fill) {
    const ch = format === "indexed8" ? 1 : 4;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) data[i * ch + c] = opts.fill[c];
  }
  return {
    id: `test-layer-${++layerSeq}`,
    name: "test",
    texture: null as unknown as GPUTexture,
    data,
    format,
    layerWidth: width,
    layerHeight: height,
    offsetX: opts.offsetX ?? 0,
    offsetY: opts.offsetY ?? 0,
    opacity: 1,
    visible: true,
    blendMode: "normal",
    contentVersion: 0,
    colorSpace: "auto",
  };
}

export function makeTouched(width: number, height: number): TouchedBuffer {
  return makeTouchedBuffer(width, height);
}

/** RGBA tuple of a rgba8 / rgba32f layer at layer-local (x, y). */
export function px(layer: GpuLayer, x: number, y: number): number[] {
  const i = (y * layer.layerWidth + x) * 4;
  return Array.from(layer.data.subarray(i, i + 4));
}

/** Union of all dirty rects marked on a layer, or null. */
export function dirtyUnion(r: FakeRenderer, layer: GpuLayer): DirtyRect | null {
  const list = r.dirty.get(layer.id);
  if (!list || list.length === 0) return null;
  return list.reduce((a, b) => ({
    lx: Math.min(a.lx, b.lx),
    ly: Math.min(a.ly, b.ly),
    rx: Math.max(a.rx, b.rx),
    ry: Math.max(a.ry, b.ry),
  }));
}

/** True when layer-local (x, y) lies inside some marked dirty rect. */
export function isMarkedDirty(r: FakeRenderer, layer: GpuLayer, x: number, y: number): boolean {
  return (r.dirty.get(layer.id) ?? []).some(
    (d) => x >= d.lx && x < d.rx && y >= d.ly && y < d.ry,
  );
}

/** Deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
