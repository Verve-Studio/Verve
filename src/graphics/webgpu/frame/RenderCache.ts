import { destroyTrackedTexture } from "@/core/store/memoryStore";

/**
 * Per-frame render caches owned by the executor. Each cache is keyed by layer
 * id; entries are evicted via {@link disposeFor} when a layer is destroyed.
 *
 * Design rule: the executor reads cache entries on every frame and writes them
 * after a successful re-encode. The cache itself has no encoding logic — it's
 * pure storage with eviction.
 */

interface AdjGroupEntry {
  baseContentVersion: number;
  offsetX: number;
  offsetY: number;
  baseMaskVersion: number; // -1 when there is no base mask
  baseMaskOffsetX: number;
  baseMaskOffsetY: number;
  paramsKey: string;
  tex: GPUTexture;
  lastEncodeTime: number;
}

interface StandaloneOpEntry {
  inputFp: string;
  paramsKey: string;
  tex: GPUTexture;
  lastEncodeTime: number;
}

interface CompositeLayerEntry {
  childFp: string;
  adjKey: string;
  tex: GPUTexture;
}

interface RenderedOffset {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class RenderCache {
  /** Per-adjustment-group output. Skip re-running adjustment passes when the
   *  base layer's pixel content, position, mask, and params are all unchanged.
   *  Key = parentLayerId. Used during screen-preview renderPlan() calls. */
  readonly adjGroup = new Map<string, AdjGroupEntry>();

  /** Permanent baked output for locked layers. Once a locked layer's
   *  adjustment group is computed once, the result is stored here and reused
   *  with zero GPU compute. Evicted when the layer is unlocked or destroyed.
   *  Key = parentLayerId. */
  readonly bakedLocked = new Map<string, GPUTexture>();

  /** Per standalone EffectRenderOp output cache. Hits when accumulated input +
   *  op params are both unchanged. Key = op.layerId. */
  readonly standaloneOp = new Map<string, StandaloneOpEntry>();

  /** Per composite-layer output cache (final flattened+adjusted result tex).
   *  Hits when all child contentVersions, offsets, and adjustment params
   *  match the previous frame. Key = layerId. */
  readonly compositeLayer = new Map<string, CompositeLayerEntry>();

  /** Offsets and bounds of every layer/adjustment-group as of the last
   *  successful renderPlan(). Used to synthesize a drag-induced dirty rect
   *  when a layer's offset changed without a flush. Key = layer id. */
  readonly lastRenderedOffsets = new Map<string, RenderedOffset>();

  /** Drop every cache entry attached to a destroyed layer. Idempotent. */
  disposeFor(layerId: string): void {
    const adj = this.adjGroup.get(layerId);
    if (adj) {
      destroyTrackedTexture(adj.tex);
      this.adjGroup.delete(layerId);
    }
    const baked = this.bakedLocked.get(layerId);
    if (baked) {
      destroyTrackedTexture(baked);
      this.bakedLocked.delete(layerId);
    }
    const so = this.standaloneOp.get(layerId);
    if (so) {
      destroyTrackedTexture(so.tex);
      this.standaloneOp.delete(layerId);
    }
    const cl = this.compositeLayer.get(layerId);
    if (cl) {
      destroyTrackedTexture(cl.tex);
      this.compositeLayer.delete(layerId);
    }
    this.lastRenderedOffsets.delete(layerId);
  }
}
