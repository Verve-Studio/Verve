import type { GpuDevice } from "../device/GpuDevice";
import type { ResourceCache } from "../resources/ResourceCache";
import type { PixelFormat } from "@/types";
import { displayStore, OPERATOR_SHADER_ID } from "@/ux/main/Canvas/displayStore";
import { ensureLutOnGpu } from "@/core/lut/lutGpu";
import { lutStore } from "@/core/lut/lutStore";

/**
 * Owns the swap-chain presentation primitives: checkerboard background, HDR
 * tone-mapped blit, and viewport scissoring. The renderer hands the presenter
 * a finished composite texture; the presenter writes it to the canvas backing
 * with the current exposure / tone-mapping operator / view-transform LUT.
 *
 * Architecturally separates *what* the canvas should display (renderer's job)
 * from *how* that gets onto the screen (presenter's job). `rasterizeDocument`
 * (offscreen export) deliberately does NOT use this — exports skip checker +
 * tone mapping and write to a target buffer directly.
 */
export class DisplayPresenter {
  private readonly gpu: GpuDevice;
  private readonly resources: ResourceCache;
  private readonly pixelFormat: PixelFormat;

  // 32-byte scratch ArrayBuffer reused across frames (avoids GC pressure).
  private readonly blitUnifAB = new ArrayBuffer(32);
  private readonly blitUnifView = new DataView(this.blitUnifAB);

  // ─── Viewport scissor ─────────────────────────────────────────────────────
  // When set, encodeCheckerboard and encodeBlit clip their fragment writes to
  // this rect (in swapchain backing pixels). Used at zoom > 1 where the canvas
  // backing buffer is much larger than the visible viewport.
  private viewportScissor: {
    x: number;
    y: number;
    w: number;
    h: number;
  } | null = null;

  /** Set when the viewport scissor changes since the last successful render.
   *  The caller (renderer) must re-blit so the newly-visible portion of the
   *  backing receives valid pixels — but it does NOT need to re-composite any
   *  layers. The flag is read+cleared by the renderer's renderPlan. */
  viewportDirty = false;

  constructor(gpu: GpuDevice, resources: ResourceCache, pixelFormat: PixelFormat) {
    this.gpu = gpu;
    this.resources = resources;
    this.pixelFormat = pixelFormat;
  }

  /** Restrict checker + blit fragment writes to this rect in backing pixels.
   *  Pass null to disable. Returns true if the rect actually changed. */
  setViewportScissor(
    rect: { x: number; y: number; w: number; h: number } | null,
  ): boolean {
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
    if (same) return false;
    this.viewportScissor = rect;
    this.viewportDirty = true;
    return true;
  }

  /** Explicitly mark the viewport rect dirty (e.g. canvas resize). */
  markViewportDirty(): void {
    this.viewportDirty = true;
  }

  /** True iff a viewport scissor is active. */
  get hasScissor(): boolean {
    return this.viewportScissor !== null;
  }

  /**
   * Present a composite texture to the swap chain: clear with checker, blit
   * src on top with tone mapping. Used by the renderer's `renderPlan` for
   * both the incremental and full code paths.
   */
  presentToScreen(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    screenView: GPUTextureView,
  ): void {
    this.encodeCheckerboard(encoder, screenView);
    this.encodeBlit(encoder, srcTex, screenView);
  }

  /**
   * Same as {@link presentToScreen} but with the viewport scissor temporarily
   * disabled — used by the navigator-thumbnail mirror path that needs the
   * full backing buffer to hold valid pixels regardless of which subrect is
   * actually visible.
   */
  presentToScreenNoScissor(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    screenView: GPUTextureView,
  ): void {
    const prev = this.viewportScissor;
    this.viewportScissor = null;
    try {
      this.encodeCheckerboard(encoder, screenView);
      this.encodeBlit(encoder, srcTex, screenView);
    } finally {
      this.viewportScissor = prev;
    }
  }

