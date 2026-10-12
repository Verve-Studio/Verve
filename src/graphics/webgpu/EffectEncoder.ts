import { effectRegistry } from "@/core/effects";
import type { EffectRenderOp, SourceLayer } from "./types";
import { EffectRuntime } from "./EffectRuntime";

// Re-export the binding kind + pair types so legacy imports keep working.
export type { AdjBinding, EffectPipelinePair } from "./EffectRuntime";
export { STD_BINDINGS } from "./EffectRuntime";

/**
 * Owns adjustment / effect / filter render+compute pipelines via a single
 * shared `EffectRuntime`. Delegates per-effect work to `effectRegistry`. Each
 * effect implementation owns its own pipeline construction (via
 * `runtime.getRenderPipelinePair` etc.) and any cross-frame texture caches it
 * needs.
 */
export class EffectEncoder {
  readonly runtime: EffectRuntime;

  constructor(
    device: GPUDevice,
    pixelWidth: number,
    pixelHeight: number,
    intermediateFormat: GPUTextureFormat = "rgba8unorm",
  ) {
    this.runtime = new EffectRuntime(
      device,
      pixelWidth,
      pixelHeight,
      intermediateFormat,
    );
  }

  /** Renders a source layer with its mask and effects into a canvas-sized
   *  texture valid for the rest of the encode. Installed by the render plan
   *  executor; without it, sources read as their raw pixels. */
  sourceRenderer: ((encoder: GPUCommandEncoder, source: SourceLayer) => GPUTexture) | null =
    null;

  /** The texture an effect binds for another layer it reads, and where its
   *  top-left sits on the canvas. */
  renderSource(
    encoder: GPUCommandEncoder,
    source: SourceLayer,
  ): { texture: GPUTexture; offsetX: number; offsetY: number } {
    if (this.sourceRenderer && (source.mask || source.adjustments.some((op) => op.visible))) {
      return { texture: this.sourceRenderer(encoder, source), offsetX: 0, offsetY: 0 };
    }
    const l = source.layer;
    return { texture: l.texture, offsetX: l.offsetX, offsetY: l.offsetY };
  }

  get pixelWidth(): number {
    return this.runtime.pixelWidth;
  }
  get pixelHeight(): number {
    return this.runtime.pixelHeight;
  }

  /**
   * Encode a single adjustment op into the provided command encoder.
   * Replaces the former `WebGPURenderer.encodeAdjustmentOp`.
   * `format` must match the format of dstTex so the correct pipeline variant is selected.
   */
  encode(
    encoder: GPUCommandEncoder,
    entry: EffectRenderOp,
    srcTex: GPUTexture,
    dstTex: GPUTexture,
    format: GPUTextureFormat,
  ): void {
    const effect = effectRegistry.get(entry.kind);
    if (!effect) {
      throw new Error(
        `[EffectEncoder.encode] no effect registered for kind=${entry.kind}`,
      );
    }
    effect.encode({ encoder, srcTex, dstTex, format, engine: this }, entry);
  }

  /** Destroy per-frame GPU buffers/textures accumulated during encode calls. Call after queue.submit(). */
  flushPendingDestroys(): void {
    this.runtime.flushPendingDestroys();
  }

  /**
   * Release any per-effect texture caches that weren't touched during the
   * frame just submitted. Each effect's `onFrameEnd` performs its own
   * eviction logic against the per-frame "used" flag/set it owns.
   */
  endFrame(): void {
    for (const effect of effectRegistry.all()) {
      effect.onFrameEnd?.();
    }
  }

  /** Destroy all persistent GPU resources owned by registered effects. */
  destroy(): void {
    for (const effect of effectRegistry.all()) {
      effect.onDestroy?.();
    }
    this.runtime.destroy();
  }
}
