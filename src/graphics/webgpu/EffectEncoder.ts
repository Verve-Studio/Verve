import { effectRegistry } from "@/core/effects";
import type { EffectRenderOp } from "./types";
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
