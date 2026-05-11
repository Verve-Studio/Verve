import { createGpuTexture } from "../utils";
import { GpuDevice } from "../device/GpuDevice";
import { ResourceCache } from "../resources/ResourceCache";
import { LayerTextureStore } from "../layers/LayerTextureStore";
import { getStrategy } from "../layers/formats";
import { RenderCache } from "../frame/RenderCache";
import { DisplayPresenter } from "../frame/DisplayPresenter";
import { RenderPlanExecutor, type RenderPlanResult } from "../frame/RenderPlanExecutor";
import { PixelReadback } from "../pixelio/PixelReadback";
import { EffectEncoder } from "../EffectEncoder";
import { initGrabCutCompute } from "../compute/grabcutCompute";
import { destroyTrackedTexture } from "@/core/store/memoryStore";
import { encodeClearTexture } from "./copyEncoders";
import {
  makeTouchedBuffer,
  clearTouchedBuffer,
  type TouchedBuffer,
} from "@/core/tools/_shared/primitives";
import {
  getPixelOpsSync,
  allocWasmU8,
  allocWasmF32,
  freeWasm,
} from "@/wasm";

// ─── Re-export all public types from the types module ─────────────────────────
// All existing import sites use '@/webgpu/WebGPURenderer' — this keeps them working.
export type { GpuLayer, EffectRenderOp, RenderPlanEntry } from "../types";
export type { RenderPlanResult } from "../frame/RenderPlanExecutor";
export type { TouchedBuffer } from "@/core/tools/_shared/primitives";
export { BLEND_MODE_INDEX, WebGPUUnavailableError } from "../types";

import type { GpuLayer, RenderPlanEntry } from "../types";
import type { PixelFormat, RGBAColor } from "@/types";

/**
 * If the WASM module is loaded, copy `layer.data`'s bytes into a fresh
 * WASM-heap allocation and replace `layer.data` with a view into it.
 * Sets `layer.wasmPtr` so kernels can read/write the layer in-place
 * without slice marshalling. The growth-refresh callback rebinds
 * `layer.data` if WASM memory grows later. No-op when WASM isn't loaded
 * yet or the alloc fails — layer stays JS-heap-backed.
 */
function pinLayerToWasm(layer: GpuLayer): void {
  const m = getPixelOpsSync();
  if (!m) return;
  const src = layer.data;
  if (layer.format === "rgba32f") {
    const f32 = src as Float32Array;
    const got = allocWasmF32(m, f32.length, (newView) => {
      layer.data = newView;
    });
    if (!got) return;
    got.view.set(f32);
    layer.data = got.view;
    layer.wasmPtr = got.ptr;
  } else {
    const u8 = src as Uint8Array;
    const got = allocWasmU8(m, u8.length, (newView) => {
      layer.data = newView;
    });
    if (!got) return;
    got.view.set(u8);
    layer.data = got.view;
    layer.wasmPtr = got.ptr;
  }
}

