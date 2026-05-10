import {
  createGpuTexture,
  uploadTextureData,
  uploadTexturePatch,
  uploadF32TextureData,
  uploadF32TexturePatch,
  createUniformBuffer,
  createReadbackBuffer,
  createVertexBuffer,
  writeUniformBuffer,
} from "../utils";
import { EffectEncoder } from "../EffectEncoder";
import { initGrabCutCompute } from "../compute/grabcutCompute";
import { displayStore, OPERATOR_SHADER_ID } from "@/ux/main/Canvas/displayStore";
import {
  allocFloat32,
  allocUint8,
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";
import { serializeAdjOp, computeAdjGroupParamsKey } from "./cacheKeys";
import { QUAD_POSITIONS, QUAD_UVS } from "./quadGeometry";
import {
  createCompositePipeline,
  createCheckerPipeline,
  createHdrBlitPipeline,
} from "./pipelineFactories";
import { unpackRows, unpackF32Rows } from "./readbackUnpack";
import { expandIndicesToRgba8 } from "./indexedColorExpand";
import { encodeClearTexture, copyOutsideRect } from "./copyEncoders";

// ─── Re-export all public types from the types module ─────────────────────────
// All existing import sites use '@/webgpu/WebGPURenderer' — this keeps them working.
export type { GpuLayer, EffectRenderOp, RenderPlanEntry } from "../types";
export { BLEND_MODE_INDEX, WebGPUUnavailableError } from "../types";

import type { GpuLayer, RenderPlanEntry, EffectRenderOp } from "../types";
import { BLEND_MODE_INDEX, WebGPUUnavailableError } from "../types";
import type { PixelFormat, RGBAColor } from "@/types";

// ─── Renderer ─────────────────────────────────────────────────────────────────

export class WebGPURenderer {
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly sampler: GPUSampler;

  // Render pipelines
  private readonly compositePipeline: GPURenderPipeline; // renders to rgba8unorm internal textures
  private readonly compositeBGL: GPUBindGroupLayout;
  private readonly checkerPipeline: GPURenderPipeline; // renders to screen (canvasFormat)
  private readonly hdrBlitPipeline: GPURenderPipeline; // HDR display blit (tone-mapping)
  private readonly hdrBlitBGL: GPUBindGroupLayout;
  private readonly hdrUniformBuffer: GPUBuffer; // 16 bytes: exposureLinear, isFp32, operator u32, _pad

  // Adjustment compute encoder (owns all 25 compute pipelines + texture caches)
  private readonly adjEncoder: EffectEncoder;

  // Shared vertex/tex-coord buffers
  private readonly texCoordBuffer: GPUBuffer;

  // Pre-allocated per-frame reusable buffers and bind groups (avoids alloc/destroy on the render hot path)
  private readonly canvasQuadVertBuf: GPUBuffer;
  private readonly frameUniformBuf: GPUBuffer; // [w, h, 0, 0] — shared by blit and composite-resolution
  private readonly checkerUniformBuf: GPUBuffer;
  private checkerBindGroup!: GPUBindGroup;

  // Ping-pong textures
  private pingTex: GPUTexture;
  private pongTex: GPUTexture;
  private groupPingTex: GPUTexture;
  private groupPongTex: GPUTexture;

  // Temporary GPU buffers accumulated during composite encoding; flushed after submit.
  private pendingDestroyBuffers: GPUBuffer[] = [];
  // Temporary GPU textures for isolated group compositing; flushed after submit.
  private pendingDestroyTextures: GPUTexture[] = [];

  // Per-composite (uniform, vertex) buffer pool + per-slot bind-group cache.
  // The BG cache avoids recreating a GPUBindGroup every frame when the three textures
  // (layer, src ping-pong, mask) haven't changed object identity.
  private compositeBufferPool: {
    unif: GPUBuffer;
    pos: GPUBuffer;
    cachedBG: GPUBindGroup | null;
    cachedLayerTex: GPUTexture | null;
    cachedSrcTex: GPUTexture | null;
    cachedMaskTex: GPUTexture | null;
  }[] = [];
  private compositeBufferIndex = 0;

  // Pre-allocated scratch objects reused each frame to avoid GC pressure.
  // encodeCompositeLayer writes into compositeUnifAB synchronously before writeBuffer,
  // so a single instance can be safely shared across all pool slots within one frame.
  private readonly compositeUnifAB = new ArrayBuffer(64);
  private readonly compositeUnifView = new DataView(this.compositeUnifAB);
  private readonly compositeQuadF32 = new Float32Array(12);
  // encodeBlitToView scratch (16 bytes: exposureLinear f32, isFp32 f32, operator u32, _pad f32)
  private readonly blitUnifAB = new ArrayBuffer(16);
  private readonly blitUnifView = new DataView(this.blitUnifAB);
  // Per-srcTex blit bind-group cache. Only two entries ever exist (ping / pong).
  private readonly blitBindGroupCache = new Map<GPUTexture, GPUBindGroup>();

  // ─── Render cache ──────────────────────────────────────────────────────────
  // Per-adjustment-group output textures: skip re-running adjustment passes when
  // the base layer's pixel content, position, mask, and params are all unchanged.
  // Key = parentLayerId. Only used during screen-preview renderPlan() calls.
  private adjGroupCache = new Map<
    string,
    {
      baseContentVersion: number;
      offsetX: number;
      offsetY: number;
      baseMaskVersion: number; // -1 when there is no base mask
      baseMaskOffsetX: number;
      baseMaskOffsetY: number;
      paramsKey: string;
      tex: GPUTexture;
      lastEncodeTime: number; // performance.now() of the last real recompute
    }
  >();
  // Permanent baked output for locked layers. Once a locked layer's adjustment
  // group is computed once, the result is stored here and reused for every
  // subsequent frame with zero GPU compute. Evicted when the layer is unlocked.
  // Key = parentLayerId.
  private bakedLockedLayers = new Map<string, GPUTexture>();
  // Per standalone EffectRenderOp (group-scoped effects: bloom, halation, etc.)
  // output cache. Keyed by op.layerId. The cache hits when the accumulated input
  // (everything composited before this op in the plan) and the op params are
  // both unchanged — in which case we copy from the cached texture instead of
  // re-running the (potentially multi-pass) compute pipeline.
  private standaloneOpCache = new Map<
    string,
    {
      inputFp: string;
      paramsKey: string;
      tex: GPUTexture;
      lastEncodeTime: number;
    }
  >();
  // Per-composite-layer output cache. Keyed by layerId. Stores the final flattened+
  // adjusted result texture. The cache hits when all child contentVersions, offsets,
  // and adjustment params are identical to the previous frame.
  private compositeLayerCache = new Map<
    string,
    {
      childFp: string; // encodeSubPlan inputFp for children
      adjKey: string; // serialised adjustment params
      tex: GPUTexture;
    }
  >();
  // True while encoding a screen-preview renderPlan() — enables the adj-group cache.
  private adjGroupCacheEnabled = false;

  // Offsets and bounds of every layer/adjustment-group as of the last successful
  // renderPlan(). Compared against the current frame's offsets to detect a
  // drag-only delta and synthesize a dirty rect — the move tool changes
  // layer.offsetX/Y in place and never calls flushLayer, so without this the
  // incremental path would never fire during a drag and every frame would do
  // N full-canvas composites.
  private lastRenderedOffsets = new Map<
    string,
    { x: number; y: number; w: number; h: number }
  >();

  // ─── Stroke gating ────────────────────────────────────────────────────────
  // Continuous painting tools (brush, eraser, pencil, dodge, clone-stamp) call
  // strokeStart() on pointer-down and strokeEnd() on pointer-up. While a
  // stroke is active, attached effects/adjustments are NOT recomputed — the
  // throttle path composites the layer's raw pixels for real-time feedback.
  // strokeEnd() triggers the next render, where the cache miss path re-runs
  // the full effect chain. Without this, the user would see either: stale
  // effect output (if we kept the cache), or nothing (if we re-encoded per
  // paint event — way too slow for multi-pass effects like halation/bloom).
  private refreshCallback: (() => void) | null = null;
  private strokeActive = false;

  /** Wire the render trigger used by strokeEnd. */
  setRefreshCallback(cb: (() => void) | null): void {
    this.refreshCallback = cb;
  }

  /** Mark the start of a continuous painting stroke. While active, attached
   *  effects/adjustments are bypassed in favour of compositing the layer's
   *  raw pixels each frame. */
  strokeStart(): void {
    this.strokeActive = true;
  }

  /** Mark the end of a continuous painting stroke. Triggers a single render
   *  whose throttle gate is open, so the effect chain re-runs once on the
   *  final layer state. */
  strokeEnd(): void {
    if (!this.strokeActive) return;
    this.strokeActive = false;
    // Force the planFp short-circuit to miss so the cache miss path runs.
    this.lastPlanFp = null;
    this.refreshCallback?.();
  }
  // When true (e.g. during a whole-layer drag), standalone AdjustmentRenderOps
  // (bloom, halation, glow, drop-shadow, etc.) are skipped so the compositor
  // only re-runs them once on pointer-up. Layers with per-layer color adjustments
  // still render correctly because the adj-group cache handles those separately.
  private previewMode = false;

  /** Enable/disable preview mode. Call with true at drag start, false on pointer-up. */
  setPreviewMode(enabled: boolean): void {
    // Idempotent: the move tool calls this on every pointermove (which fires at
    // mouse rate, hundreds of Hz). Without the early-return, every pointermove
    // would invalidate hasStableTex and force the next renderPlan() onto the
    // full-canvas path — defeating the incremental drag optimization.
    if (this.previewMode === enabled) return;
    this.previewMode = enabled;
    // Mode change can flip skipped/visible without altering layer fingerprints.
    this.lastPlanFp = null;
    this.hasStableTex = false;
  }

  // ─── Render skip ─────────────────────────────────────────────────────────────
  // Fingerprint of the inputs that produced the most recently rendered frame.
  // If the next renderPlan() call has an identical fingerprint, the entire frame
  // is skipped (no encoder, no clear, no copy, no composite, no submit). At
  // 7000×9933 each redundant frame would otherwise burn ~278 MB clear plus
  // ~278 MB DMA per non-base layer.
  private lastPlanFp: string | null = null;

  /** Force the next renderPlan() to actually execute even if inputs look identical. */
  invalidateRenderCache(): void {
    this.lastPlanFp = null;
    this.hasStableTex = false;
  }

  /**
   * Signal that the swapchain backing buffer was reallocated (e.g. zoom changed
   * displayScale and the canvas element resized). The composited pixels in
   * stableTex are still valid; we only need the next renderPlan() to re-blit
   * stableTex to the new swapchain. Avoids the multi-hundred-MB cost of
   * invalidating the entire layer composite cache for a pure viewport resize.
   */
  markViewportDirty(): void {
    this.viewportDirty = true;
  }

  // ─── Viewport scissor ─────────────────────────────────────────────────────────
  // When set, encodeCheckerboard and encodeBlitToView clip their fragment writes
  // to this rect (in swapchain backing pixels). Used at zoom > 1 where the canvas
  // backing buffer is much larger than the visible viewport: instead of writing
  // 7000×9933 pixels per frame and letting the browser compositor clip, we only
  // write the visible region (e.g. 1500×900 device px). The rest of the backing
  // retains stale pixels but the browser composites them outside the viewport so
  // they're never seen.
  private viewportScissor: {
    x: number;
    y: number;
    w: number;
    h: number;
  } | null = null;
  // Set when the viewport scissor changes since the last successful render.
  // The next renderPlan() call must re-blit stableTex to the swapchain so the
  // newly-visible portion of the backing receives valid pixels — but it does
  // NOT need to re-composite any layers (no pixel content has changed).
  private viewportDirty = false;

  /** Restrict checker + blit-to-screen writes to this rect in backing pixels. Pass null to disable. */
  setViewportScissor(
    rect: { x: number; y: number; w: number; h: number } | null,
  ): void {
    const a = this.viewportScissor;
    const b = rect;
    const same =
      (a === null && b === null) ||
      (a !== null &&
        b !== null &&
        a.x === b.x &&
        a.y === b.y &&
        a.w === b.w &&
        a.h === b.h);
    if (same) return;
    this.viewportScissor = rect;
    // Mark viewport dirty so the next renderPlan() re-blits stableTex to the
    // swapchain inside the new scissor. We deliberately do NOT invalidate the
    // plan fingerprint here — pan/scroll changes the visible slice but not the
    // composited pixels themselves, so re-running the entire layer composite
    // would burn hundreds of MB per scroll event at large canvas sizes.
    this.viewportDirty = true;
  }

  /**
   * Re-blit the cached stableTex to the swapchain with no viewport scissor so
   * the entire canvas backing buffer holds a valid composite. Used by the
   * navigator-thumbnail mirror path: createImageBitmap reads the full backing
   * and would otherwise see stale pixels outside the scissored viewport region.
   * No-op when the stable cache is cold.
   */
  repaintScreenNoScissor(): void {
    if (!this.hasStableTex || this.stableTex === null) return;
    const prev = this.viewportScissor;
    this.viewportScissor = null;
    try {
      const encoder = this.device.createCommandEncoder();
      const screenView = this.context.getCurrentTexture().createView();
      this.encodeCheckerboard(encoder, screenView);
      this.encodeBlitToView(encoder, this.stableTex, screenView);
      this.device.queue.submit([encoder.finish()]);
    } finally {
      this.viewportScissor = prev;
    }
  }

  // ─── Stable composite cache ─────────────────────────────────────────────────────────
  // Persists the previous successfully-rendered full-canvas composite so the
  // painting hot path can re-render only the small dirty region instead of
  // re-compositing every layer over the entire canvas every frame.
  private stableTex: GPUTexture | null = null;
  private hasStableTex = false;
  // Canvas-space union of regions touched since the last successful render.
  // Populated by flushLayer; consumed (and cleared) by renderPlan.
  // null → incremental path is unavailable for this frame (full re-composite).
  private frameDirtyCanvasRect: {
    x: number;
    y: number;
    w: number;
    h: number;
  } | null = null;
  // Scissor passed down to encodeCompositeLayer during the incremental path.
  // Null in the full path. When set, encodeCompositeLayer skips copyOutsideRect
  // and constrains the composite render pass to this rect.
  private incrementalScissor: {
    x: number;
    y: number;
    w: number;
    h: number;
  } | null = null;

  /** Union a canvas-space rect into the per-frame dirty accumulator. */
  private unionFrameDirty(x: number, y: number, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.pixelWidth, x + w);
    const y1 = Math.min(this.pixelHeight, y + h);
    if (x0 >= x1 || y0 >= y1) return;
    if (this.frameDirtyCanvasRect === null) {
      this.frameDirtyCanvasRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    } else {
      const r = this.frameDirtyCanvasRect;
      const rx0 = Math.min(r.x, x0);
      const ry0 = Math.min(r.y, y0);
      const rx1 = Math.max(r.x + r.w, x1);
      const ry1 = Math.max(r.y + r.h, y1);
      r.x = rx0;
      r.y = ry0;
      r.w = rx1 - rx0;
      r.h = ry1 - ry0;
    }
  }

  /** Walk the plan and union (prev pos) ∪ (current pos) into the frame dirty
   *  rect for every layer whose offset changed since the last render. Lets the
   *  incremental path fire during a drag (offset-only edits never call
   *  flushLayer, so frameDirtyCanvasRect would otherwise stay null). */
  private detectDragDirty(plan: RenderPlanEntry[]): void {
    for (const entry of plan) {
      if (entry.kind === "layer") {
        if (!entry.layer.visible || entry.layer.opacity === 0) continue;
        const l = entry.layer;
        const prev = this.lastRenderedOffsets.get(l.id);
        if (prev && (prev.x !== l.offsetX || prev.y !== l.offsetY)) {
          this.unionFrameDirty(prev.x, prev.y, prev.w, prev.h);
          this.unionFrameDirty(
            l.offsetX,
            l.offsetY,
            l.layerWidth,
            l.layerHeight,
          );
        }
      } else if (entry.kind === "adjustment-group") {
        if (!entry.baseLayer.visible || entry.baseLayer.opacity === 0) continue;
        const l = entry.baseLayer;
        const prev = this.lastRenderedOffsets.get(entry.parentLayerId);
        if (prev && (prev.x !== l.offsetX || prev.y !== l.offsetY)) {
          this.unionFrameDirty(prev.x, prev.y, prev.w, prev.h);
          this.unionFrameDirty(
            l.offsetX,
            l.offsetY,
            l.layerWidth,
            l.layerHeight,
          );
        }
      } else if (
        entry.kind === "layer-group" ||
        entry.kind === "composite-layer"
      ) {
        if (!entry.visible) continue;
        this.detectDragDirty(entry.children);
      }
    }
  }

  /** Snapshot the current rendered offset of every visible plan layer. Read by
   *  the next frame's detectDragDirty(). */
  private updateLastRenderedOffsets(plan: RenderPlanEntry[]): void {
    for (const entry of plan) {
      if (entry.kind === "layer") {
        if (!entry.layer.visible || entry.layer.opacity === 0) continue;
        const l = entry.layer;
        this.lastRenderedOffsets.set(l.id, {
          x: l.offsetX,
          y: l.offsetY,
          w: l.layerWidth,
          h: l.layerHeight,
        });
      } else if (entry.kind === "adjustment-group") {
        if (!entry.baseLayer.visible || entry.baseLayer.opacity === 0) continue;
        const l = entry.baseLayer;
        this.lastRenderedOffsets.set(entry.parentLayerId, {
          x: l.offsetX,
          y: l.offsetY,
          w: l.layerWidth,
          h: l.layerHeight,
        });
      } else if (
        entry.kind === "layer-group" ||
        entry.kind === "composite-layer"
      ) {
        if (!entry.visible) continue;
        this.updateLastRenderedOffsets(entry.children);
      }
    }
  }

  readonly pixelWidth: number;
  readonly pixelHeight: number;
  private readonly internalFormat: GPUTextureFormat;
  private readonly pixelFormat: PixelFormat;
  deferFlush = false;

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
    if (!navigator.gpu) {
      throw new WebGPUUnavailableError(
        "WebGPU is not available in this environment. Verve requires WebGPU to run.",
      );
    }
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) {
      throw new WebGPUUnavailableError(
        "WebGPU adapter could not be obtained. Your GPU driver may not support WebGPU.",
      );
    }
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
    const ctx = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!ctx) {
      throw new WebGPUUnavailableError(
        "Failed to obtain WebGPU canvas context.",
      );
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: "premultiplied" });
    const internalFormat: GPUTextureFormat =
      pixelFormat === "rgba32f" ? "rgba32float" : "rgba8unorm";
    return new WebGPURenderer(
      device,
      ctx,
      format,
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
    device: GPUDevice,
    context: GPUCanvasContext,
    canvasFormat: GPUTextureFormat,
    pixelWidth: number,
    pixelHeight: number,
    internalFormat: GPUTextureFormat,
    pixelFormat: PixelFormat,
  ) {
    this.device = device;
    this.context = context;
    this.pixelWidth = pixelWidth;
    this.pixelHeight = pixelHeight;
    this.internalFormat = internalFormat;
    this.pixelFormat = pixelFormat;

    // Samplers
    this.sampler = device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // Shared vertex buffers
    this.texCoordBuffer = createVertexBuffer(device, QUAD_UVS);

    // Pre-allocate static per-frame buffers
    this.canvasQuadVertBuf = createVertexBuffer(
      device,
      QUAD_POSITIONS(pixelWidth, pixelHeight),
    );
    this.frameUniformBuf = createUniformBuffer(device, 16);
    writeUniformBuffer(
      device,
      this.frameUniformBuf,
      new Float32Array([pixelWidth, pixelHeight, 0, 0]),
    );
    const cuData = new DataView(new ArrayBuffer(64));
    cuData.setFloat32(0, 8.0, true); // tileSize
    cuData.setFloat32(16, 0.549, true);
    cuData.setFloat32(20, 0.549, true);
    cuData.setFloat32(24, 0.549, true); // colorA
    cuData.setFloat32(28, 0.0, true); // _pad0
    cuData.setFloat32(32, 0.392, true);
    cuData.setFloat32(36, 0.392, true);
    cuData.setFloat32(40, 0.392, true); // colorB
    cuData.setFloat32(44, 0.0, true); // _pad1
    cuData.setFloat32(48, pixelWidth, true);
    cuData.setFloat32(52, pixelHeight, true); // resolution
    this.checkerUniformBuf = createUniformBuffer(device, 64);
    writeUniformBuffer(device, this.checkerUniformBuf, cuData.buffer);

    // Ping-pong textures
    const texUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT;
    this.pingTex = this.createPingPongTex(pixelWidth, pixelHeight, texUsage);
    this.pongTex = this.createPingPongTex(pixelWidth, pixelHeight, texUsage);
    this.groupPingTex = this.createPingPongTex(
      pixelWidth,
      pixelHeight,
      texUsage,
    );
    this.groupPongTex = this.createPingPongTex(
      pixelWidth,
      pixelHeight,
      texUsage,
    );

    // Render pipelines — composite targets internal rgba8unorm textures; checker/blit target the screen
    // Build explicit BGLs first so composite/blit pipelines accept rgba32float layer textures
    // (auto-layout would infer sampleType:'float', which is incompatible with rgba32float).
    this.compositeBGL = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "non-filtering" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: "unfilterable-float",
            viewDimension: "2d",
            multisampled: false,
          },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: "unfilterable-float",
            viewDimension: "2d",
            multisampled: false,
          },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: "unfilterable-float",
            viewDimension: "2d",
            multisampled: false,
          },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        // Vertex stage reads `res` for NDC conversion in vs_composite.
        {
          binding: 5,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });
    this.hdrBlitBGL = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "non-filtering" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: "unfilterable-float",
            viewDimension: "2d",
            multisampled: false,
          },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });
    this.compositePipeline = createCompositePipeline(
      device,
      this.internalFormat,
      this.compositeBGL,
    );
    this.checkerPipeline = createCheckerPipeline(device, canvasFormat);
    this.hdrBlitPipeline = createHdrBlitPipeline(
      device,
      canvasFormat,
      this.hdrBlitBGL,
    );
    this.hdrUniformBuffer = createUniformBuffer(device, 16);
    // Initialize: exposureLinear=1.0, isFp32=0.0, operator=1 (Reinhard), _pad=0
    const initData = new ArrayBuffer(16);
    const initView = new DataView(initData);
    initView.setFloat32(0, 1.0, true);
    initView.setFloat32(4, 0.0, true);
    initView.setUint32(8, 1, true);
    initView.setFloat32(12, 0.0, true);
    writeUniformBuffer(device, this.hdrUniformBuffer, initData);
    this.checkerBindGroup = device.createBindGroup({
      layout: this.checkerPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.checkerUniformBuf } }],
    });

    // Adjustment compute encoder (owns all 25 compute pipelines + texture caches)
    this.adjEncoder = new EffectEncoder(
      device,
      pixelWidth,
      pixelHeight,
      this.internalFormat,
    );

    initGrabCutCompute(this.device);
  }

  /** GPU texture format used for the renderer's internal compositing buffers
   *  (rgba8unorm for SDR pipelines, rgba32float for HDR). External callers
   *  (e.g. EffectEncoder pipelines) need this to build matching pipelines. */
  get internalTextureFormat(): GPUTextureFormat {
    return this.internalFormat;
  }

  // ─── Texture factory ────────────────────────────────────────────────────────

  /**
   * Allocate a tracked GPU texture matching the renderer's internal format.
   * Used for ping/pong buffers, isolated group buffers, and stable cache.
   */
  private createPingPongTex(
    w: number,
    h: number,
    usage: GPUTextureUsageFlags,
  ): GPUTexture {
    return createTrackedTexture(this.device, {
      size: { width: w, height: h },
      format: this.internalFormat,
      usage,
    });
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
    const data: Uint8Array | Float32Array =
      format === "rgba32f"
        ? allocFloat32(lw * lh * 4)
        : format === "indexed8"
          ? allocUint8(lw * lh)
          : allocUint8(lw * lh * 4);
    const textureFormat: GPUTextureFormat =
      format === "rgba32f" ? "rgba32float" : "rgba8unorm";
    const texture = createGpuTexture(this.device, lw, lh, null, textureFormat);
    return {
      id,
      name,
      texture,
      data,
      format,
      layerWidth: lw,
      layerHeight: lh,
      offsetX: ox,
      offsetY: oy,
      opacity: 1,
      visible: true,
      blendMode: "normal",
      dirtyRect: null,
      contentVersion: 0,
    };
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
    layer.contentVersion++;

    if (layer.format === "indexed8") {
      const expanded = expandIndicesToRgba8(
        layer.data as Uint8Array,
        palette ?? [],
      );
      uploadTextureData(
        this.device,
        layer.texture,
        layer.layerWidth,
        layer.layerHeight,
        expanded,
      );
      this.unionFrameDirty(
        layer.offsetX,
        layer.offsetY,
        layer.layerWidth,
        layer.layerHeight,
      );
      return;
    }

    if (layer.format === "rgba32f") {
      if (layer.dirtyRect) {
        const { lx, ly, rx, ry } = layer.dirtyRect;
        layer.dirtyRect = null;
        uploadF32TexturePatch(
          this.device,
          layer.texture,
          layer.layerWidth,
          lx,
          ly,
          rx - lx,
          ry - ly,
          layer.data as Float32Array,
        );
        this.unionFrameDirty(
          layer.offsetX + lx,
          layer.offsetY + ly,
          rx - lx,
          ry - ly,
        );
      } else {
        uploadF32TextureData(
          this.device,
          layer.texture,
          layer.layerWidth,
          layer.layerHeight,
          layer.data as Float32Array,
        );
        this.unionFrameDirty(
          layer.offsetX,
          layer.offsetY,
          layer.layerWidth,
          layer.layerHeight,
        );
      }
      return;
    }

    // rgba8 — existing path
    if (layer.dirtyRect) {
      const { lx, ly, rx, ry } = layer.dirtyRect;
      layer.dirtyRect = null;
      uploadTexturePatch(
        this.device,
        layer.texture,
        layer.layerWidth,
        lx,
        ly,
        rx - lx,
        ry - ly,
        layer.data as Uint8Array,
      );
      this.unionFrameDirty(
        layer.offsetX + lx,
        layer.offsetY + ly,
        rx - lx,
        ry - ly,
      );
    } else {
      uploadTextureData(
        this.device,
        layer.texture,
        layer.layerWidth,
        layer.layerHeight,
        layer.data as Uint8Array,
      );
      this.unionFrameDirty(
        layer.offsetX,
        layer.offsetY,
        layer.layerWidth,
        layer.layerHeight,
      );
    }
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
    destroyTrackedTexture(layer.texture);
    const textureFormat: GPUTextureFormat =
      newFormat === "rgba32f" ? "rgba32float" : "rgba8unorm";
    layer.texture = createGpuTexture(
      this.device,
      layer.layerWidth,
      layer.layerHeight,
      null,
      textureFormat,
    );
    layer.data = newData;
    layer.format = newFormat;
    layer.dirtyRect = null;
    this.flushLayer(layer, palette);
  }

  /**
   * Release every GPU resource and cache entry associated with this layer:
   * its texture, any cached adj-group / standalone-op / composite-layer
   * output, plus the entry tracking its last-rendered offset for drag
   * detection. Safe to call even if the layer has no cached output.
   */
  destroyLayer(layer: GpuLayer): void {
    destroyTrackedTexture(layer.texture);
    const cached = this.adjGroupCache.get(layer.id);
    if (cached) {
      destroyTrackedTexture(cached.tex);
      this.adjGroupCache.delete(layer.id);
    }
    const cachedSO = this.standaloneOpCache.get(layer.id);
    if (cachedSO) {
      destroyTrackedTexture(cachedSO.tex);
      this.standaloneOpCache.delete(layer.id);
    }
    const cachedCL = this.compositeLayerCache.get(layer.id);
    if (cachedCL) {
      destroyTrackedTexture(cachedCL.tex);
      this.compositeLayerCache.delete(layer.id);
    }
    this.lastRenderedOffsets.delete(layer.id);
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

    const copyX = layer.offsetX - newX;
    const copyY = layer.offsetY - newY;
    const textureFormat: GPUTextureFormat =
      layer.format === "rgba32f" ? "rgba32float" : "rgba8unorm";

    let newData: Uint8Array | Float32Array;
    if (layer.format === "rgba32f") {
      newData = allocFloat32(newW * newH * 4);
      const stride = layer.layerWidth * 4;
      for (let row = 0; row < layer.layerHeight; row++) {
        const srcOff = row * stride;
        const dstOff = ((copyY + row) * newW + copyX) * 4;
        (newData as Float32Array).set(
          (layer.data as Float32Array).subarray(srcOff, srcOff + stride),
          dstOff,
        );
      }
    } else if (layer.format === "indexed8") {
      // indexed8: 1 byte per pixel; 255 = transparent sentinel
      newData = allocUint8(newW * newH);
      (newData as Uint8Array).fill(255);
      const stride = layer.layerWidth;
      for (let row = 0; row < layer.layerHeight; row++) {
        const srcOff = row * stride;
        const dstOff = (copyY + row) * newW + copyX;
        (newData as Uint8Array).set(
          (layer.data as Uint8Array).subarray(srcOff, srcOff + stride),
          dstOff,
        );
      }
    } else {
      newData = allocUint8(newW * newH * 4);
      const stride = layer.layerWidth * 4;
      for (let row = 0; row < layer.layerHeight; row++) {
        const srcOff = row * stride;
        const dstOff = ((copyY + row) * newW + copyX) * 4;
        (newData as Uint8Array).set(
          (layer.data as Uint8Array).subarray(srcOff, srcOff + stride),
          dstOff,
        );
      }
    }

    // Create new texture; for indexed8 the caller's flushLayer will upload correct RGBA content
    const newTex = createGpuTexture(
      this.device,
      newW,
      newH,
      null,
      textureFormat,
    );
    if (layer.format === "rgba32f") {
      uploadF32TextureData(
        this.device,
        newTex,
        newW,
        newH,
        newData as Float32Array,
      );
    } else if (layer.format !== "indexed8") {
      uploadTextureData(this.device, newTex, newW, newH, newData as Uint8Array);
    }

    destroyTrackedTexture(layer.texture);
    layer.texture = newTex;
    layer.data = newData;
    layer.layerWidth = newW;
    layer.layerHeight = newH;
    layer.offsetX = newX;
    layer.offsetY = newY;
    layer.dirtyRect = null; // texture is fully up-to-date after grow
    layer.contentVersion++;
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
    if (x < 0 || x >= layer.layerWidth || y < 0 || y >= layer.layerHeight)
      return;
    const i = (y * layer.layerWidth + x) * 4;
    layer.data[i] = r;
    layer.data[i + 1] = g;
    layer.data[i + 2] = b;
    layer.data[i + 3] = a;
  }

  /** Set the layer-local pixel at (x, y) to fully transparent (0,0,0,0). */
  erasePixel(layer: GpuLayer, x: number, y: number): void {
    this.drawPixel(layer, x, y, 0, 0, 0, 0);
  }

  /** Read the RGBA value at layer-local (x, y) directly from the CPU buffer.
   *  Returns (0,0,0,0) for out-of-bounds coordinates. */
  samplePixel(
    layer: GpuLayer,
    x: number,
    y: number,
  ): [number, number, number, number] {
    if (x < 0 || x >= layer.layerWidth || y < 0 || y >= layer.layerHeight)
      return [0, 0, 0, 0];
    const i = (y * layer.layerWidth + x) * 4;
    return [
      layer.data[i],
      layer.data[i + 1],
      layer.data[i + 2],
      layer.data[i + 3],
    ];
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
    const plan: RenderPlanEntry[] = layers.map((layer) => ({
      kind: "layer" as const,
      layer,
      mask: maskMap?.get(layer.id),
    }));
    this.renderPlan(plan);
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
  renderPlan(plan: RenderPlanEntry[]): void {
    const { device, pixelWidth: w, pixelHeight: h } = this;

    // Skip the entire frame when nothing observable has changed since last render.
    const planFp = this.computePlanFingerprint(plan);
    if (planFp === this.lastPlanFp) {
      // Drop any dirty accumulation that came in for a no-op frame.
      this.frameDirtyCanvasRect = null;
      // Viewport-only change (pan / scroll / zoom-resize): re-blit stableTex to
      // the swapchain so the newly-visible portion receives valid pixels. No
      // layer compositing required — pixel content is unchanged.
      if (this.viewportDirty && this.hasStableTex && this.stableTex !== null) {
        const reblitEnc = device.createCommandEncoder();
        const screenView = this.context.getCurrentTexture().createView();
        this.encodeCheckerboard(reblitEnc, screenView);
        this.encodeBlitToView(reblitEnc, this.stableTex, screenView);
        device.queue.submit([reblitEnc.finish()]);
        this.viewportDirty = false;
      }
      return;
    }

    // Drag-only edits change layer.offsetX/Y in place without calling
    // flushLayer, so frameDirtyCanvasRect would otherwise stay null and force
    // the full-canvas path. Synthesize the dirty rect from any layer whose
    // offset has changed since the last render.
    this.detectDragDirty(plan);

    // Decide path: incremental (small rect, plain layer plan, stable cache valid)
    // vs. full (cold cache, complex plan with adjustments/groups, or no dirty rect).
    const dirty = this.frameDirtyCanvasRect;
    const flatPlan = this.planIsFlatLayersOnly(plan);
    const canIncremental =
      this.hasStableTex &&
      this.stableTex !== null &&
      dirty !== null &&
      dirty.w > 0 &&
      dirty.h > 0 &&
      flatPlan &&
      // Skip incremental when dirty area covers most of the canvas — preload
      // DMA cost (2× full canvas) outweighs the saved per-layer composite work.
      dirty.w * dirty.h < w * h * 0.6;
    if (this.previewMode) {
      const why = canIncremental
        ? "OK"
        : !this.hasStableTex
          ? "no-stableTex"
          : !dirty
            ? "no-dirty"
            : !flatPlan
              ? "plan-not-flat"
              : "dirty-too-big";
      console.log(
        `[renderPlan] inc=${canIncremental} (${why}), layers=${plan.length}`,
      );
    }

    const encoder = device.createCommandEncoder();

    if (canIncremental && dirty !== null && this.stableTex !== null) {
      // Incremental path. Cost rules:
      //  - The blit-to-swapchain is an unavoidable full-canvas write each frame.
      //  - Therefore we keep one canonical full-canvas buffer (stableTex) and
      //    blit *that* to the screen. We never need ping/pong to hold valid
      //    content outside the dirty rect for display purposes.
      //  - Inside the dirty rect we run a scissored composite into ping/pong,
      //    then copy the result back into stableTex@dirty.
      //
      // Bandwidth per frame ≈ blit-to-swapchain (full) + O(dirty.w*dirty.h*N).
      // No full-canvas preload. (Previously the 2× full preload cost ~110ms at
      // 7000×9933.)
      //
      // Correctness: ping/pong have stale content outside the dirty rect, but
      // every read inside the scissored composite is also inside the dirty rect
      // (the scissor blocks fragment reads-of-uninitialized? No — fragment shader
      // can sample anywhere. But each layer's dst-write is scissored, so layer K
      // only reads pixels inside dirty that layer K-1 just wrote there via the
      // scoped src→dst copy in encodeCompositeLayer). Outside dirty is read
      // never (layer's quad clipped to scissor) for fragment writes, and the
      // shader samples src at the same pixel coord it writes — both inside dirty.

      // Zero-clear the dirty subrect in both ping and pong so layer 0 composites
      // against transparent (matches the "fresh canvas" semantics of the full
      // path, which clears pingTex and treats pongTex as empty via srcIsEmpty=true).
      const zeroTex = createTrackedTexture(this.device, {
        size: { width: dirty.w, height: dirty.h },
        format: this.internalFormat,
        usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.pendingDestroyTextures.push(zeroTex);
      encodeClearTexture(encoder, zeroTex);
      encoder.copyTextureToTexture(
        { texture: zeroTex },
        { texture: this.pingTex, origin: { x: dirty.x, y: dirty.y } },
        { width: dirty.w, height: dirty.h },
      );
      encoder.copyTextureToTexture(
        { texture: zeroTex },
        { texture: this.pongTex, origin: { x: dirty.x, y: dirty.y } },
        { width: dirty.w, height: dirty.h },
      );

      this.adjGroupCacheEnabled = true;
      this.incrementalScissor = dirty;
      this.compositeBufferIndex = 0;
      const { src: finalTex } = this.encodeSubPlan(
        encoder,
        plan,
        this.pongTex,
        this.pingTex,
        "",
        true,
      );
      this.incrementalScissor = null;
      this.adjGroupCacheEnabled = false;

      // Snapshot the dirty rect back into stableTex so it always holds the full
      // current composite. Outside dirty, stableTex is unchanged.
      encoder.copyTextureToTexture(
        { texture: finalTex, origin: { x: dirty.x, y: dirty.y } },
        { texture: this.stableTex, origin: { x: dirty.x, y: dirty.y } },
        { width: dirty.w, height: dirty.h },
      );

      const screenView = this.context.getCurrentTexture().createView();
      this.encodeCheckerboard(encoder, screenView);
      this.encodeBlitToView(encoder, this.stableTex, screenView);

      device.queue.submit([encoder.finish()]);
      this.flushPendingDestroys();
    } else {
      // Full path: today's logic. Allocate stableTex on first run, snapshot final.
      this.adjGroupCacheEnabled = true;
      const finalTex = this.encodePlanToComposite(encoder, plan);
      this.adjGroupCacheEnabled = false;

      // Ensure stableTex exists and snapshot the full final composite into it.
      if (this.stableTex === null) {
        this.stableTex = this.createPingPongTex(
          w,
          h,
          GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.COPY_SRC |
            GPUTextureUsage.RENDER_ATTACHMENT,
        );
      }
      encoder.copyTextureToTexture(
        { texture: finalTex },
        { texture: this.stableTex },
        { width: w, height: h },
      );

      const screenView = this.context.getCurrentTexture().createView();
      this.encodeCheckerboard(encoder, screenView);
      this.encodeBlitToView(encoder, finalTex, screenView);

      device.queue.submit([encoder.finish()]);
      this.flushPendingDestroys();
      this.hasStableTex = true;
    }

    this.lastPlanFp = planFp;
    this.frameDirtyCanvasRect = null;
    // Snapshot the rendered offsets so the next frame's detectDragDirty can
    // compare against them.
    this.updateLastRenderedOffsets(plan);
    // Both render paths above blit to the swapchain inside the current scissor,
    // so any pending viewport-only update is satisfied.
    this.viewportDirty = false;
  }

  /** True when every plan entry is a plain layer (no groups, adjustments, effects).
   *  Locked adjustment groups with a baked output texture are also treated as
   *  flat — they composite directly from the baked texture with no GPU compute.
   *  Pass-through groups are transparent organizational units and recurse into
   *  their children. Empty groups (regardless of blend mode) are no-ops in
   *  encodeSubPlan, so they don't disable the flat path either. */
  private planIsFlatLayersOnly(plan: RenderPlanEntry[]): boolean {
    for (const entry of plan) {
      if (entry.kind === "layer") continue;
      if (entry.kind === "layer-group") {
        if (!entry.visible) continue;
        if (entry.children.length === 0) continue;
        if (entry.blendMode === "pass-through") {
          if (!this.planIsFlatLayersOnly(entry.children)) return false;
          continue;
        }
        return false;
      }
      if (entry.kind === "adjustment-group") {
        // Invisible / zero-opacity: the encoder skips it, so it doesn't
        // disable the flat path either.
        if (!entry.baseLayer.visible || entry.baseLayer.opacity === 0) continue;
        // Locked + baked: same flat-blit shape as a plain layer.
        if (
          entry.locked === true &&
          this.bakedLockedLayers.has(entry.parentLayerId)
        )
          continue;
        // Unlocked, in preview mode (drag): the moveOnlyMatch path will skip
        // every adjustment pass and just blit the cached output with an
        // offset delta. That blit is shaped exactly like a layer composite,
        // so it's compatible with the incremental path's scissor.
        if (this.previewMode) {
          const cached = this.adjGroupCache.get(entry.parentLayerId);
          if (cached) {
            const baseMaskVersion = entry.baseMask
              ? entry.baseMask.contentVersion
              : -1;
            const paramsKey = computeAdjGroupParamsKey(entry.adjustments);
            if (
              cached.paramsKey === paramsKey &&
              cached.baseMaskVersion === baseMaskVersion &&
              cached.baseContentVersion === entry.baseLayer.contentVersion
            )
              continue;
          }
        }
        return false;
      }
      if (
        entry.kind === "composite-layer" &&
        entry.locked === true &&
        this.bakedLockedLayers.has(entry.layerId)
      )
        continue;
      // Unlocked composite-layer with a guaranteed cache hit also acts as a
      // single cached blit — same shape as the locked-baked fast-path. This
      // is critical: when the user paints on a layer OUTSIDE the composite,
      // none of the composite's children change, so the cache will hit. We
      // verify by computing the would-be childFp + adjKey and matching them
      // against the cached entry. On match, the incremental path can run and
      // the encode side will scissored-blit the cached tex.
      if (entry.kind === "composite-layer" && entry.visible && !entry.locked) {
        const cached = this.compositeLayerCache.get(entry.layerId);
        if (!cached) return false;
        const adjKey = computeAdjGroupParamsKey(entry.adjustments);
        if (cached.adjKey !== adjKey) return false;
        const parts: string[] = [];
        this.appendPlanFp(entry.children, parts);
        if (cached.childFp === parts.join("")) continue;
        // Cache miss: incremental path can still proceed if no per-composite
        // adjustments — the encode side will do a scissored re-flatten of the
        // children into the dirty rect of the existing cache tex.
        if (entry.adjustments.length > 0) return false;
        continue;
      }
      // Top-level standalone EffectRenderOp: skipped entirely by
      // encodeSubPlan when previewMode is on, so it doesn't contribute to
      // output and doesn't disable the flat path during a drag.
      if (this.previewMode) continue;
      return false;
    }
    return true;
  }

  /**
   * Walk the plan tree and produce a fingerprint string covering everything
   * that affects the rendered output. Mirrors the inputFp accumulation in
   * encodeSubPlan, plus the surrounding inputs touched by renderPlan().
   */
  private computePlanFingerprint(plan: RenderPlanEntry[]): string {
    const parts: string[] = [
      `W:${this.pixelWidth}`,
      `H:${this.pixelHeight}`,
      `F:${this.pixelFormat}`,
      `P:${this.previewMode ? 1 : 0}`,
      `EV:${displayStore.exposureEV}`,
      `OP:${displayStore.toneMappingOperator}`,
    ];
    this.appendPlanFp(plan, parts);
    return parts.join("");
  }

  /**
   * Recursive companion to {@link computePlanFingerprint}. Walks each entry
   * and pushes a per-entry fingerprint chunk into `out`. Mirrors the same
   * cache-key shapes that {@link encodeSubPlan} accumulates into its own
   * `inputFp`, so cache lookups computed up-front by `planIsFlatLayersOnly`
   * match what the encoder will produce.
   */
  private appendPlanFp(plan: RenderPlanEntry[], out: string[]): void {
    for (const entry of plan) {
      if (entry.kind === "layer") {
        if (!entry.layer.visible || entry.layer.opacity === 0) continue;
        const l = entry.layer;
        const maskPart = entry.mask
          ? `:M${entry.mask.contentVersion}:${entry.mask.offsetX}:${entry.mask.offsetY}`
          : "";
        out.push(
          `|L:${l.id}:${l.contentVersion}:${l.opacity}:${l.blendMode}:${l.offsetX}:${l.offsetY}${maskPart}`,
        );
      } else if (entry.kind === "layer-group") {
        if (!entry.visible) continue;
        if (entry.children.length === 0) continue;
        if (entry.blendMode === "pass-through") {
          this.appendPlanFp(entry.children, out);
          out.push(`|GRP-end:${entry.groupId}`);
        } else {
          out.push(
            `|GRP:${entry.groupId}:${entry.opacity}:${entry.blendMode}:[`,
          );
          this.appendPlanFp(entry.children, out);
          out.push(`]`);
        }
      } else if (entry.kind === "composite-layer") {
        if (!entry.visible) continue;
        // Locked composite with a baked output: fingerprint depends only on the
        // layer's outer params, not its children. Mirrors the encode fast path.
        if (entry.locked && this.bakedLockedLayers.has(entry.layerId)) {
          out.push(`|LCL:${entry.layerId}:${entry.opacity}:${entry.blendMode}`);
          continue;
        }
        const adjKey = computeAdjGroupParamsKey(entry.adjustments);
        out.push(`|CL:${entry.layerId}:${entry.opacity}:${entry.blendMode}:[`);
        this.appendPlanFp(entry.children, out);
        out.push(`]:${adjKey}`);
      } else if (entry.kind === "adjustment-group") {
        if (!entry.baseLayer.visible || entry.baseLayer.opacity === 0) continue;
        const l = entry.baseLayer;
        const baseMaskVersion = entry.baseMask
          ? entry.baseMask.contentVersion
          : -1;
        const baseMaskOx = entry.baseMask ? entry.baseMask.offsetX : 0;
        const baseMaskOy = entry.baseMask ? entry.baseMask.offsetY : 0;
        const paramsKey = computeAdjGroupParamsKey(entry.adjustments);
        out.push(
          `|AG:${entry.parentLayerId}:${l.contentVersion}:${l.opacity}:${l.blendMode}:${l.offsetX}:${l.offsetY}:M${baseMaskVersion}:${baseMaskOx}:${baseMaskOy}:${paramsKey}`,
        );
      } else {
        // EffectRenderOp (standalone effect)
        if (!entry.visible) continue;
        if (this.previewMode) {
          out.push(`|SKIP:${entry.layerId}`);
          continue;
        }
        out.push(`|SO:${entry.layerId}:${serializeAdjOp(entry)}`);
      }
    }
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
    const finalTex = this.encodePlanToComposite(encoder, plan);

    const bytesPerPixel = this.internalFormat === "rgba32float" ? 16 : 4;
    const alignedBpr = Math.ceil((w * bytesPerPixel) / 256) * 256;
    const readbuf = createReadbackBuffer(device, alignedBpr * h);
    encoder.copyTextureToBuffer(
      { texture: finalTex },
      { buffer: readbuf, bytesPerRow: alignedBpr, rowsPerImage: h },
      { width: w, height: h },
    );
    device.queue.submit([encoder.finish()]);
    this.flushPendingDestroys();

    await readbuf.mapAsync(GPUMapMode.READ);
    const raw = readbuf.getMappedRange();
    const result =
      this.internalFormat === "rgba32float"
        ? unpackF32Rows(new Float32Array(raw), w, h, alignedBpr / 4)
        : unpackRows(new Uint8Array(raw), w, h, alignedBpr);
    readbuf.unmap();
    readbuf.destroy();
    return result;
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
    encodeClearTexture(encoder, this.groupPingTex);

    let srcTex = this.groupPongTex;
    let dstTex = this.groupPingTex;

    const baseAsSource: GpuLayer = {
      ...groupEntry.baseLayer,
      opacity: 1,
      blendMode: "normal",
    };
    this.encodeCompositeLayer(
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

    const bytesPerPixel = this.internalFormat === "rgba32float" ? 16 : 4;
    const alignedBpr = Math.ceil((w * bytesPerPixel) / 256) * 256;
    const readbuf = createReadbackBuffer(device, alignedBpr * h);
    encoder.copyTextureToBuffer(
      { texture: srcTex },
      { buffer: readbuf, bytesPerRow: alignedBpr, rowsPerImage: h },
      { width: w, height: h },
    );
    device.queue.submit([encoder.finish()]);
    this.flushPendingDestroys();

    await readbuf.mapAsync(GPUMapMode.READ);
    const raw = readbuf.getMappedRange();
    const result: Uint8Array | Float32Array =
      this.internalFormat === "rgba32float"
        ? unpackF32Rows(new Float32Array(raw), w, h, alignedBpr / 4)
        : unpackRows(new Uint8Array(raw), w, h, alignedBpr);
    readbuf.unmap();
    readbuf.destroy();
    return result;
  }

  // ─── Plan execution ─────────────────────────────────────────────────────────

  /**
   * Composite an entire plan into one of the renderer's ping-pong textures
   * and return whichever one holds the final result. Resets the per-frame
   * composite-buffer pool index, clears both ping/pong, then walks the plan.
   * Used by the full path of {@link renderPlan} and the readback methods.
   */
  private encodePlanToComposite(
    encoder: GPUCommandEncoder,
    plan: RenderPlanEntry[],
  ): GPUTexture {
    this.compositeBufferIndex = 0;
    encodeClearTexture(encoder, this.pingTex);
    encodeClearTexture(encoder, this.pongTex);
    const { src } = this.encodeSubPlan(
      encoder,
      plan,
      this.pongTex,
      this.pingTex,
      "",
      true,
    );
    return src;
  }

  /**
   * Lend out a (uniform, vertex) buffer pair from the pool. Buffers persist across frames;
   * the pool grows on demand and the index is reset at the start of each plan encoding.
   * Avoids ~2 GPUBuffer allocations per layer per frame in encodeCompositeLayer.
   */
  private acquireCompositeBuffers(): {
    unif: GPUBuffer;
    pos: GPUBuffer;
    cachedBG: GPUBindGroup | null;
    cachedLayerTex: GPUTexture | null;
    cachedSrcTex: GPUTexture | null;
    cachedMaskTex: GPUTexture | null;
  } {
    const i = this.compositeBufferIndex++;
    let pair = this.compositeBufferPool[i];
    if (!pair) {
      pair = {
        unif: this.device.createBuffer({
          size: 64,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        pos: this.device.createBuffer({
          size: 48, // 6 vertices * 2 floats * 4 bytes
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
        cachedBG: null,
        cachedLayerTex: null,
        cachedSrcTex: null,
        cachedMaskTex: null,
      };
      this.compositeBufferPool[i] = pair;
    }
    return pair;
  }

  /**
   * Core compositing loop. Walks `plan` in order, dispatching each entry kind
   * (layer / layer-group / composite-layer / adjustment-group / standalone
   * EffectRenderOp) through its appropriate cache-aware fast paths and
   * encoder calls. Maintains the running ping-pong pair (`src` holds the
   * accumulated composite, `dst` is the next write target — they swap after
   * every entry that writes pixels). Returns the final pair plus the
   * accumulated `inputFp` used by downstream caches (standaloneOpCache,
   * compositeLayerCache) to detect identical-input invalidations.
   *
   * @param srcIsEmpty Skips the redundant src→dst preserving copy for the
   *                   first composited entry (src is known to be cleared).
   */
  private encodeSubPlan(
    encoder: GPUCommandEncoder,
    plan: RenderPlanEntry[],
    src: GPUTexture,
    dst: GPUTexture,
    inputFp: string,
    srcIsEmpty = false,
  ): {
    src: GPUTexture;
    dst: GPUTexture;
    inputFp: string;
    srcIsEmpty: boolean;
  } {
    for (const entry of plan) {
      if (entry.kind === "layer") {
        if (!entry.layer.visible || entry.layer.opacity === 0) continue;
        this.encodeCompositeLayer(
          encoder,
          entry.layer,
          src,
          dst,
          entry.mask,
          srcIsEmpty,
        );
        [src, dst] = [dst, src];
        srcIsEmpty = false;
        const l = entry.layer;
        const maskPart = entry.mask ? `:M${entry.mask.contentVersion}` : "";
        inputFp += `|L:${l.id}:${l.contentVersion}:${l.opacity}:${l.blendMode}:${l.offsetX}:${l.offsetY}${maskPart}`;
      } else if (entry.kind === "layer-group") {
        if (!entry.visible) continue;
        // Empty group: nothing to composite. Skip to avoid allocating + clearing
        // two full-canvas textures (hundreds of MB at large canvas sizes) every
        // renderPlan call — which during a brush stroke means every pointer event.
        if (entry.children.length === 0) continue;
        if (entry.blendMode === "pass-through") {
          // Pass-through: inline children into the parent ping-pong pair.
          const child = this.encodeSubPlan(
            encoder,
            entry.children,
            src,
            dst,
            inputFp,
            srcIsEmpty,
          );
          src = child.src;
          dst = child.dst;
          inputFp = child.inputFp;
          srcIsEmpty = child.srcIsEmpty;
          inputFp += `|GRP-end:${entry.groupId}`;
        } else {
          // Isolated: allocate a fresh ping-pong pair for this group.
          const iso1 = this.allocateTempGroupTex();
          const iso2 = this.allocateTempGroupTex();
          encodeClearTexture(encoder, iso1);
          encodeClearTexture(encoder, iso2);
          const child = this.encodeSubPlan(
            encoder,
            entry.children,
            iso2,
            iso1,
            "",
            true,
          );
          if (child.srcIsEmpty) continue;
          // Composite the isolated result into the parent context.
          this.encodeCompositeTexture(
            encoder,
            child.src,
            src,
            dst,
            entry.opacity,
            entry.blendMode,
            srcIsEmpty,
          );
          [src, dst] = [dst, src];
          srcIsEmpty = false;
          inputFp += `|GRP:${entry.groupId}:${entry.opacity}:${entry.blendMode}:${child.inputFp}`;
        }
      } else if (entry.kind === "composite-layer") {
        if (!entry.visible) continue;

        // Locked composite-layer fast path: blit the baked flattened output
        // directly into the parent ping-pong. No child recursion, no isolated
        // texture allocation, no adjustment passes. Mirrors the locked
        // adjustment-group fast path.
        if (entry.locked) {
          const bakedTex = this.bakedLockedLayers.get(entry.layerId);
          if (bakedTex) {
            this.encodeCompositeTexture(
              encoder,
              bakedTex,
              src,
              dst,
              entry.opacity,
              entry.blendMode,
              srcIsEmpty,
            );
            [src, dst] = [dst, src];
            srcIsEmpty = false;
            inputFp += `|LCL:${entry.layerId}:${entry.opacity}:${entry.blendMode}`;
            continue;
          }
          // No baked tex yet. If the compositeLayerCache already holds a valid
          // output for the same children + adjustments (very likely — locking
          // doesn't itself invalidate that cache), promote it to a baked tex
          // without re-encoding children at all.
          if (this.adjGroupCacheEnabled) {
            const cached = this.compositeLayerCache.get(entry.layerId);
            if (cached) {
              const childFpParts: string[] = [];
              this.appendPlanFp(entry.children, childFpParts);
              const childFp = childFpParts.join("");
              const adjKeyForLocked = computeAdjGroupParamsKey(
                entry.adjustments,
              );
              if (
                cached.childFp === childFp &&
                cached.adjKey === adjKeyForLocked
              ) {
                // Transfer ownership: the cached output already holds the exact
                // pixels we'd otherwise re-render. Promote it to a baked tex
                // and drop the composite-cache entry so we don't double-track it.
                this.bakedLockedLayers.set(entry.layerId, cached.tex);
                this.compositeLayerCache.delete(entry.layerId);
                this.encodeCompositeTexture(
                  encoder,
                  cached.tex,
                  src,
                  dst,
                  entry.opacity,
                  entry.blendMode,
                  srcIsEmpty,
                );
                [src, dst] = [dst, src];
                srcIsEmpty = false;
                inputFp += `|LCL:${entry.layerId}:${entry.opacity}:${entry.blendMode}`;
                continue;
              }
            }
          }
          // Cache miss too — fall through, encode children, bake at the bottom.
        } else {
          // Composite was unlocked — evict any stale baked tex.
          const stale = this.bakedLockedLayers.get(entry.layerId);
          if (stale) {
            destroyTrackedTexture(stale);
            this.bakedLockedLayers.delete(entry.layerId);
          }
        }

        const adjKey = this.adjGroupCacheEnabled
          ? computeAdjGroupParamsKey(entry.adjustments)
          : entry.adjustments.map((a) => a.layerId).join(",");

        // Up-front cache check: compute the would-be child fingerprint from
        // the plan WITHOUT encoding any children. If the cache is valid we
        // skip child recursion + temp-texture allocation entirely. This is
        // critical for painting performance on layers OUTSIDE the composite —
        // their edits don't change any composite child's contentVersion, so
        // the cached flatten remains valid for the entire stroke.
        if (this.adjGroupCacheEnabled) {
          const cached = this.compositeLayerCache.get(entry.layerId);
          if (cached && cached.adjKey === adjKey) {
            const childFpParts: string[] = [];
            this.appendPlanFp(entry.children, childFpParts);
            const upfrontChildFp = childFpParts.join("");
            if (cached.childFp === upfrontChildFp) {
              this.encodeCompositeTexture(
                encoder,
                cached.tex,
                src,
                dst,
                entry.opacity,
                entry.blendMode,
                srcIsEmpty,
              );
              [src, dst] = [dst, src];
              srcIsEmpty = false;
              inputFp += `|CL:${entry.layerId}:${entry.opacity}:${entry.blendMode}:${upfrontChildFp}:${adjKey}`;
              continue;
            }
          }
        }

        // Scissored re-flatten path: when we're inside the outer incremental
        // scissor AND a cache exists AND there are no per-composite adjustments,
        // re-composite the children ONLY inside the dirty rect, snapshot just
        // that rect back into the existing cache tex, then composite the cache
        // (also scissored) into the parent. Cost scales with the brush dab
        // size, not the full canvas — the same trick the outer incremental
        // path uses, applied recursively to the composite's children.
        if (
          this.incrementalScissor !== null &&
          entry.adjustments.length === 0 &&
          this.adjGroupCacheEnabled
        ) {
          const cached = this.compositeLayerCache.get(entry.layerId);
          if (cached) {
            const dirty = this.incrementalScissor;
            const isoA = this.allocateTempGroupTex();
            const isoB = this.allocateTempGroupTex();
            // Zero-clear ONLY the dirty subrect of both iso textures so child 0
            // composites against transparent inside the dirty rect (matches the
            // 'srcIsEmpty=true' contract). Outside the dirty rect both textures
            // hold garbage — we never read or snapshot from there.
            const zeroTex = createTrackedTexture(this.device, {
              size: { width: dirty.w, height: dirty.h },
              format: this.internalFormat,
              usage:
                GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            this.pendingDestroyTextures.push(zeroTex);
            encodeClearTexture(encoder, zeroTex);
            encoder.copyTextureToTexture(
              { texture: zeroTex },
              { texture: isoA, origin: { x: dirty.x, y: dirty.y } },
              { width: dirty.w, height: dirty.h },
            );
            encoder.copyTextureToTexture(
              { texture: zeroTex },
              { texture: isoB, origin: { x: dirty.x, y: dirty.y } },
              { width: dirty.w, height: dirty.h },
            );
            const child = this.encodeSubPlan(
              encoder,
              entry.children,
              isoB,
              isoA,
              "",
              true,
            );
            // Snapshot the dirty rect of the freshly-composited iso into the
            // cache. Outside the dirty rect the cache is unchanged — still
            // correct from prior frames.
            encoder.copyTextureToTexture(
              { texture: child.src, origin: { x: dirty.x, y: dirty.y } },
              { texture: cached.tex, origin: { x: dirty.x, y: dirty.y } },
              { width: dirty.w, height: dirty.h },
            );
            cached.childFp = child.inputFp;
            cached.adjKey = adjKey;
            this.encodeCompositeTexture(
              encoder,
              cached.tex,
              src,
              dst,
              entry.opacity,
              entry.blendMode,
              srcIsEmpty,
            );
            [src, dst] = [dst, src];
            srcIsEmpty = false;
            inputFp += `|CL:${entry.layerId}:${entry.opacity}:${entry.blendMode}:${child.inputFp}:${adjKey}`;
            continue;
          }
        }

        // Cache miss — composite all children into an isolated texture pair.
        const iso1 = this.allocateTempGroupTex();
        const iso2 = this.allocateTempGroupTex();
        encodeClearTexture(encoder, iso1);
        encodeClearTexture(encoder, iso2);
        const child = this.encodeSubPlan(
          encoder,
          entry.children,
          iso2,
          iso1,
          "",
          true,
        );

        // Apply per-composite adjustments to the flattened result.
        let compositeSrc: GPUTexture;
        compositeSrc = child.src;
        if (entry.adjustments.length > 0) {
          // Borrow the shared group ping-pong textures for the adjustment passes.
          encodeClearTexture(encoder, this.groupPingTex);
          encodeClearTexture(encoder, this.groupPongTex);
          encoder.copyTextureToTexture(
            { texture: compositeSrc },
            { texture: this.groupPongTex },
            { width: this.pixelWidth, height: this.pixelHeight },
          );
          let adjSrc = this.groupPongTex;
          let adjDst = this.groupPingTex;
          for (const op of entry.adjustments) {
            if (!op.visible) continue;
            this.adjEncoder.encode(
              encoder,
              op,
              adjSrc,
              adjDst,
              this.internalFormat,
            );
            [adjSrc, adjDst] = [adjDst, adjSrc];
          }
          compositeSrc = adjSrc;
        }

        // Store result in cache.
        if (this.adjGroupCacheEnabled) {
          const existing = this.compositeLayerCache.get(entry.layerId);
          const cacheTex =
            existing?.tex ??
            createTrackedTexture(this.device, {
              size: { width: this.pixelWidth, height: this.pixelHeight },
              format: this.internalFormat,
              usage:
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_DST |
                GPUTextureUsage.RENDER_ATTACHMENT,
            });
          encoder.copyTextureToTexture(
            { texture: compositeSrc },
            { texture: cacheTex },
            { width: this.pixelWidth, height: this.pixelHeight },
          );
          this.compositeLayerCache.set(entry.layerId, {
            childFp: child.inputFp,
            adjKey,
            tex: cacheTex,
          });
        }

        // If the composite is locked, bake the flattened+adjusted result for
        // every future frame. Subsequent renders take the fast-path blit above.
        if (entry.locked && !this.bakedLockedLayers.has(entry.layerId)) {
          const bakeTex = createTrackedTexture(this.device, {
            size: { width: this.pixelWidth, height: this.pixelHeight },
            format: this.internalFormat,
            usage:
              GPUTextureUsage.TEXTURE_BINDING |
              GPUTextureUsage.COPY_DST |
              GPUTextureUsage.RENDER_ATTACHMENT,
          });
          encoder.copyTextureToTexture(
            { texture: compositeSrc },
            { texture: bakeTex },
            { width: this.pixelWidth, height: this.pixelHeight },
          );
          this.bakedLockedLayers.set(entry.layerId, bakeTex);
        }

        this.encodeCompositeTexture(
          encoder,
          compositeSrc,
          src,
          dst,
          entry.opacity,
          entry.blendMode,
          srcIsEmpty,
        );
        [src, dst] = [dst, src];
        srcIsEmpty = false;
        inputFp += `|CL:${entry.layerId}:${entry.opacity}:${entry.blendMode}:${child.inputFp}:${adjKey}`;
      } else if (entry.kind === "adjustment-group") {
        if (!entry.baseLayer.visible || entry.baseLayer.opacity === 0) continue;

        // Locked layer fast path: if we have a baked texture, composite it directly —
        // no GPU compute, no cache lookup, just a blit.  The baked tex is canvas-sized
        // with the layer (+ all its adjustments) already composited into it.
        if (entry.locked) {
          const bakedTex = this.bakedLockedLayers.get(entry.parentLayerId);
          if (bakedTex) {
            this.encodeCompositeTexture(
              encoder,
              bakedTex,
              src,
              dst,
              entry.baseLayer.opacity,
              entry.baseLayer.blendMode,
              srcIsEmpty,
            );
            [src, dst] = [dst, src];
            srcIsEmpty = false;
            inputFp += `|LAG:${entry.parentLayerId}:${entry.baseLayer.opacity}:${entry.baseLayer.blendMode}`;
            continue;
          }
          // Baked tex not yet ready — fall through to compute it below, then bake.
        } else {
          // Layer was unlocked — evict any stale baked tex.
          const stale = this.bakedLockedLayers.get(entry.parentLayerId);
          if (stale) {
            destroyTrackedTexture(stale);
            this.bakedLockedLayers.delete(entry.parentLayerId);
          }
        }

        let groupResult: GPUTexture;

        const paramsKey = computeAdjGroupParamsKey(entry.adjustments);
        const baseMaskVersion = entry.baseMask
          ? entry.baseMask.contentVersion
          : -1;
        const baseMaskOx = entry.baseMask ? entry.baseMask.offsetX : 0;
        const baseMaskOy = entry.baseMask ? entry.baseMask.offsetY : 0;

        if (this.adjGroupCacheEnabled) {
          const cached = this.adjGroupCache.get(entry.parentLayerId);

          // Params + mask buffer identity match (mask buffer pixels and
          // version match — mask position is checked separately below).
          const paramsAndMaskBufferMatch =
            !!cached &&
            cached.baseMaskVersion === baseMaskVersion &&
            cached.paramsKey === paramsKey;
          // Stricter: mask is also at the exact same offset.
          const paramsAndMaskMatch =
            paramsAndMaskBufferMatch &&
            cached!.baseMaskOffsetX === baseMaskOx &&
            cached!.baseMaskOffsetY === baseMaskOy;
          const positionAndParamsMatch =
            paramsAndMaskMatch &&
            cached!.offsetX === entry.baseLayer.offsetX &&
            cached!.offsetY === entry.baseLayer.offsetY;
          const fullMatch =
            positionAndParamsMatch &&
            cached!.baseContentVersion === entry.baseLayer.contentVersion;
          // Throttle: layer pixels changed (mid-stroke) but adjustment params,
          // mask, and position are identical → composite the layer's raw
          // pixels for real-time stroke feedback while skipping the (often
          // multi-pass) effect chain. Gated on strokeActive so the effect
          // re-runs exactly once on pointer-up, never mid-stroke on idle.
          const throttledMatch =
            !fullMatch && positionAndParamsMatch && this.strokeActive;
          // Move-drag: layer offset changed and the mask either didn't
          // move OR moved by the exact same delta as the layer (the move
          // tool moves a mask along with its parent in lockstep). The
          // cached canvas-sized adj output already contains the layer's
          // adjusted pixels at the OLD offset — shift the blit by
          // (current - cached) to draw it at the NEW position. Free move.
          const layerDx = cached
            ? entry.baseLayer.offsetX - cached.offsetX
            : 0;
          const layerDy = cached
            ? entry.baseLayer.offsetY - cached.offsetY
            : 0;
          const maskDx = cached ? baseMaskOx - cached.baseMaskOffsetX : 0;
          const maskDy = cached ? baseMaskOy - cached.baseMaskOffsetY : 0;
          const maskFollowsLayer = layerDx === maskDx && layerDy === maskDy;
          const moveOnlyMatch =
            !fullMatch &&
            !throttledMatch &&
            this.previewMode &&
            paramsAndMaskBufferMatch &&
            maskFollowsLayer &&
            cached!.baseContentVersion === entry.baseLayer.contentVersion;

          if (fullMatch) {
            // Real cache hit: composite the pre-computed result directly.
            groupResult = cached!.tex;
          } else if (throttledMatch) {
            // Real-time stroke feedback: composite the layer's RAW pixels (no
            // effect) across its full bbox. Brush strokes appear immediately
            // at full framerate. The effect chain re-runs once on stroke end
            // (strokeEnd flips strokeActive to false and forces a refresh).
            this.encodeCompositeLayer(
              encoder,
              entry.baseLayer,
              src,
              dst,
              entry.baseMask,
              srcIsEmpty,
            );
            [src, dst] = [dst, src];
            srcIsEmpty = false;
            inputFp += `|AG:${entry.parentLayerId}:${entry.baseLayer.contentVersion}:${entry.baseLayer.opacity}:${entry.baseLayer.blendMode}:${entry.baseLayer.offsetX}:${entry.baseLayer.offsetY}:M${baseMaskVersion}:${baseMaskOx}:${baseMaskOy}:${paramsKey}`;
            continue;
          } else if (moveOnlyMatch) {
            // Composite the cached tex with an offset delta and skip the
            // expensive recompute. We bypass the standard groupResult path
            // because that always blits at (0,0).
            const dx = entry.baseLayer.offsetX - cached!.offsetX;
            const dy = entry.baseLayer.offsetY - cached!.offsetY;
            this.encodeCompositeTexture(
              encoder,
              cached!.tex,
              src,
              dst,
              entry.baseLayer.opacity,
              entry.baseLayer.blendMode,
              srcIsEmpty,
              dx,
              dy,
            );
            [src, dst] = [dst, src];
            srcIsEmpty = false;
            inputFp += `|AG:${entry.parentLayerId}:${entry.baseLayer.contentVersion}:${entry.baseLayer.opacity}:${entry.baseLayer.blendMode}:${entry.baseLayer.offsetX}:${entry.baseLayer.offsetY}:M${baseMaskVersion}:${baseMaskOx}:${baseMaskOy}:${paramsKey}`;
            continue;
          } else {
            // Cache miss: run all adjustment passes.
            const result = this.encodeAdjustmentGroup(encoder, entry);

            // Persist the result to a cache texture for subsequent frames.
            const texUsage =
              GPUTextureUsage.TEXTURE_BINDING |
              GPUTextureUsage.COPY_DST |
              GPUTextureUsage.COPY_SRC |
              GPUTextureUsage.RENDER_ATTACHMENT;
            const cacheTex =
              cached?.tex ??
              createTrackedTexture(this.device, {
                size: { width: this.pixelWidth, height: this.pixelHeight },
                format: this.internalFormat,
                usage: texUsage,
              });
            encoder.copyTextureToTexture(
              { texture: result },
              { texture: cacheTex },
              { width: this.pixelWidth, height: this.pixelHeight },
            );
            this.adjGroupCache.set(entry.parentLayerId, {
              baseContentVersion: entry.baseLayer.contentVersion,
              offsetX: entry.baseLayer.offsetX,
              offsetY: entry.baseLayer.offsetY,
              baseMaskVersion,
              baseMaskOffsetX: baseMaskOx,
              baseMaskOffsetY: baseMaskOy,
              paramsKey,
              tex: cacheTex,
              lastEncodeTime: performance.now(),
            });

            groupResult = result;
          }
        } else {
          groupResult = this.encodeAdjustmentGroup(encoder, entry);
        }

        // If the layer is locked, bake the result for all future frames.
        if (entry.locked && !this.bakedLockedLayers.has(entry.parentLayerId)) {
          const bakeTex = createTrackedTexture(this.device, {
            size: { width: this.pixelWidth, height: this.pixelHeight },
            format: this.internalFormat,
            usage:
              GPUTextureUsage.TEXTURE_BINDING |
              GPUTextureUsage.COPY_DST |
              GPUTextureUsage.RENDER_ATTACHMENT,
          });
          encoder.copyTextureToTexture(
            { texture: groupResult },
            { texture: bakeTex },
            { width: this.pixelWidth, height: this.pixelHeight },
          );
          this.bakedLockedLayers.set(entry.parentLayerId, bakeTex);
        }

        this.encodeCompositeTexture(
          encoder,
          groupResult,
          src,
          dst,
          entry.baseLayer.opacity,
          entry.baseLayer.blendMode,
          srcIsEmpty,
        );
        [src, dst] = [dst, src];
        srcIsEmpty = false;
        const l = entry.baseLayer;
        inputFp += `|AG:${entry.parentLayerId}:${l.contentVersion}:${l.opacity}:${l.blendMode}:${l.offsetX}:${l.offsetY}:M${baseMaskVersion}:${baseMaskOx}:${baseMaskOy}:${paramsKey}`;
      } else {
        // EffectRenderOp — visible guard already handled per-op in EffectEncoder
        if (!entry.visible) continue;
        // In preview mode (e.g. whole-layer drag), skip expensive standalone effects
        // (bloom, halation, glow, drop-shadow, etc.) — they re-run on pointer-up.
        if (this.previewMode) {
          inputFp += `|SKIP:${(entry as EffectRenderOp).layerId}`;
          continue;
        }
        const op = entry as EffectRenderOp;
        const opParamsKey = serializeAdjOp(op);

        if (this.adjGroupCacheEnabled) {
          const cached = this.standaloneOpCache.get(op.layerId);
          const fullMatch =
            !!cached &&
            cached.inputFp === inputFp &&
            cached.paramsKey === opParamsKey;
          // Throttle: standalone effect input changed (upstream pixels were
          // painted) but its own params are identical → reuse stale output
          // until the 250 ms window expires. Avoids re-running expensive
          // multi-pass effects (bloom, halation, glow, drop-shadow) on every
          // paint event.
          // Throttle while a stroke is active: skip re-running the (typically
          // multi-pass) standalone effect and reuse the previous output.
          // strokeEnd forces a refresh so the cache miss path runs once.
          const throttledMatch =
            !fullMatch &&
            !!cached &&
            cached.paramsKey === opParamsKey &&
            this.strokeActive;
          if (fullMatch || throttledMatch) {
            // Cache hit: dst = src + op(src) is replaced by dst = cached. Copy and swap.
            encoder.copyTextureToTexture(
              { texture: cached!.tex },
              { texture: dst },
              { width: this.pixelWidth, height: this.pixelHeight },
            );
            [src, dst] = [dst, src];
            srcIsEmpty = false;
            inputFp += `|SO:${op.layerId}:${opParamsKey}`;
            continue;
          }
          // Cache miss: encode normally, then snapshot dst into cache.
          this.adjEncoder.encode(encoder, op, src, dst, this.internalFormat);
          [src, dst] = [dst, src];
          srcIsEmpty = false;
          const texUsage =
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.COPY_SRC |
            GPUTextureUsage.RENDER_ATTACHMENT;
          const cacheTex =
            cached?.tex ??
            createTrackedTexture(this.device, {
              size: { width: this.pixelWidth, height: this.pixelHeight },
              format: this.internalFormat,
              usage: texUsage,
            });
          // After the swap, the op's output now lives in `src`.
          encoder.copyTextureToTexture(
            { texture: src },
            { texture: cacheTex },
            { width: this.pixelWidth, height: this.pixelHeight },
          );
          this.standaloneOpCache.set(op.layerId, {
            inputFp,
            paramsKey: opParamsKey,
            tex: cacheTex,
            lastEncodeTime: performance.now(),
          });
          inputFp += `|SO:${op.layerId}:${opParamsKey}`;
        } else {
          this.adjEncoder.encode(encoder, op, src, dst, this.internalFormat);
          [src, dst] = [dst, src];
          srcIsEmpty = false;
          inputFp += `|SO:${op.layerId}:${opParamsKey}`;
        }
      }
    }
    return { src, dst, inputFp, srcIsEmpty };
  }

  /**
   * Allocate a single-frame canvas-sized texture for an isolated group's
   * ping/pong buffer. Tracked in `pendingDestroyTextures` so it's released
   * after submit by {@link flushPendingDestroys}.
   */
  private allocateTempGroupTex(): GPUTexture {
    const texUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT;
    const tex = this.createPingPongTex(
      this.pixelWidth,
      this.pixelHeight,
      texUsage,
    );
    this.pendingDestroyTextures.push(tex);
    return tex;
  }

  /**
   * Draw the transparency checkerboard background directly into the swapchain
   * view. Uses the pre-allocated static checker uniform + bind group, so this
   * is just a single triangle-list draw — no per-frame allocations. Respects
   * `viewportScissor` so we don't waste fill rate on the off-screen part of
   * the canvas backing buffer at zoom > 1.
   */
  private encodeCheckerboard(
    encoder: GPUCommandEncoder,
    view: GPUTextureView,
  ): void {
    // Uses pre-allocated checkerUniformBuf + checkerBindGroup (static, never change)
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.checkerPipeline);
    pass.setBindGroup(0, this.checkerBindGroup);
    pass.setVertexBuffer(0, this.canvasQuadVertBuf);
    pass.setVertexBuffer(1, this.texCoordBuffer);
    if (this.viewportScissor) {
      const s = this.viewportScissor;
      pass.setScissorRect(s.x, s.y, s.w, s.h);
    }
    pass.draw(6);
    pass.end();
  }

  /**
   * Tone-map the internal composite texture into the swapchain. Writes the
   * current `displayStore` exposure / tone-mapping operator into the HDR
   * uniform, picks a cached bind group keyed on `srcTex` identity (cheap —
   * only ever ping or pong), then dispatches a single triangle-list draw with
   * src-over blending so the checkerboard underneath shows through alpha.
   * Honours `viewportScissor` for partial-canvas updates.
   */
  private encodeBlitToView(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    view: GPUTextureView,
  ): void {
    // Update HDR tone-mapping uniforms before the blit
    const exposureLinear = Math.pow(2, displayStore.exposureEV);
    const isFp32 = this.pixelFormat === "rgba32f" ? 1.0 : 0.0;
    const operatorId =
      OPERATOR_SHADER_ID[displayStore.toneMappingOperator] ?? 1;
    const tmView = this.blitUnifView;
    tmView.setFloat32(0, exposureLinear, true);
    tmView.setFloat32(4, isFp32, true);
    tmView.setUint32(8, operatorId, true);
    tmView.setFloat32(12, 0.0, true);
    this.device.queue.writeBuffer(this.hdrUniformBuffer, 0, this.blitUnifAB);

    // Cache the blit bind group by srcTex identity. It is only ever one of two textures
    // (ping / pong) and the sampler + buffers never change object identity, so the BG
    // can be reused every frame once built.
    let bindGroup = this.blitBindGroupCache.get(srcTex);
    if (!bindGroup) {
      bindGroup = this.device.createBindGroup({
        layout: this.hdrBlitBGL,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: srcTex.createView() },
          { binding: 2, resource: { buffer: this.frameUniformBuf } },
          { binding: 3, resource: { buffer: this.hdrUniformBuffer } },
        ],
      });
      this.blitBindGroupCache.set(srcTex, bindGroup);
    }

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          loadOp: "load",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.hdrBlitPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, this.canvasQuadVertBuf);
    pass.setVertexBuffer(1, this.texCoordBuffer);
    if (this.viewportScissor) {
      const s = this.viewportScissor;
      pass.setScissorRect(s.x, s.y, s.w, s.h);
    }
    pass.draw(6);
    pass.end();
  }

  /**
   * Composite a single layer over `srcTex` into `dstTex` using its blend mode,
   * opacity, and optional mask. Two-step:
   *
   *  1. **Preserve outside the layer's bbox**: copy the four strips of `src`
   *     outside the layer's quad into `dst` (or, in the incremental path,
   *     copy only the slice inside the dirty rect). Skipped when
   *     `srcIsEmpty`.
   *  2. **Render the quad** covering the layer's bbox in canvas space, with
   *     scissor set to the dirty rect ∩ layer rect when in incremental mode.
   *
   * Reuses pooled uniform/vertex buffers and a per-slot cached bind group so
   * a steady-state frame allocates zero GPU descriptor sets.
   */
  private encodeCompositeLayer(
    encoder: GPUCommandEncoder,
    layer: GpuLayer,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    maskLayer?: GpuLayer,
    srcIsEmpty = false,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this;
    const ox = layer.offsetX;
    const oy = layer.offsetY;
    const lw = layer.layerWidth;
    const lh = layer.layerHeight;

    // Step 1: copy src → dst so regions outside the layer's sub-rect are preserved.
    // Skip when srcIsEmpty: dst is already cleared (zeros), so copying zeros onto zeros
    // would be an 84 MB GPU DMA for nothing at large canvas sizes.
    //
    // Only the strips OUTSIDE the layer's quad need preservation — pixels inside
    // the quad are about to be overwritten by Step 2's render pass. For a layer
    // that covers the full canvas (e.g. painting on a background layer at
    // 7000×9933) all four strips are empty, eliminating the 278 MB copy entirely.
    //
    // In the incremental path: ping/pong are preloaded with stableTex outside
    // the dirty rect and zeroed inside it. We only need to propagate the
    // previous layer's partial composite WITHIN the dirty rect — a single small
    // copy of dirty.w × dirty.h × bpp.
    const scissor = this.incrementalScissor;
    if (scissor !== null) {
      // Incremental path: skip layers that don't intersect the dirty rect.
      const sx0 = Math.max(scissor.x, ox);
      const sy0 = Math.max(scissor.y, oy);
      const sx1 = Math.min(scissor.x + scissor.w, ox + lw);
      const sy1 = Math.min(scissor.y + scissor.h, oy + lh);
      if (sx0 >= sx1 || sy0 >= sy1) {
        // Layer doesn't touch the dirty region. We still must propagate the
        // running composite from src→dst within the dirty rect, because the
        // caller will swap src/dst after this call. Without the copy the next
        // layer that DOES intersect dirty would read stale (cleared) pong
        // contents and lose every prior layer's contribution inside dirty —
        // producing transparent holes wherever a non-intersecting layer sits
        // between two intersecting ones.
        if (!srcIsEmpty) {
          encoder.copyTextureToTexture(
            { texture: srcTex, origin: { x: scissor.x, y: scissor.y } },
            { texture: dstTex, origin: { x: scissor.x, y: scissor.y } },
            { width: scissor.w, height: scissor.h },
          );
        }
        return;
      }
      if (!srcIsEmpty) {
        // Propagate the previous layer's partial composite within the dirty rect.
        // Outside the dirty rect, dst already holds stableTex content (preloaded);
        // we never overwrite it (scissor blocks writes).
        encoder.copyTextureToTexture(
          { texture: srcTex, origin: { x: scissor.x, y: scissor.y } },
          { texture: dstTex, origin: { x: scissor.x, y: scissor.y } },
          { width: scissor.w, height: scissor.h },
        );
      }
    } else if (!srcIsEmpty) {
      copyOutsideRect(encoder, srcTex, dstTex, ox, oy, lw, lh, w, h);
    }

    // Step 2: Composite the layer's texture over its sub-rect
    // WGSL CompositeUniforms layout (64 bytes):
    //   offset  0: opacity    : f32
    //   offset  4: blendMode  : u32
    //   offset  8: (pad to align dstRect to 16)
    //   offset 16: dstRect    : vec4f  (16 bytes)
    //   offset 32: hasMask    : u32
    //   offset 36: (pad to align maskRect to 16)
    //   offset 48: maskRect   : vec4f  (16 bytes; mask rect in canvas-normalised coords)
    //   total size: 64 bytes
    // Acquire a reusable (uniform, vertex) buffer pair from the pool.
    const slot = this.acquireCompositeBuffers();
    const { unif: unifBuf, pos: posBuffer } = slot;
    const unifView = this.compositeUnifView;
    unifView.setFloat32(0, layer.opacity, true);
    unifView.setUint32(4, BLEND_MODE_INDEX[layer.blendMode] ?? 0, true);
    unifView.setFloat32(16, ox / w, true); // dstRect.x
    unifView.setFloat32(20, oy / h, true); // dstRect.y
    unifView.setFloat32(24, lw / w, true); // dstRect.z
    unifView.setFloat32(28, lh / h, true); // dstRect.w
    unifView.setUint32(32, maskLayer ? 1 : 0, true);
    // maskRect: where the mask buffer covers in canvas-normalised coords.
    // Outside this rect the shader treats the mask as 0 (parent hidden).
    if (maskLayer) {
      unifView.setFloat32(48, maskLayer.offsetX / w, true);
      unifView.setFloat32(52, maskLayer.offsetY / h, true);
      unifView.setFloat32(56, maskLayer.layerWidth / w, true);
      unifView.setFloat32(60, maskLayer.layerHeight / h, true);
    } else {
      unifView.setFloat32(48, 0, true);
      unifView.setFloat32(52, 0, true);
      unifView.setFloat32(56, 1, true);
      unifView.setFloat32(60, 1, true);
    }

    writeUniformBuffer(device, unifBuf, this.compositeUnifAB);

    const dummyMaskTex = maskLayer?.texture ?? srcTex; // use any fallback if no mask

    // Reuse the cached bind group when all three texture identities are unchanged.
    // createBindGroup allocates a GPU descriptor set; at 60 fps with N layers that's
    // N * 60 descriptor sets/sec — eliminated when the layer stack is stable.
    let bindGroup: GPUBindGroup;
    if (
      slot.cachedBG !== null &&
      slot.cachedLayerTex === layer.texture &&
      slot.cachedSrcTex === srcTex &&
      slot.cachedMaskTex === dummyMaskTex
    ) {
      bindGroup = slot.cachedBG;
    } else {
      bindGroup = device.createBindGroup({
        layout: this.compositeBGL,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: layer.texture.createView() },
          { binding: 2, resource: srcTex.createView() },
          { binding: 3, resource: dummyMaskTex.createView() },
          { binding: 4, resource: { buffer: unifBuf } },
          { binding: 5, resource: { buffer: this.frameUniformBuf } },
        ],
      });
      slot.cachedBG = bindGroup;
      slot.cachedLayerTex = layer.texture;
      slot.cachedSrcTex = srcTex;
      slot.cachedMaskTex = dummyMaskTex;
    }

    // Position quad covering only the layer's canvas-space rect
    const qv = this.compositeQuadF32;
    qv[0] = ox;
    qv[1] = oy;
    qv[2] = ox + lw;
    qv[3] = oy;
    qv[4] = ox;
    qv[5] = oy + lh;
    qv[6] = ox;
    qv[7] = oy + lh;
    qv[8] = ox + lw;
    qv[9] = oy;
    qv[10] = ox + lw;
    qv[11] = oy + lh;
    device.queue.writeBuffer(posBuffer, 0, qv);

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: dstTex.createView(),
          loadOp: "load",
          storeOp: "store",
        },
      ],
    });
    if (scissor !== null) {
      // Constrain the composite to the canvas-space dirty rect intersected with
      // the layer rect. Pixels outside the scissor in dstTex are preserved.
      const sx0 = Math.max(scissor.x, ox);
      const sy0 = Math.max(scissor.y, oy);
      const sx1 = Math.min(scissor.x + scissor.w, ox + lw);
      const sy1 = Math.min(scissor.y + scissor.h, oy + lh);
      pass.setScissorRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
    }
    pass.setPipeline(this.compositePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, posBuffer);
    pass.setVertexBuffer(1, this.texCoordBuffer);
    pass.draw(6);
    pass.end();
  }

  /**
   * Composite a canvas-sized texture (group result, cached output, baked
   * texture, etc.) over `srcTex` into `dstTex`. Wraps {@link encodeCompositeLayer}
   * by synthesising a pseudo-{@link GpuLayer} pointed at `texture`. The
   * (offsetX, offsetY) arguments shift where `texture`'s pixels appear — the
   * adj-group cache uses this to draw a cached canvas-sized result at a new
   * layer position during a drag without re-running the effect chain.
   */
  private encodeCompositeTexture(
    encoder: GPUCommandEncoder,
    texture: GPUTexture,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    opacity: number,
    blendMode: string,
    srcIsEmpty = false,
    offsetX = 0,
    offsetY = 0,
  ): void {
    const pseudoLayer: GpuLayer = {
      id: "__group-composite__",
      name: "group",
      texture,
      data: new Uint8Array(0),
      format: this.pixelFormat,
      layerWidth: this.pixelWidth,
      layerHeight: this.pixelHeight,
      offsetX,
      offsetY,
      opacity,
      visible: true,
      blendMode,
      dirtyRect: null,
      contentVersion: 0,
    };
    this.encodeCompositeLayer(
      encoder,
      pseudoLayer,
      srcTex,
      dstTex,
      undefined,
      srcIsEmpty,
    );
  }

  /**
   * Run the full effect chain for an adjustment-group entry: composite the
   * base layer into the shared groupPing/groupPong textures, then iterate
   * each visible op through the {@link EffectEncoder}, ping-ponging the
   * src/dst textures between passes. Returns whichever ping-pong holds the
   * final adjusted output.
   */
  private encodeAdjustmentGroup(
    encoder: GPUCommandEncoder,
    entry: Extract<RenderPlanEntry, { kind: "adjustment-group" }>,
  ): GPUTexture {
    encodeClearTexture(encoder, this.groupPingTex);
    encodeClearTexture(encoder, this.groupPongTex);

    let srcTex = this.groupPongTex;
    let dstTex = this.groupPingTex;

    const baseAsSource: GpuLayer = {
      ...entry.baseLayer,
      opacity: 1,
      blendMode: "normal",
    };
    this.encodeCompositeLayer(
      encoder,
      baseAsSource,
      srcTex,
      dstTex,
      entry.baseMask,
      true,
    );
    [srcTex, dstTex] = [dstTex, srcTex];

    for (const op of entry.adjustments) {
      if (!op.visible) continue;
      this.adjEncoder.encode(encoder, op, srcTex, dstTex, this.internalFormat);
      [srcTex, dstTex] = [dstTex, srcTex];
    }

    return srcTex;
  }

  /**
   * Release every resource accumulated during the just-submitted command
   * encoder: temporary buffers (`pendingDestroyBuffers`), temporary textures
   * (`pendingDestroyTextures`), plus the EffectEncoder's own per-frame
   * trash. Also calls `adjEncoder.endFrame()` to drop per-effect texture
   * caches whose source layer was removed this frame. Must run AFTER
   * `device.queue.submit` so the GPU is done with everything we destroy.
   */
  private flushPendingDestroys(): void {
    for (const buf of this.pendingDestroyBuffers) buf.destroy();
    this.pendingDestroyBuffers = [];
    for (const tex of this.pendingDestroyTextures) destroyTrackedTexture(tex);
    this.pendingDestroyTextures = [];
    this.adjEncoder.flushPendingDestroys();
    // Drop per-effect texture caches whose layer wasn't rendered this
    // frame (e.g. user just removed the bloom adjustment layer).
    this.adjEncoder.endFrame();
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Release every long-lived GPU resource owned by the renderer. Destroys
   * ping-pong textures, the texcoord vertex buffer, the EffectEncoder,
   * every cached adj-group / baked-locked / standalone-op / composite-layer
   * texture, and the pooled composite uniform/vertex buffers. Finally calls
   * `device.destroy()` which invalidates every GPU object derived from it
   * (so callers must drop their references after this).
   */
  destroy(): void {
    this.refreshCallback = null;
    destroyTrackedTexture(this.pingTex);
    destroyTrackedTexture(this.pongTex);
    destroyTrackedTexture(this.groupPingTex);
    destroyTrackedTexture(this.groupPongTex);
    this.texCoordBuffer.destroy();
    this.adjEncoder.destroy();
    for (const entry of this.adjGroupCache.values())
      destroyTrackedTexture(entry.tex);
    this.adjGroupCache.clear();
    for (const tex of this.bakedLockedLayers.values())
      destroyTrackedTexture(tex);
    this.bakedLockedLayers.clear();
    for (const entry of this.standaloneOpCache.values())
      destroyTrackedTexture(entry.tex);
    this.standaloneOpCache.clear();
    for (const entry of this.compositeLayerCache.values())
      destroyTrackedTexture(entry.tex);
    this.compositeLayerCache.clear();
    for (const pair of this.compositeBufferPool) {
      pair.unif.destroy();
      pair.pos.destroy();
    }
    this.compositeBufferPool = [];
    this.device.destroy();
  }
}
