import type { GpuDevice } from "../device/GpuDevice";
import type { ResourceCache } from "../resources/ResourceCache";
import type { LayerTextureStore } from "../layers/LayerTextureStore";
import type { DisplayPresenter } from "./DisplayPresenter";
import type { RenderCache } from "./RenderCache";
import type { EffectEncoder } from "../EffectEncoder";
import type { PixelFormat } from "@/types";
import type { RenderPlanEntry } from "../types";
import {
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";
import {
  serializeAdjOp,
  computeAdjGroupParamsKey,
} from "../rendering/cacheKeys";
import { displayStore } from "@/ux/main/Canvas/displayStore";
import { ensureLutOnGpu } from "@/core/lut/lutGpu";
import { lutStore } from "@/core/lut/lutStore";
import { effectiveColorSpace, idtLutIdFor } from "@/core/lut/layerColorSpace";
import {
  encodeClearTexture,
  copyOutsideRect,
} from "../rendering/copyEncoders";
import type { GpuLayer, EffectRenderOp } from "../types";
import { BLEND_MODE_INDEX } from "../types";
import { writeUniformBuffer } from "../utils";

interface CompositeBufferSlot {
  unif: GPUBuffer;
  pos: GPUBuffer;
  cachedBG: GPUBindGroup | null;
  cachedLayerTex: GPUTexture | null;
  cachedSrcTex: GPUTexture | null;
  cachedMaskTex: GPUTexture | null;
  /** Identity of the inline-IDT cube + shaper textures used in the cached
   *  bind group — invalidates when the layer's tag picks a different LUT
   *  bundle (or moves between identity placeholder and a real cube). */
  cachedCubeTex: GPUTexture | null;
  cachedShaperTex: GPUTexture | null;
}

/**
 * Owns the per-frame compositing pipeline: ping-pong textures, composite
 * buffer pool, plan fingerprinting, dirty-rect tracking, stable-cache
 * snapshotting, stroke/preview gating, and all encoder pass logic. The
 * renderer hands the executor a render plan; the executor produces a final
 * composite texture and (for the on-screen path) drives the presenter.
 *
 * This is the "engine" of WebGPURenderer — everything between "here's a list
 * of layers" and "here's a finished texture ready to present."
 */
export class RenderPlanExecutor {
  readonly gpu: GpuDevice;
  readonly resources: ResourceCache;
  readonly layerTextures: LayerTextureStore;
  readonly presenter: DisplayPresenter;
  readonly cache: RenderCache;
  readonly adjEncoder: EffectEncoder;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly pixelFormat: PixelFormat;
  readonly internalFormat: GPUTextureFormat;
  // ── Convenience aliases so encoding methods read cleanly ───────────────
  readonly device: GPUDevice;
  readonly sampler: GPUSampler; // nearest, non-filtering
  readonly texCoordBuffer: GPUBuffer;
  readonly frameUniformBuf: GPUBuffer;
  readonly compositePipeline: GPURenderPipeline;
  readonly compositeBGL: GPUBindGroupLayout;
  readonly identityLutCube: GPUTexture;
  readonly identityLutShaper: GPUTexture;
  readonly identityLutCubeView: GPUTextureView;
  readonly identityLutShaperView: GPUTextureView;
  readonly lutBlitSampler: GPUSampler;

  // Canvas-sized ping-pong composite targets. `pingTex` and `pongTex` are the
  // top-level pair; `groupPingTex` and `groupPongTex` are reserved for
  // isolated-group compositing so a recursive group encode doesn't trash the
  // outer accumulator.
  pingTex: GPUTexture;
  pongTex: GPUTexture;
  groupPingTex: GPUTexture;
  groupPongTex: GPUTexture;

  // Temporary GPU resources accumulated during composite encoding; flushed
  // after queue submit so the driver is done reading from them.
  pendingDestroyBuffers: GPUBuffer[] = [];
  pendingDestroyTextures: GPUTexture[] = [];

  // Per-composite (uniform, vertex) buffer pool + per-slot bind-group cache.
  // The BG cache avoids recreating a GPUBindGroup every frame when the three
  // textures (layer, src ping-pong, mask) haven't changed object identity.
  compositeBufferPool: CompositeBufferSlot[] = [];
  compositeBufferIndex = 0;

  // Pre-allocated scratch reused each frame to avoid GC pressure.
  // 80 bytes — see CompositeUniforms in composite.wgsl. Last 16 bytes hold
  // the inline IDT params (transformMode, cubeSize, hasShaper, _pad).
  readonly compositeUnifAB = new ArrayBuffer(80);
  readonly compositeUnifView = new DataView(this.compositeUnifAB);
  readonly compositeQuadF32 = new Float32Array(12);

  // ─── Stable composite cache ───────────────────────────────────────────────
  // Persists the previous successfully-rendered full-canvas composite so the
  // painting hot path can re-render only the small dirty region instead of
  // re-compositing every layer over the entire canvas every frame.
  stableTex: GPUTexture | null = null;
  hasStableTex = false;

  // ─── Render skip ──────────────────────────────────────────────────────────
  // Fingerprint of the inputs that produced the most recently rendered frame.
  // If the next renderPlan() call has an identical fingerprint, the entire
  // frame is skipped (no encoder, no clear, no copy, no composite, no submit).
  lastPlanFp: string | null = null;

  // ─── Per-frame dirty tracking ─────────────────────────────────────────────
  // Canvas-space union of regions touched since the last successful render.
  // Populated by flushLayer; consumed (and cleared) by renderPlan.
  // null → incremental path is unavailable for this frame (full re-composite).
  frameDirtyCanvasRect: { x: number; y: number; w: number; h: number } | null =
    null;
  // Scissor passed down to encodeCompositeLayer during the incremental path.
  // Null in the full path. When set, encodeCompositeLayer skips copyOutsideRect
  // and constrains the composite render pass to this rect.
  incrementalScissor: { x: number; y: number; w: number; h: number } | null =
    null;

  // ─── Stroke gating ────────────────────────────────────────────────────────
  // Continuous painting tools (brush, eraser, pencil, dodge, clone-stamp) call
  // strokeStart() on pointer-down and strokeEnd() on pointer-up. While a
  // stroke is active, attached effects/adjustments are NOT recomputed — the
  // throttle path composites the layer's raw pixels for real-time feedback.
  refreshCallback: (() => void) | null = null;
  strokeActive = false;

  // When true (e.g. during a whole-layer drag), standalone AdjustmentRenderOps
  // (bloom, halation, glow, drop-shadow, etc.) are skipped so the compositor
  // only re-runs them once on pointer-up.
  previewMode = false;

  // True while encoding a screen-preview renderPlan() — enables the adj-group
  // cache.
  adjGroupCacheEnabled = false;

  constructor(args: {
    gpu: GpuDevice;
    resources: ResourceCache;
    layerTextures: LayerTextureStore;
    presenter: DisplayPresenter;
    cache: RenderCache;
    adjEncoder: EffectEncoder;
    pixelWidth: number;
    pixelHeight: number;
    pixelFormat: PixelFormat;
    internalFormat: GPUTextureFormat;
  }) {
    this.gpu = args.gpu;
    this.resources = args.resources;
    this.layerTextures = args.layerTextures;
    this.presenter = args.presenter;
    this.cache = args.cache;
    this.adjEncoder = args.adjEncoder;
    this.pixelWidth = args.pixelWidth;
    this.pixelHeight = args.pixelHeight;
    this.pixelFormat = args.pixelFormat;
    this.internalFormat = args.internalFormat;

    this.device = args.gpu.device;
    this.sampler = args.resources.nearestSampler;
    this.texCoordBuffer = args.resources.texCoordBuffer;
    this.frameUniformBuf = args.resources.frameUniformBuf;
    this.compositePipeline = args.resources.compositePipeline;
    this.compositeBGL = args.resources.compositeBGL;
    this.identityLutCube = args.resources.identityLutCube;
    this.identityLutShaper = args.resources.identityLutShaper;
    this.identityLutCubeView = args.resources.identityLutCubeView;
    this.identityLutShaperView = args.resources.identityLutShaperView;
    this.lutBlitSampler = args.resources.lutBlitSampler;

    const texUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT;
    this.pingTex = this.createPingPongTex(
      this.pixelWidth,
      this.pixelHeight,
      texUsage,
    );
    this.pongTex = this.createPingPongTex(
      this.pixelWidth,
      this.pixelHeight,
      texUsage,
    );
    this.groupPingTex = this.createPingPongTex(
      this.pixelWidth,
      this.pixelHeight,
      texUsage,
    );
    this.groupPongTex = this.createPingPongTex(
      this.pixelWidth,
      this.pixelHeight,
      texUsage,
    );
  }

  /** Allocate a tracked GPU texture matching the executor's internal format.
   *  Used for ping/pong buffers, isolated group buffers, and stable cache. */
  createPingPongTex(
    w: number,
    h: number,
    usage: GPUTextureUsageFlags,
  ): GPUTexture {
    return createTrackedTexture(this.gpu.device, {
      size: { width: w, height: h },
      format: this.internalFormat,
      usage,
    });
  }

  /** Allocate a single-frame canvas-sized texture for an isolated group's
   *  ping/pong buffer. Tracked in `pendingDestroyTextures` so it's released
   *  after submit by {@link flushPendingDestroys}. */
  allocateTempGroupTex(): GPUTexture {
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

  /** Hand out the next pooled (uniform, vertex) buffer pair for one composite
   *  layer. Pool grows on demand; index resets at the top of each frame. */
  acquireCompositeBuffers(): CompositeBufferSlot {
    const device = this.gpu.device;
    const i = this.compositeBufferIndex++;
    let pair = this.compositeBufferPool[i];
    if (!pair) {
      pair = {
        unif: device.createBuffer({
          // 80 bytes — matches CompositeUniforms in composite.wgsl
          // (last 16 bytes are the inline IDT params).
          size: 80,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        pos: device.createBuffer({
          size: 48, // 6 vertices * 2 floats * 4 bytes
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
        cachedBG: null,
        cachedLayerTex: null,
        cachedSrcTex: null,
        cachedMaskTex: null,
        cachedCubeTex: null,
        cachedShaperTex: null,
      };
      this.compositeBufferPool[i] = pair;
    }
    return pair;
  }

  /** Release every temp resource queued during this frame's encode + drop
   *  any per-effect texture caches whose source layer was removed this frame.
   *  Must run AFTER `queue.submit` so the GPU is done with everything. */
  flushPendingDestroys(): void {
    for (const buf of this.pendingDestroyBuffers) buf.destroy();
    this.pendingDestroyBuffers = [];
    for (const tex of this.pendingDestroyTextures) destroyTrackedTexture(tex);
    this.pendingDestroyTextures = [];
    this.adjEncoder.flushPendingDestroys();
    this.adjEncoder.endFrame();
  }

  /** Union a canvas-space rect into the per-frame dirty accumulator. */
  unionFrameDirty(x: number, y: number, w: number, h: number): void {
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
  detectDragDirty(plan: RenderPlanEntry[]): void {
    for (const entry of plan) {
      if (entry.kind === "layer") {
        if (!entry.layer.visible || entry.layer.opacity === 0) continue;
        const l = entry.layer;
        const prev = this.cache.lastRenderedOffsets.get(l.id);
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
        const prev = this.cache.lastRenderedOffsets.get(entry.parentLayerId);
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

  /** Snapshot the current rendered offset of every visible plan layer. Read
   *  by the next frame's detectDragDirty(). */
  updateLastRenderedOffsets(plan: RenderPlanEntry[]): void {
    for (const entry of plan) {
      if (entry.kind === "layer") {
        if (!entry.layer.visible || entry.layer.opacity === 0) continue;
        const l = entry.layer;
        this.cache.lastRenderedOffsets.set(l.id, {
          x: l.offsetX,
          y: l.offsetY,
          w: l.layerWidth,
          h: l.layerHeight,
        });
      } else if (entry.kind === "adjustment-group") {
        if (!entry.baseLayer.visible || entry.baseLayer.opacity === 0) continue;
        const l = entry.baseLayer;
        this.cache.lastRenderedOffsets.set(entry.parentLayerId, {
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

  /** Mark the start of a continuous painting stroke. */
  strokeStart(): void {
    this.strokeActive = true;
  }

  /** End the stroke and trigger one final render. */
  strokeEnd(): void {
    if (!this.strokeActive) return;
    this.strokeActive = false;
    this.lastPlanFp = null;
    this.refreshCallback?.();
  }

  /** Toggle preview mode (drag). Idempotent. */
  setPreviewMode(enabled: boolean): void {
    if (this.previewMode === enabled) return;
    this.previewMode = enabled;
    this.lastPlanFp = null;
    this.hasStableTex = false;
  }

  /** Force the next renderPlan() to actually execute even if inputs look identical. */
  invalidateRenderCache(): void {
    this.lastPlanFp = null;
    this.hasStableTex = false;
  }

  /** True when every plan entry is a plain layer (no groups, adjustments,
   *  effects). Locked adjustment groups with a baked output texture are also
   *  treated as flat — they composite directly from the baked texture with no
   *  GPU compute. Pass-through groups are transparent organizational units
   *  and recurse into their children. Empty groups (regardless of blend mode)
   *  are no-ops in encodeSubPlan, so they don't disable the flat path. */
  planIsFlatLayersOnly(plan: RenderPlanEntry[]): boolean {
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
        if (!entry.baseLayer.visible || entry.baseLayer.opacity === 0) continue;
        if (
          entry.locked === true &&
          this.cache.bakedLocked.has(entry.parentLayerId)
        )
          continue;
        if (this.previewMode) {
          const cached = this.cache.adjGroup.get(entry.parentLayerId);
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
        this.cache.bakedLocked.has(entry.layerId)
      )
        continue;
      if (entry.kind === "composite-layer" && entry.visible && !entry.locked) {
        const cached = this.cache.compositeLayer.get(entry.layerId);
        if (!cached) return false;
        const adjKey = computeAdjGroupParamsKey(entry.adjustments);
        if (cached.adjKey !== adjKey) return false;
        const parts: string[] = [];
        this.appendPlanFp(entry.children, parts);
        if (cached.childFp === parts.join("")) continue;
        if (entry.adjustments.length > 0) return false;
        continue;
      }
      if (this.previewMode) continue;
      return false;
    }
    return true;
  }

  /** Walk the plan tree and produce a fingerprint string covering everything
   *  that affects the rendered output. Mirrors the inputFp accumulation in
   *  encodeSubPlan plus the inputs touched by renderPlan(). */
  computePlanFingerprint(plan: RenderPlanEntry[]): string {
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

  /** Recursive companion to {@link computePlanFingerprint}. Pushes a per-entry
   *  fingerprint chunk into `out`. Mirrors the cache-key shapes that
   *  {@link encodeSubPlan} accumulates so up-front cache lookups computed by
   *  `planIsFlatLayersOnly` match what the encoder will produce. */
  appendPlanFp(plan: RenderPlanEntry[], out: string[]): void {
    for (const entry of plan) {
      if (entry.kind === "layer") {
        if (!entry.layer.visible || entry.layer.opacity === 0) continue;
        const l = entry.layer;
        const maskPart = entry.mask
          ? `:M${entry.mask.contentVersion}:${entry.mask.offsetX}:${entry.mask.offsetY}`
          : "";
        out.push(
          `|L:${l.id}:${l.contentVersion}:${l.opacity}:${l.blendMode}:${l.offsetX}:${l.offsetY}:CS${l.colorSpace}${maskPart}`,
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
        if (entry.locked && this.cache.bakedLocked.has(entry.layerId)) {
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
        if (!entry.visible) continue;
        if (this.previewMode) {
          out.push(`|SKIP:${entry.layerId}`);
          continue;
        }
        out.push(`|SO:${entry.layerId}:${serializeAdjOp(entry)}`);
      }
    }
  }

  // ─── Inline IDT resolver ────────────────────────────────────────────────
  // The composite shader applies the layer's tagged → working-space
  // transform inline (no scratch texture). This helper turns a layer's
  // colour-space tag into the GPU resources + uniforms the shader needs:
  // a transform mode, an optional 3D-LUT cube, an optional 1D shaper.
  //   transformMode == 0 → passthrough (stored == working space)
  //   transformMode == 1 → analytic sRGB → linear-srgb
  //   transformMode == 2 → camera-log → linear-srgb (shaper + 3D cube)
  resolveLayerIdt(layer: GpuLayer): {
    transformMode: 0 | 1 | 2;
    cubeView: GPUTextureView;
    shaperView: GPUTextureView;
    cubeTex: GPUTexture;
    shaperTex: GPUTexture;
    cubeSize: number;
    hasShaper: boolean;
  } {
    const identity = {
      transformMode: 0 as const,
      cubeView: this.identityLutCubeView,
      shaperView: this.identityLutShaperView,
      cubeTex: this.identityLutCube,
      shaperTex: this.identityLutShaper,
      cubeSize: 2,
      hasShaper: false,
    };
    if (this.pixelFormat !== "rgba32f") return identity;

    const space = effectiveColorSpace(layer.colorSpace, layer.format);
    if (space === "linear-srgb") return identity;
    if (space === "srgb") {
      return { ...identity, transformMode: 1 };
    }
    const lutId = idtLutIdFor(layer.colorSpace);
    if (!lutId) return identity;
    const lut = lutStore.get(lutId);
    if (!lut) return identity;
    const bundle = ensureLutOnGpu(this.device, lut);
    return {
      transformMode: 2,
      cubeView: bundle.cubeView,
      shaperView: bundle.shaperView,
      cubeTex: bundle.cubeTex,
      shaperTex: bundle.shaperTex,
      cubeSize: bundle.cubeSize,
      hasShaper: bundle.hasShaper,
    };
  }

  /** Composite a canvas-sized texture (group result, cached output, baked
   *  texture, etc.) over `srcTex` into `dstTex`. Wraps `encodeCompositeLayer`
   *  by synthesising a pseudo-{@link GpuLayer} pointed at `texture`. */
  encodeCompositeTexture(
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
      contentVersion: 0,
      colorSpace: "auto",
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

  /** Run the full effect chain for an adjustment-group entry: composite the
   *  base layer into the shared groupPing/groupPong textures, then iterate
   *  each visible op through the EffectEncoder, ping-ponging between passes.
   *  Returns whichever ping-pong holds the final adjusted output. */
  encodeAdjustmentGroup(
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
   * Composite a single layer over `srcTex` into `dstTex` using its blend mode,
   * opacity, and optional mask. Two-step:
   *
   *  1. **Preserve outside the layer's bbox**: copy the four strips of `src`
   *     outside the layer's quad into `dst` (or, in the incremental path,
   *     copy only the slice inside the dirty rect). Skipped when `srcIsEmpty`.
   *  2. **Render the quad** covering the layer's bbox in canvas space, with
   *     scissor set to the dirty rect ∩ layer rect when in incremental mode.
   *
   * Reuses pooled uniform/vertex buffers and a per-slot cached bind group so
   * a steady-state frame allocates zero GPU descriptor sets.
   */
  encodeCompositeLayer(
    encoder: GPUCommandEncoder,
    layer: GpuLayer,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    maskLayer?: GpuLayer,
    srcIsEmpty = false,
  ): void {
    const { device, pixelWidth: w, pixelHeight: h } = this;
    const idt = this.resolveLayerIdt(layer);
    const ox = layer.offsetX;
    const oy = layer.offsetY;
    const lw = layer.layerWidth;
    const lh = layer.layerHeight;

    const scissor = this.incrementalScissor;
    if (scissor !== null) {
      const sx0 = Math.max(scissor.x, ox);
      const sy0 = Math.max(scissor.y, oy);
      const sx1 = Math.min(scissor.x + scissor.w, ox + lw);
      const sy1 = Math.min(scissor.y + scissor.h, oy + lh);
      if (sx0 >= sx1 || sy0 >= sy1) {
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
        encoder.copyTextureToTexture(
          { texture: srcTex, origin: { x: scissor.x, y: scissor.y } },
          { texture: dstTex, origin: { x: scissor.x, y: scissor.y } },
          { width: scissor.w, height: scissor.h },
        );
      }
    } else if (!srcIsEmpty) {
      copyOutsideRect(encoder, srcTex, dstTex, ox, oy, lw, lh, w, h);
    }

    const slot = this.acquireCompositeBuffers();
    const { unif: unifBuf, pos: posBuffer } = slot;
    const unifView = this.compositeUnifView;
    unifView.setFloat32(0, layer.opacity, true);
    unifView.setUint32(4, BLEND_MODE_INDEX[layer.blendMode] ?? 0, true);
    unifView.setFloat32(16, ox / w, true);
    unifView.setFloat32(20, oy / h, true);
    unifView.setFloat32(24, lw / w, true);
    unifView.setFloat32(28, lh / h, true);
    unifView.setUint32(32, maskLayer ? 1 : 0, true);
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
    unifView.setUint32(64, idt.transformMode, true);
    unifView.setFloat32(68, idt.cubeSize, true);
    unifView.setUint32(72, idt.hasShaper ? 1 : 0, true);
    unifView.setUint32(76, 0, true);

    writeUniformBuffer(device, unifBuf, this.compositeUnifAB);

    const dummyMaskTex = maskLayer?.texture ?? srcTex;

    let bindGroup: GPUBindGroup;
    if (
      slot.cachedBG !== null &&
      slot.cachedLayerTex === layer.texture &&
      slot.cachedSrcTex === srcTex &&
      slot.cachedMaskTex === dummyMaskTex &&
      slot.cachedCubeTex === idt.cubeTex &&
      slot.cachedShaperTex === idt.shaperTex
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
          { binding: 6, resource: idt.cubeView },
          { binding: 7, resource: idt.shaperView },
          { binding: 8, resource: this.lutBlitSampler },
        ],
      });
      slot.cachedBG = bindGroup;
      slot.cachedLayerTex = layer.texture;
      slot.cachedSrcTex = srcTex;
      slot.cachedMaskTex = dummyMaskTex;
      slot.cachedCubeTex = idt.cubeTex;
      slot.cachedShaperTex = idt.shaperTex;
    }

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
        { view: dstTex.createView(), loadOp: "load", storeOp: "store" },
      ],
    });
    if (scissor !== null) {
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

  /** Render a flat list of layers (bottom-to-top) into the swapchain.
   *  Convenience wrapper that synthesises a trivial render plan. */
  render(layers: GpuLayer[], maskMap?: Map<string, GpuLayer>): void {
    const plan: RenderPlanEntry[] = layers.map((layer) => ({
      kind: "layer" as const,
      layer,
      mask: maskMap?.get(layer.id),
    }));
    this.renderPlan(plan);
  }

  /**
   * Composite a render plan into the swapchain. The hot path:
   * 1. Compute a plan fingerprint and short-circuit when identical to the
   *    last frame.
   * 2. Synthesise a drag-induced dirty rect by comparing each layer's offset
   *    to its last-rendered position.
   * 3. Choose between the **incremental** path (small dirty rect + flat plan
   *    + valid stable cache) and the **full** path (re-composite every layer
   *    over the whole canvas, snapshot into stableTex).
   * 4. Snapshot the rendered offsets so the next frame can detect drag deltas.
   */
  renderPlan(plan: RenderPlanEntry[]): void {
    const { device, pixelWidth: w, pixelHeight: h } = this;

    const planFp = this.computePlanFingerprint(plan);
    if (planFp === this.lastPlanFp) {
      this.frameDirtyCanvasRect = null;
      if (this.presenter.viewportDirty && this.hasStableTex && this.stableTex !== null) {
        const reblitEnc = device.createCommandEncoder();
        const screenView = this.gpu.context.getCurrentTexture().createView();
        this.presenter.presentToScreen(reblitEnc, this.stableTex, screenView);
        device.queue.submit([reblitEnc.finish()]);
        this.presenter.viewportDirty = false;
      }
      return;
    }

    this.detectDragDirty(plan);

    const dirty = this.frameDirtyCanvasRect;
    const flatPlan = this.planIsFlatLayersOnly(plan);
    const canIncremental =
      this.hasStableTex &&
      this.stableTex !== null &&
      dirty !== null &&
      dirty.w > 0 &&
      dirty.h > 0 &&
      flatPlan &&
      dirty.w * dirty.h < w * h * 0.6;
    const encoder = device.createCommandEncoder();

    if (canIncremental && dirty !== null && this.stableTex !== null) {
      const zeroTex = createTrackedTexture(device, {
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

      encoder.copyTextureToTexture(
        { texture: finalTex, origin: { x: dirty.x, y: dirty.y } },
        { texture: this.stableTex, origin: { x: dirty.x, y: dirty.y } },
        { width: dirty.w, height: dirty.h },
      );

      const screenView = this.gpu.context.getCurrentTexture().createView();
      this.presenter.presentToScreen(encoder, this.stableTex, screenView);

      device.queue.submit([encoder.finish()]);
      this.flushPendingDestroys();
    } else {
      this.adjGroupCacheEnabled = true;
      const finalTex = this.encodePlanToComposite(encoder, plan);
      this.adjGroupCacheEnabled = false;

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
      const stable = this.stableTex;
      encoder.copyTextureToTexture(
        { texture: finalTex },
        { texture: stable },
        { width: w, height: h },
      );

      const screenView = this.gpu.context.getCurrentTexture().createView();
      this.presenter.presentToScreen(encoder, finalTex, screenView);

      device.queue.submit([encoder.finish()]);
      this.flushPendingDestroys();
      this.hasStableTex = true;
    }

    this.lastPlanFp = planFp;
    this.frameDirtyCanvasRect = null;
    this.updateLastRenderedOffsets(plan);
    this.presenter.viewportDirty = false;
  }

  /** Composite an entire plan into one of the ping-pong textures and return
   *  whichever one holds the final result. Used by the full path of
   *  {@link renderPlan} and by readback. */
  encodePlanToComposite(
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
   * Core compositing loop. Walks `plan` in order, dispatching each entry
   * kind through its appropriate cache-aware fast paths. Maintains the
   * running ping-pong pair (`src` holds the accumulated composite, `dst` is
   * the next write target — they swap after every entry that writes pixels).
   * Returns the final pair plus the accumulated `inputFp` used by downstream
   * caches (standaloneOpCache, compositeLayerCache).
   */
  encodeSubPlan(
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
        inputFp += `|L:${l.id}:${l.contentVersion}:${l.opacity}:${l.blendMode}:${l.offsetX}:${l.offsetY}:CS${l.colorSpace}${maskPart}`;
      } else if (entry.kind === "layer-group") {
        if (!entry.visible) continue;
        if (entry.children.length === 0) continue;
        if (entry.blendMode === "pass-through") {
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

        if (entry.locked) {
          const bakedTex = this.cache.bakedLocked.get(entry.layerId);
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
          if (this.adjGroupCacheEnabled) {
            const cached = this.cache.compositeLayer.get(entry.layerId);
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
                this.cache.bakedLocked.set(entry.layerId, cached.tex);
                this.cache.compositeLayer.delete(entry.layerId);
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
        } else {
          const stale = this.cache.bakedLocked.get(entry.layerId);
          if (stale) {
            destroyTrackedTexture(stale);
            this.cache.bakedLocked.delete(entry.layerId);
          }
        }

        const adjKey = this.adjGroupCacheEnabled
          ? computeAdjGroupParamsKey(entry.adjustments)
          : entry.adjustments.map((a) => a.layerId).join(",");

        if (this.adjGroupCacheEnabled) {
          const cached = this.cache.compositeLayer.get(entry.layerId);
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

        if (
          this.incrementalScissor !== null &&
          entry.adjustments.length === 0 &&
          this.adjGroupCacheEnabled
        ) {
          const cached = this.cache.compositeLayer.get(entry.layerId);
          if (cached) {
            const dirty = this.incrementalScissor;
            const isoA = this.allocateTempGroupTex();
            const isoB = this.allocateTempGroupTex();
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

        let compositeSrc: GPUTexture = child.src;
        if (entry.adjustments.length > 0) {
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

        if (this.adjGroupCacheEnabled) {
          const existing = this.cache.compositeLayer.get(entry.layerId);
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
          this.cache.compositeLayer.set(entry.layerId, {
            childFp: child.inputFp,
            adjKey,
            tex: cacheTex,
          });
        }

        if (entry.locked && !this.cache.bakedLocked.has(entry.layerId)) {
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
          this.cache.bakedLocked.set(entry.layerId, bakeTex);
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

        if (entry.locked) {
          const bakedTex = this.cache.bakedLocked.get(entry.parentLayerId);
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
        } else {
          const stale = this.cache.bakedLocked.get(entry.parentLayerId);
          if (stale) {
            destroyTrackedTexture(stale);
            this.cache.bakedLocked.delete(entry.parentLayerId);
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
          const cached = this.cache.adjGroup.get(entry.parentLayerId);

          const paramsAndMaskBufferMatch =
            !!cached &&
            cached.baseMaskVersion === baseMaskVersion &&
            cached.paramsKey === paramsKey;
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
          const throttledMatch =
            !fullMatch && positionAndParamsMatch && this.strokeActive;
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
            groupResult = cached!.tex;
          } else if (throttledMatch) {
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
            const result = this.encodeAdjustmentGroup(encoder, entry);

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
            this.cache.adjGroup.set(entry.parentLayerId, {
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

        if (entry.locked && !this.cache.bakedLocked.has(entry.parentLayerId)) {
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
          this.cache.bakedLocked.set(entry.parentLayerId, bakeTex);
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
        if (!entry.visible) continue;
        if (this.previewMode) {
          inputFp += `|SKIP:${(entry as EffectRenderOp).layerId}`;
          continue;
        }
        const op = entry as EffectRenderOp;
        const opParamsKey = serializeAdjOp(op);

        if (this.adjGroupCacheEnabled) {
          const cached = this.cache.standaloneOp.get(op.layerId);
          const fullMatch =
            !!cached &&
            cached.inputFp === inputFp &&
            cached.paramsKey === opParamsKey;
          const throttledMatch =
            !fullMatch &&
            !!cached &&
            cached.paramsKey === opParamsKey &&
            this.strokeActive;
          if (fullMatch || throttledMatch) {
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
          encoder.copyTextureToTexture(
            { texture: src },
            { texture: cacheTex },
            { width: this.pixelWidth, height: this.pixelHeight },
          );
          this.cache.standaloneOp.set(op.layerId, {
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

  /** Release ping-pong + composite-buffer-pool resources. Called from the
   *  renderer's `destroy()`. */
  destroy(): void {
    destroyTrackedTexture(this.pingTex);
    destroyTrackedTexture(this.pongTex);
    destroyTrackedTexture(this.groupPingTex);
    destroyTrackedTexture(this.groupPongTex);
    for (const slot of this.compositeBufferPool) {
      slot.unif.destroy();
      slot.pos.destroy();
    }
    this.compositeBufferPool = [];
  }
}