/** Release a layer's WASM-heap allocation if it was pinned. */
function unpinLayerFromWasm(layer: GpuLayer): void {
  if (layer.wasmPtr === undefined) return;
  const m = getPixelOpsSync();
  if (m) freeWasm(m, layer.wasmPtr);
  layer.wasmPtr = undefined;
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

export class WebGPURenderer {
  readonly gpu: GpuDevice;
  readonly resources: ResourceCache;
  readonly layerTextures: LayerTextureStore;
  readonly readback: PixelReadback;
  readonly presenter: DisplayPresenter;
  readonly executor: RenderPlanExecutor;
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;

  // Adjustment compute encoder (owns all 25 compute pipelines + texture caches)
  private readonly adjEncoder: EffectEncoder;

  // Per-frame render caches (adj-group, baked-locked, standalone-op, composite-layer,
  // last-rendered offsets). Lifecycle: entries written by encodeSubPlan, evicted
  // by RenderCache.disposeFor() when a layer is destroyed.
  readonly cache = new RenderCache();

  /** Wire the render trigger used by the executor's strokeEnd. */
  setRefreshCallback(cb: (() => void) | null): void {
    this.executor.refreshCallback = cb;
  }

  /** Begin a continuous painting stroke. While active, attached effects /
   *  adjustments are bypassed for real-time feedback. */
  strokeStart(): void {
    this.executor.strokeStart();
  }

  /** End the stroke and trigger one final render. */
  strokeEnd(): void {
    this.executor.strokeEnd();
  }

  /** Toggle preview mode (drag). Standalone effects (bloom, halation, etc.)
   *  are skipped while on; restored on pointer-up. */
  setPreviewMode(enabled: boolean): void {
    this.executor.setPreviewMode(enabled);
  }

  /** Force the next renderPlan() to actually execute even if inputs look identical. */
  invalidateRenderCache(): void {
    this.executor.invalidateRenderCache();
  }

  /**
   * Signal that the swapchain backing buffer was reallocated (e.g. zoom changed
   * displayScale and the canvas element resized). The composited pixels in
   * stableTex are still valid; we only need the next renderPlan() to re-blit
   * stableTex to the new swapchain. Avoids the multi-hundred-MB cost of
   * invalidating the entire layer composite cache for a pure viewport resize.
   */
  markViewportDirty(): void {
    this.presenter.markViewportDirty();
  }

  /** Restrict checker + blit-to-screen writes to this rect in backing pixels. Pass null to disable. */
  setViewportScissor(
    rect: { x: number; y: number; w: number; h: number } | null,
  ): void {
    this.presenter.setViewportScissor(rect);
  }

  /**
   * Re-blit the cached stableTex to the swapchain with no viewport scissor so
   * the entire canvas backing buffer holds a valid composite. Used by the
   * navigator-thumbnail mirror path. No-op when the stable cache is cold.
   */
  repaintScreenNoScissor(): void {
    if (!this.executor.hasStableTex || this.executor.stableTex === null) return;
    const encoder = this.device.createCommandEncoder();
    const screenView = this.context.getCurrentTexture().createView();
    this.presenter.presentToScreenNoScissor(encoder, this.executor.stableTex, screenView);
    this.device.queue.submit([encoder.finish()]);
  }


  readonly pixelWidth: number;
  readonly pixelHeight: number;
  private readonly internalFormat: GPUTextureFormat;
  deferFlush = false;
  /** Lazily-allocated per-stroke max-coverage buffer, shared across tools.
   *  See {@link acquireTouchedBuffer}. */
  private touchedBuffer: TouchedBuffer | null = null;

  /**
   * Hand the active tool a fresh-zeroed `TouchedBuffer` sized to the canvas.
   * Allocated once per renderer (16 MB at 4K, 2 MB at 1080p), reused across
   * strokes — `Uint8Array.fill(0)` is memcpy-speed. Only one tool is active
   * at a time so a single shared instance is safe.
   */
  acquireTouchedBuffer(): TouchedBuffer {
    if (
      !this.touchedBuffer ||
      this.touchedBuffer.width !== this.pixelWidth ||
      this.touchedBuffer.height !== this.pixelHeight
    ) {
      // Free any previous WASM-pinned buffer before reallocating so we
      // don't leak the heap pages on canvas resize.
      if (this.touchedBuffer?.wasmPtr !== undefined) {
        const m = getPixelOpsSync();
        if (m) freeWasm(m, this.touchedBuffer.wasmPtr);
      }
      this.touchedBuffer = makeTouchedBuffer(this.pixelWidth, this.pixelHeight);
      // Try to pin to WASM heap so the brush kernel can read/write
      // touched in-place via its ptr — no slice marshalling per stamp.
      const m = getPixelOpsSync();
      if (m) {
        const buf = this.touchedBuffer;
        const got = allocWasmU8(m, buf.data.length, (newView) => {
          // Heap grew; re-bind the view so any external readers see the
          // current memory.
          buf.data = newView as Uint8Array;
        });
        if (got) {
          buf.data = got.view;
          buf.wasmPtr = got.ptr;
        }
      }
      // Fresh buffer is already zeroed by `new Uint8Array`; nothing to clear.
    } else {
      // Reuse the existing buffer. If the previous tool recorded the bbox
      // it painted into, clear ONLY that region — for a 500-px brush on
      // A1 that's 250 KB instead of 70 MB. Tools that don't record (e.g.
      // pencil, eraser) leave `lastDirtyRect` undefined and we fall back
      // to the canvas-sized fill.
      const buf = this.touchedBuffer;
      const rect = buf.lastDirtyRect;
      if (rect) {
        const lx = Math.max(0, Math.floor(rect.lx));
        const ly = Math.max(0, Math.floor(rect.ly));
        const rx = Math.min(buf.width, Math.ceil(rect.rx));
        const ry = Math.min(buf.height, Math.ceil(rect.ry));
        if (rx > lx && ry > ly) {
          const w = rx - lx;
          const data = buf.data;
          for (let y = ly; y < ry; y++) {
            data.fill(0, y * buf.width + lx, y * buf.width + lx + w);
          }
        }
        buf.lastDirtyRect = undefined;
      } else {
        clearTouchedBuffer(buf);
      }
    }
    return this.touchedBuffer;
  }

  // ─── Factory ────────────────────────────────────────────────────────────────

  /**
   * Construct a WebGPURenderer for the given canvas. Acquires a high-performance
   * GPU adapter, requests a device with maximum texture/buffer limits, configures
   * the canvas's WebGPU context, and chooses an internal texture format based on
   * the requested pixel format (rgba8unorm for 'rgba8'/'indexed8', rgba32float
   * for HDR 'rgba32f' workflows).
   *
   * @throws WebGPUUnavailableError if `navigator.gpu` is missing, no adapter can
   * be obtained, or the canvas WebGPU context cannot be created.
   */
  static async create(
    canvas: HTMLCanvasElement,
    pixelWidth: number,
    pixelHeight: number,
    pixelFormat: PixelFormat = "rgba8",
  ): Promise<WebGPURenderer> {
    const gpu = await GpuDevice.create(canvas);
    const internalFormat: GPUTextureFormat =
      pixelFormat === "rgba32f" ? "rgba32float" : "rgba8unorm";
    return new WebGPURenderer(
      gpu,
      pixelWidth,
      pixelHeight,
      internalFormat,
      pixelFormat,
    );
  }

  /**
   * Private — call {@link WebGPURenderer.create} instead. Allocates every
   * long-lived GPU resource the renderer needs (sampler, ping-pong textures,
   * composite/checker/HDR-blit pipelines, the adjustment compute encoder,
   * filter and grab-cut compute backends, and the static checker uniform).
   */
  private constructor(
    gpu: GpuDevice,
    pixelWidth: number,
    pixelHeight: number,
    internalFormat: GPUTextureFormat,
    pixelFormat: PixelFormat,
  ) {
    this.gpu = gpu;
    this.device = gpu.device;
    this.context = gpu.context;
    this.pixelWidth = pixelWidth;
    this.pixelHeight = pixelHeight;
    this.internalFormat = internalFormat;

    // Long-lived GPU resources (pipelines, samplers, BGLs, shared buffers,
    // identity LUT placeholders) live in the resource cache.
    this.resources = new ResourceCache(
      gpu,
      pixelWidth,
      pixelHeight,
      internalFormat,
    );
    this.layerTextures = new LayerTextureStore(gpu);
    this.readback = new PixelReadback(gpu);
    this.presenter = new DisplayPresenter(gpu, this.resources, pixelFormat);
    // Field aliases — the renderer's body still references these names heavily;
    // they're cheap pointers into the resource cache. Phase 7 will collapse
    // these into direct `this.resources.X` reads.

    // Adjustment compute encoder (owns all 25 compute pipelines + texture caches)
    this.adjEncoder = new EffectEncoder(
      gpu.device,
      pixelWidth,
      pixelHeight,
      this.internalFormat,
    );

    initGrabCutCompute(this.device);

    this.executor = new RenderPlanExecutor({
      gpu,
      resources: this.resources,
      layerTextures: this.layerTextures,
      presenter: this.presenter,
      cache: this.cache,
      adjEncoder: this.adjEncoder,
      pixelWidth,
      pixelHeight,
      pixelFormat,
      internalFormat,
    });
  }


  /** GPU texture format used for the renderer's internal compositing buffers
   *  (rgba8unorm for SDR pipelines, rgba32float for HDR). External callers
   *  (e.g. EffectEncoder pipelines) need this to build matching pipelines. */
  get internalTextureFormat(): GPUTextureFormat {
    return this.internalFormat;
  }

  // ─── Layer management ───────────────────────────────────────────────────────

  /**
   * Allocate a new {@link GpuLayer} with backing CPU data and an empty GPU
   * texture. The CPU buffer is allocated through the memory store (so it's
   * tracked for OOM diagnostics); the GPU texture starts uninitialised — the
   * caller must call {@link flushLayer} after writing pixel data to upload it.
   *
   * @param lw     Layer width  (defaults to canvas width).
   * @param lh     Layer height (defaults to canvas height).
   * @param ox/oy  Position of the layer's top-left corner in canvas pixels.
   * @param format `'rgba8'` (1 byte/channel SDR), `'rgba32f'` (HDR), or
   *               `'indexed8'` (1 byte palette index per pixel).
   */
  createLayer(
    id: string,
    name: string,
    lw = this.pixelWidth,
    lh = this.pixelHeight,
    ox = 0,
    oy = 0,
    format: PixelFormat = "rgba8",
  ): GpuLayer {
    const layer: GpuLayer = {
      id,
      name,
      texture: null as unknown as GPUTexture, // overwritten by register()
      data: getStrategy(format).allocateBuffer(lw, lh),
      format,
      layerWidth: lw,
      layerHeight: lh,
      offsetX: ox,
      offsetY: oy,
      opacity: 1,
      visible: true,
      blendMode: "normal",
      contentVersion: 0,
      colorSpace: "auto",
    };
    // Promote layer storage to the WASM heap when the module is loaded.
    // Lets the brush kernel (and any future per-pixel kernel) read/write
    // the layer in-place — no slice marshalling per stamp.
    pinLayerToWasm(layer);
    this.layerTextures.register(layer);
    return layer;
  }

  /**
   * Upload the layer's CPU pixel data to its GPU texture and mark the
   * affected canvas region dirty. If `layer.dirtyRect` is set, only that
   * sub-region is uploaded (cheap during brush strokes); otherwise the full
   * layer is re-uploaded. Bumps `contentVersion` so caches that key on it
   * (adj-group cache, plan fingerprint) invalidate correctly. No-op while
   * `deferFlush` is true (used to batch multi-step edits).
   *
   * @param palette Required when `layer.format === 'indexed8'`; supplies the
   *                colour table used to expand indices into RGBA before upload.
   */
  flushLayer(layer: GpuLayer, palette?: readonly RGBAColor[]): void {
    if (this.deferFlush) return;
    const rect = this.layerTextures.flush(layer, palette);
    this.executor.unionFrameDirty(rect.canvasX, rect.canvasY, rect.w, rect.h);
  }

  /** Expand the layer's pending dirty region by the given layer-local rect.
   *  Tools call this after editing pixels in `layer.data` so the next
   *  {@link flushLayer} only uploads the changed sub-region. */
  markDirtyRect(
    layer: GpuLayer,
    lx: number,
    ly: number,
    rx: number,
    ry: number,
  ): void {
    this.layerTextures.markDirty(layer, lx, ly, rx, ry);
  }

  /** Mark the entire layer dirty (full re-upload on next flush). */
  markFullDirty(layer: GpuLayer): void {
    this.layerTextures.markFullDirty(layer);
  }

  /**
   * Swap a layer's pixel data for a brand-new buffer (and possibly a different
   * pixel format). Destroys the old GPU texture, creates a fresh one matching
   * the new format, and uploads `newData` via {@link flushLayer}. Used by
   * format-conversion flows like switching a layer between rgba8 and rgba32f.
   */
  replaceLayerData(
    layer: GpuLayer,
    newData: Uint8Array | Float32Array,
    newFormat: PixelFormat,
    palette?: RGBAColor[],
  ): void {
    const textureFormat: GPUTextureFormat =
      newFormat === "rgba32f" ? "rgba32float" : "rgba8unorm";
    const newTex = createGpuTexture(
      this.device,
      layer.layerWidth,
      layer.layerHeight,
      null,
      textureFormat,
    );
    // Re-pin to WASM heap so the new buffer is in shared memory too
    // (the brush kernel checks `wasmPtr` to decide on the zero-copy path).
    unpinLayerFromWasm(layer);
    layer.data = newData;
    layer.format = newFormat;
    pinLayerToWasm(layer);
    this.layerTextures.replaceTexture(
      layer,
      newTex,
      layer.layerWidth,
      layer.layerHeight,
      newFormat,
    );
    this.flushLayer(layer, palette);
  }

  /**
   * Release every GPU resource and cache entry associated with this layer:
   * its texture, any cached adj-group / standalone-op / composite-layer
   * output, plus the entry tracking its last-rendered offset for drag
   * detection. Safe to call even if the layer has no cached output.
   */
  destroyLayer(layer: GpuLayer): void {
    this.layerTextures.dispose(layer.id);
    this.cache.disposeFor(layer.id);
    unpinLayerFromWasm(layer);
  }

  /**
   * Resize the layer in-place so a brush dab at canvas-space (canvasX, canvasY)
   * with `extraRadius` margin fits inside the layer's bounds. Doubles the
   * layer's width/height as needed (keeping the layer centred on the canvas)
   * and clamps to canvas bounds. The existing pixel data is reblitted into
   * the new larger buffer at its same canvas-space position.
   *
   * @returns `true` if the layer was actually resized, `false` if the dab
   *          either already fit or was entirely outside the canvas.
   */
  growLayerToFit(
    layer: GpuLayer,
    canvasX: number,
    canvasY: number,
    extraRadius = 0,
  ): boolean {
    // Never grow the layer beyond canvas bounds — pointer may be outside the canvas.
    if (
      canvasX + extraRadius < 0 ||
      canvasX - extraRadius >= this.pixelWidth ||
      canvasY + extraRadius < 0 ||
      canvasY - extraRadius >= this.pixelHeight
    )
      return false;

    const lx = canvasX - layer.offsetX - extraRadius;
    const ly = canvasY - layer.offsetY - extraRadius;
    const rx = canvasX - layer.offsetX + extraRadius;
    const ry = canvasY - layer.offsetY + extraRadius;

    const fitsX = lx >= 0 && rx < layer.layerWidth;
    const fitsY = ly >= 0 && ry < layer.layerHeight;
    if (fitsX && fitsY) return false;

    const cx = this.pixelWidth / 2;
    const cy = this.pixelHeight / 2;

    let newX = layer.offsetX;
    let newY = layer.offsetY;
    let newW = layer.layerWidth;
    let newH = layer.layerHeight;

    if (!fitsX) {
      while (
        canvasX - extraRadius < newX ||
        canvasX + extraRadius >= newX + newW
      ) {
        newW *= 2;
        newX = Math.round(cx - newW / 2);
      }
    }
    if (!fitsY) {
      while (
        canvasY - extraRadius < newY ||
        canvasY + extraRadius >= newY + newH
      ) {
        newH *= 2;
        newY = Math.round(cy - newH / 2);
      }
    }

    // Clamp layer bounds to canvas — doubling can push bounds beyond the canvas edge
    if (newX < 0) {
      newW += newX;
      newX = 0;
    }
    if (newY < 0) {
      newH += newY;
      newY = 0;
    }
    if (newX + newW > this.pixelWidth) newW = this.pixelWidth - newX;
    if (newY + newH > this.pixelHeight) newH = this.pixelHeight - newY;

    // If the doubling-then-clamping landed us back on the same geometry
    // (which is what happens for any canvas-sized layer once a stamp gets
    // near the edge — `fitsX` failed only because the *padded* stamp
    // bbox poked past the layer, not because the layer needs to grow),
    // skip the entire realloc + reblit + GPU upload. Without this guard
    // every edge-adjacent stamp on a 4K layer pays a 64 MB CPU copy +
    // GPU upload for no functional change — the slowdown you feel at
    // the edges.
    if (
      newX === layer.offsetX &&
      newY === layer.offsetY &&
      newW === layer.layerWidth &&
      newH === layer.layerHeight
    ) {
      return false;
    }

    const copyX = layer.offsetX - newX;
    const copyY = layer.offsetY - newY;
    const strategy = getStrategy(layer.format);

    const newData = strategy.allocateBuffer(newW, newH);
    strategy.reblitForGrow(layer, newData, newW, copyX, copyY);

    const newTex = createGpuTexture(
      this.device,
      newW,
      newH,
      null,
      strategy.gpuTextureFormat,
    );
    strategy.uploadAfterGrow(this.device, newTex, newW, newH, newData);

    // Grow swaps the entire pixel buffer; re-pin the new one to WASM heap
    // so kernel zero-copy stays available after the layer extends past
    // its previous bounds (common during long brush strokes).
    unpinLayerFromWasm(layer);
    layer.data = newData;
    layer.layerWidth = newW;
    layer.layerHeight = newH;
    layer.offsetX = newX;
    layer.offsetY = newY;
    pinLayerToWasm(layer);
    this.layerTextures.replaceTexture(layer, newTex, newW, newH, layer.format);
    // Bump version since texture content changed.
    layer.contentVersion = this.layerTextures.getVersion(layer.id) + 1;
    return true;
  }

  // ─── Pixel operations (CPU-side, layer-local coords) ────────────────────────

  /** Write an RGBA pixel into the layer's CPU buffer at layer-local (x, y).
   *  Out-of-bounds writes are silently skipped. Doesn't touch the GPU —
   *  caller must {@link flushLayer} to push changes. */
  drawPixel(
    layer: GpuLayer,
    x: number,
    y: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    getStrategy(layer.format).drawPixel(layer, x, y, r, g, b, a);
  }

  /** Set the layer-local pixel at (x, y) to fully transparent (0,0,0,0). */
  erasePixel(layer: GpuLayer, x: number, y: number): void {
    this.drawPixel(layer, x, y, 0, 0, 0, 0);
  }

  /** Read the RGBA value at layer-local (x, y) directly from the CPU buffer.
   *  Returns values in the layer's native range (0-255 for rgba8/indexed8,
   *  0.0-1.0+ for rgba32f, [index, 0, 0, 255] for indexed8).
   *  Returns (0,0,0,0) for out-of-bounds coordinates. */
  samplePixel(
    layer: GpuLayer,
    x: number,
    y: number,
  ): [number, number, number, number] {
    return getStrategy(layer.format).samplePixel(layer, x, y);
  }

  /** Translate canvas-space (canvasX, canvasY) into the layer's local coords.
   *  Returns null if the point falls outside the layer's bbox — useful for
   *  short-circuiting tools that operate on a single layer. */
  canvasToLayer(
    layer: GpuLayer,
    canvasX: number,
    canvasY: number,
  ): { x: number; y: number } | null {
    const lx = canvasX - layer.offsetX;
    const ly = canvasY - layer.offsetY;
    if (lx < 0 || ly < 0 || lx >= layer.layerWidth || ly >= layer.layerHeight)
      return null;
    return { x: lx, y: ly };
  }

  /** Like {@link canvasToLayer} but without the bbox check — the result may
   *  be negative or beyond the layer's dimensions. Used when the caller will
   *  perform its own bounds checking (e.g. brush stroke segment iterators). */
  canvasToLayerUnchecked(
    layer: GpuLayer,
    canvasX: number,
    canvasY: number,
  ): { x: number; y: number } {
    return { x: canvasX - layer.offsetX, y: canvasY - layer.offsetY };
  }

  /** Convenience: sample the layer at canvas-space (canvasX, canvasY). */
  sampleCanvasPixel(
    layer: GpuLayer,
    canvasX: number,
    canvasY: number,
  ): [number, number, number, number] {
    return this.samplePixel(
      layer,
      canvasX - layer.offsetX,
      canvasY - layer.offsetY,
    );
  }

  /** Convenience: write an RGBA pixel at canvas-space (canvasX, canvasY). */
  drawCanvasPixel(
    layer: GpuLayer,
    canvasX: number,
    canvasY: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    this.drawPixel(
      layer,
      canvasX - layer.offsetX,
      canvasY - layer.offsetY,
      r,
      g,
      b,
      a,
    );
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────

  /**
   * Render a flat list of layers (bottom-to-top) into the swapchain. Convenience
   * wrapper that synthesises a trivial render plan and delegates to
   * {@link renderPlan}. For complex stacks (groups, composite layers,
   * adjustments) build a {@link RenderPlanEntry} list and call renderPlan
   * directly.
   */
  render(layers: GpuLayer[], maskMap?: Map<string, GpuLayer>): void {
    this.executor.render(layers, maskMap);
  }

  /**
   * Composite a render plan into the swapchain. The renderer's hot path:
   *
   * 1. Compute a plan fingerprint and short-circuit when identical to the
   *    last frame (skips ~278 MB of GPU work on a no-op render).
   * 2. Synthesise a drag-induced dirty rect by comparing each layer's offset
   *    to its last-rendered position.
   * 3. Choose between the **incremental** path (small dirty rect + flat plan
   *    + valid stable cache → composite only the dirty subrect into stableTex
   *    then blit to the swapchain) and the **full** path (re-composite every
   *    layer over the whole canvas, snapshot into stableTex).
   * 4. Snapshot the rendered offsets so the next frame can detect drag deltas.
   */
  renderPlan(plan: RenderPlanEntry[]): RenderPlanResult {
    return this.executor.renderPlan(plan);
  }


  // ─── Flatten / readback ─────────────────────────────────────────────────────

  /** Return a *copy* of the layer's CPU pixel buffer. Format matches the
   *  layer's pixel format (Uint8Array for rgba8/indexed8, Float32Array for
   *  rgba32f). Cheap — pure CPU memcpy, no GPU readback. */
  readLayerPixels(layer: GpuLayer): Uint8Array | Float32Array {
    return layer.data.slice() as Uint8Array | Float32Array;
  }

  /**
   * Composite a flat layer list and return the resulting pixel buffer (RGBA8
   * or float32 RGBA depending on the renderer's internal format). Used by
   * export, copy-to-clipboard, and similar full-canvas readback flows.
   * Async because GPU buffer mapping is async.
   */
  async readFlattenedPixels(
    layers: GpuLayer[],
    maskMap?: Map<string, GpuLayer>,
  ): Promise<Uint8Array | Float32Array> {
    const plan: RenderPlanEntry[] = layers.map((layer) => ({
      kind: "layer" as const,
      layer,
      mask: maskMap?.get(layer.id),
    }));
    return this.readFlattenedPlan(plan);
  }

  /**
   * Composite a render plan and return the result as a packed CPU pixel
   * buffer. Same as {@link readFlattenedPixels} but accepts arbitrary
   * {@link RenderPlanEntry}s (groups, composite layers, adjustments).
   */
  async readFlattenedPlan(
    plan: RenderPlanEntry[],
  ): Promise<Uint8Array | Float32Array> {
    const { device, pixelWidth: w, pixelHeight: h } = this;
    const encoder = device.createCommandEncoder();
    const finalTex = this.executor.encodePlanToComposite(encoder, plan);
    return this.readback.readTexture(
      encoder,
      finalTex,
      w,
      h,
      this.internalFormat === "rgba32float",
      () => this.executor.flushPendingDestroys(),
    );
  }

  /**
   * Read the pixel buffer that a specific adjustment layer would *receive as
   * input* — i.e. the base layer composited and then run through every
   * upstream adjustment in the same group, but stopping before
   * `adjustmentLayerId` itself executes. Used by adjustment UIs (Curves,
   * Levels, etc.) to compute histograms or thumbnails of "what this filter is
   * about to operate on".
   *
   * @returns null if the adjustment layer can't be found in any group, or if
   * its index in the group is invalid.
   */
  async readAdjustmentInputPlan(
    plan: RenderPlanEntry[],
    adjustmentLayerId: string,
  ): Promise<Uint8Array | Float32Array | null> {
    const groupEntry = plan.find(
      (
        entry,
      ): entry is Extract<RenderPlanEntry, { kind: "adjustment-group" }> =>
        entry.kind === "adjustment-group" &&
        entry.adjustments.some((op) => op.layerId === adjustmentLayerId),
    );
    if (!groupEntry) return null;

    const targetIndex = groupEntry.adjustments.findIndex(
      (op) => op.layerId === adjustmentLayerId,
    );
    if (targetIndex < 0) return null;

    const { device, pixelWidth: w, pixelHeight: h } = this;
    const encoder = device.createCommandEncoder();

    // Clear dst; src (groupPongTex) needs no clearing — only written before being read
    encodeClearTexture(encoder, this.executor.groupPingTex);

    let srcTex = this.executor.groupPongTex;
    let dstTex = this.executor.groupPingTex;

    const baseAsSource: GpuLayer = {
      ...groupEntry.baseLayer,
      opacity: 1,
      blendMode: "normal",
    };
    this.executor.encodeCompositeLayer(
      encoder,
      baseAsSource,
      srcTex,
      dstTex,
      groupEntry.baseMask,
      true,
    );
    [srcTex, dstTex] = [dstTex, srcTex];

    for (let i = 0; i < targetIndex; i++) {
      const op = groupEntry.adjustments[i];
      if (!op.visible) continue;
      this.adjEncoder.encode(encoder, op, srcTex, dstTex, this.internalFormat);
      [srcTex, dstTex] = [dstTex, srcTex];
    }

    return this.readback.readTexture(
      encoder,
      srcTex,
      w,
      h,
      this.internalFormat === "rgba32float",
      () => this.executor.flushPendingDestroys(),
    );
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Release every long-lived GPU resource owned by the renderer. Destroys
   * ping-pong textures, the texcoord vertex buffer, the EffectEncoder,
   * every cached adj-group / baked-locked / standalone-op / composite-layer
   * texture, and the pooled composite uniform/vertex buffers, then unconfigures
   * the canvas context. The shared GPUDevice is NOT destroyed — it persists
   * for the process lifetime and is reused by subsequent renderers.
   */
  destroy(): void {
    this.executor.refreshCallback = null;
    this.executor.destroy();
    this.adjEncoder.destroy();
    this.readback.destroy();
    if (this.executor.stableTex !== null) {
      destroyTrackedTexture(this.executor.stableTex);
      this.executor.stableTex = null;
    }
    for (const entry of this.cache.adjGroup.values())
      destroyTrackedTexture(entry.tex);
    this.cache.adjGroup.clear();
    for (const tex of this.cache.bakedLocked.values())
      destroyTrackedTexture(tex);
    this.cache.bakedLocked.clear();
    for (const entry of this.cache.standaloneOp.values())
      destroyTrackedTexture(entry.tex);
    this.cache.standaloneOp.clear();
    for (const entry of this.cache.compositeLayer.values())
      destroyTrackedTexture(entry.tex);
    this.cache.compositeLayer.clear();
    this.gpu.destroy();
  }
}