  // ─── Pass encoders ────────────────────────────────────────────────────────

  /**
   * Draw the transparency checkerboard onto `view`. No bind-group rebuild —
   * uses the static checker bind group from ResourceCache. Respects
   * `viewportScissor`.
   */
  private encodeCheckerboard(
    encoder: GPUCommandEncoder,
    view: GPUTextureView,
  ): void {
    const r = this.resources;
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
    pass.setPipeline(r.checkerPipeline);
    pass.setBindGroup(0, r.checkerBindGroup);
    pass.setVertexBuffer(0, r.canvasQuadVertBuf);
    pass.setVertexBuffer(1, r.texCoordBuffer);
    if (this.viewportScissor) {
      const s = this.viewportScissor;
      pass.setScissorRect(s.x, s.y, s.w, s.h);
    }
    pass.draw(6);
    pass.end();
  }

  /**
   * Tone-map srcTex into `view`. Writes display-store-driven exposure /
   * operator / view-transform-LUT uniforms before the draw, picks the active
   * LUT texture views (or identity placeholders), and blends src-over so the
   * checker underneath shows through alpha. Honours `viewportScissor`.
   */
  private encodeBlit(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    view: GPUTextureView,
  ): void {
    const device = this.gpu.device;
    const r = this.resources;

    const exposureLinear = Math.pow(2, displayStore.exposureEV);
    const isFp32 = this.pixelFormat === "rgba32f" ? 1.0 : 0.0;
    const operatorId =
      OPERATOR_SHADER_ID[displayStore.toneMappingOperator] ?? 1;

    const viewLut = displayStore.viewTransformLutId
      ? lutStore.get(displayStore.viewTransformLutId)
      : undefined;
    const viewBundle = viewLut ? ensureLutOnGpu(device, viewLut) : null;

    const tmView = this.blitUnifView;
    tmView.setFloat32(0, exposureLinear, true);
    tmView.setFloat32(4, isFp32, true);
    tmView.setUint32(8, operatorId, true);
    tmView.setUint32(12, viewBundle ? 1 : 0, true);
    tmView.setFloat32(16, viewBundle ? viewBundle.cubeSize : 1, true);
    tmView.setUint32(20, viewLut?.inputSpace === "srgb" ? 0 : 1, true);
    tmView.setUint32(24, viewLut?.outputSpace === "srgb" ? 0 : 1, true);
    tmView.setUint32(28, viewBundle?.hasShaper ? 1 : 0, true);
    device.queue.writeBuffer(r.hdrUniformBuffer, 0, this.blitUnifAB);

    const lutCubeView = viewBundle?.cubeView ?? r.identityLutCubeView;
    const lutShaperView = viewBundle?.shaperView ?? r.identityLutShaperView;

    const bindGroup = device.createBindGroup({
      layout: r.hdrBlitBGL,
      entries: [
        // `screenBlitSampler`: bilinear when downscaling (zoom < 1)
        // → smooth overview, crisp nearest when upscaling (zoom ≥ 1)
        // → pixel-perfect paint view. See ResourceCache for the why.
        { binding: 0, resource: r.screenBlitSampler },
        { binding: 1, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: r.frameUniformBuf } },
        { binding: 3, resource: { buffer: r.hdrUniformBuffer } },
        { binding: 4, resource: lutCubeView },
        { binding: 5, resource: lutShaperView },
        { binding: 6, resource: r.lutBlitSampler },
      ],
    });

    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: "load", storeOp: "store" }],
    });
    pass.setPipeline(r.hdrBlitPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, r.canvasQuadVertBuf);
    pass.setVertexBuffer(1, r.texCoordBuffer);
    if (this.viewportScissor) {
      const s = this.viewportScissor;
      pass.setScissorRect(s.x, s.y, s.w, s.h);
    }
    pass.draw(6);
    pass.end();
  }
}
