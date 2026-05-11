/**
 * Owns the canvas render RAF loop, the viewport scissor calculation, and
 * the thumbnail-mirror snapshotting pipeline.
 *
 * Returns a `doRender()` callback and a `doRenderRef` that always points at
 * the latest closure. Subscriptions outside React state (renderer's
 * refresh-callback, scroll handler, HDR display store, adjustment preview,
 * …) call through `doRenderRef.current()` so they pick up new state on
 * every render without re-subscribing.
 *
 * The two heavy mechanics living here:
 *   1. **RAF coalescing.** Multiple `doRender()` calls within a frame
 *      collapse to a single requestAnimationFrame. A 1000 Hz mouse drag
 *      otherwise issues ~1000 renderPlan() calls/sec; each creates
 *      GPUBindGroups/Views/CommandBuffers that rely on GC for cleanup.
 *   2. **Mirror update flight control.** At most one
 *      `createImageBitmap` in flight at a time; trailing-edge timer caps
 *      it at 2 fps (MIRROR_MIN_INTERVAL_MS). Without flight control the
 *      bitmap snapshots queue up faster than they resolve on high-Hz
 *      drags, growing visible memory.
 */
import { useEffect, useRef } from "react";
import type {
  RenderPlanEntry,
  WebGPURenderer,
} from "@/graphics/webgpu/rendering/WebGPURenderer";

const MIRROR_MIN_INTERVAL_MS = 500; // 2 fps cap on the navigator/thumbnail repaint.

export interface CanvasRenderLoopParams {
  rendererRef: React.RefObject<WebGPURenderer | null>;
  rendererVersion: number;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  tiledCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  thumbnailCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Document pixel size. Used by the tiled-mode 3×3 blit. */
  width: number;
  height: number;
  /** Snapshotted thumbnail dimensions (capped at MIRROR_MAX_DIM). */
  mirrorW: number;
  mirrorH: number;
  /** Document backing-buffer size — when these change we treat the
   *  swapchain as freshly reallocated and force a render. */
  backingW: number;
  backingH: number;
  tiledMode: boolean;
  showTileGrid: boolean;
  isActive: boolean;
  /** Plan builder closure. Re-built each render in Canvas — captured here
   *  as a ref so doRender always invokes the freshest plan. */
  buildRenderPlanRef: React.RefObject<() => RenderPlanEntry[]>;
}

export interface CanvasRenderLoopApi {
  /** Schedule a render on the next animation frame. Multiple calls within
   *  the same frame coalesce. */
  doRender: () => void;
  /** Ref to the latest `doRender` closure. Subscriptions (HDR display,
   *  adjustment preview, viewport scroll, renderer refresh callback) should
   *  invoke `doRenderRef.current()` so the closure they call is always the
   *  current one. */
  doRenderRef: React.RefObject<() => void>;
}

/** Visible portion of the canvas backing buffer in backing-pixel coords.
 *  Returns null when the whole backing is on-screen (no scissor needed) or
 *  in tiled mode (we read the full backing for the 9-tile blit). */
function computeViewportScissor(
  canvas: HTMLCanvasElement | null,
  vp: HTMLDivElement | null,
  tiledMode: boolean,
): { x: number; y: number; w: number; h: number } | null {
  if (tiledMode) return null;
  if (!canvas || !vp) return null;
  const cRect = canvas.getBoundingClientRect();
  const vRect = vp.getBoundingClientRect();
  if (cRect.width <= 0 || cRect.height <= 0) return null;
  // Visible CSS rect of the canvas inside the viewport.
  const visLeft = Math.max(cRect.left, vRect.left);
  const visTop = Math.max(cRect.top, vRect.top);
  const visRight = Math.min(cRect.right, vRect.right);
  const visBottom = Math.min(cRect.bottom, vRect.bottom);
  const cssVisW = visRight - visLeft;
  const cssVisH = visBottom - visTop;
  if (cssVisW <= 0 || cssVisH <= 0) return null;
  // Convert CSS visible rect to backing-pixel coords.
  const sx = canvas.width / cRect.width;
  const sy = canvas.height / cRect.height;
  let x = Math.floor((visLeft - cRect.left) * sx);
  let y = Math.floor((visTop - cRect.top) * sy);
  let w = Math.ceil(cssVisW * sx);
  let h = Math.ceil(cssVisH * sy);
  x = Math.max(0, Math.min(canvas.width - 1, x));
  y = Math.max(0, Math.min(canvas.height - 1, y));
  w = Math.max(1, Math.min(canvas.width - x, w));
  h = Math.max(1, Math.min(canvas.height - y, h));
  if (x === 0 && y === 0 && w === canvas.width && h === canvas.height)
    return null;
  return { x, y, w, h };
}

export function useCanvasRenderLoop(
  params: CanvasRenderLoopParams,
): CanvasRenderLoopApi {
  const {
    rendererRef,
    rendererVersion,
    canvasRef,
    viewportRef,
    tiledCanvasRef,
    thumbnailCanvasRef,
    width,
    height,
    mirrorW,
    mirrorH,
    backingW,
    backingH,
    tiledMode,
    showTileGrid,
    isActive,
    buildRenderPlanRef,
  } = params;

  // ── Mirror flight-control state ───────────────────────────────────────────
  const mirrorBitmapInFlightRef = useRef(false);
  const mirrorBitmapPendingRef = useRef(false);
  const mirrorLastUpdateMsRef = useRef(0);
  const mirrorTrailingTimeoutRef = useRef<number | null>(null);
  // False after a canvas backing resize until at least one renderPlan has
  // submitted to the new swapchain. Reading the swapchain before then
  // sees uninitialized memory → black mirror + GL_INVALID_OPERATION.
  const mirrorReadyRef = useRef(false);

  const renderRafIdRef = useRef<number>(0);
  const doRenderRef = useRef<() => void>(() => {});

  /** Snapshot the GPU canvas into the mirror canvas. Flight-controlled and
   *  rate-limited; safe to call freely. */
  const scheduleMirrorUpdate = (): void => {
    const gpuCanvas = canvasRef.current;
    const mirror = thumbnailCanvasRef.current;
    if (!gpuCanvas || !mirror) return;
    if (!mirrorReadyRef.current) {
      mirrorBitmapPendingRef.current = true;
      return;
    }
    if (mirrorBitmapInFlightRef.current) {
      // Coalesce: a snapshot is already in flight; mark that we owe one
      // more update once it resolves.
      mirrorBitmapPendingRef.current = true;
      return;
    }
    const now = performance.now();
    const dueIn =
      MIRROR_MIN_INTERVAL_MS - (now - mirrorLastUpdateMsRef.current);
    if (dueIn > 0) {
      if (mirrorTrailingTimeoutRef.current === null) {
        mirrorTrailingTimeoutRef.current = window.setTimeout(() => {
          mirrorTrailingTimeoutRef.current = null;
          scheduleMirrorUpdate();
        }, dueIn);
      }
      return;
    }
    mirrorLastUpdateMsRef.current = now;
    mirrorBitmapInFlightRef.current = true;
    // The screen blit is scissored to the visible viewport; outside that rect
    // the swapchain holds stale pixels. Re-blit the full stableTex to the
    // swapchain (no scissor) so createImageBitmap captures the full canvas.
    rendererRef.current?.repaintScreenNoScissor();
    const captureW = gpuCanvas.width;
    const captureH = gpuCanvas.height;
    createImageBitmap(gpuCanvas, 0, 0, captureW, captureH, {
      resizeWidth: mirrorW,
      resizeHeight: mirrorH,
      resizeQuality: "medium",
    })
      .then((bitmap) => {
        const m = thumbnailCanvasRef.current;
        const c = canvasRef.current;
        // Skip if the backing was resized between submit and resolve —
        // the bitmap reflects an obsolete buffer state.
        if (m && c && c.width === captureW && c.height === captureH) {
          const ctx = m.getContext("2d");
          ctx?.clearRect(0, 0, m.width, m.height);
          ctx?.drawImage(bitmap, 0, 0);
        } else {
          mirrorBitmapPendingRef.current = true;
        }
        bitmap.close();
      })
      .catch(() => {
        /* not yet presented */
      })
      .finally(() => {
        mirrorBitmapInFlightRef.current = false;
        if (mirrorBitmapPendingRef.current) {
          mirrorBitmapPendingRef.current = false;
          scheduleMirrorUpdate();
        }
      });
  };

  /** The actual render entry point. Coalesces to one RAF per frame. */
  const doRender = (): void => {
    if (renderRafIdRef.current !== 0) return; // already scheduled for this frame
    renderRafIdRef.current = requestAnimationFrame(() => {
      renderRafIdRef.current = 0;
      const renderer = rendererRef.current;
      if (!renderer) return;
      // Scissor the screen blit + checker pass to the actually-visible
      // portion of the canvas backing buffer. At zoom > 1 the backing is
      // full-document size but only a small slice is on-screen — without
      // this scissor we'd write the entire backing every frame (e.g.
      // 278 MB at 7000×9933) only for the compositor to clip most of it.
      renderer.setViewportScissor(
        computeViewportScissor(canvasRef.current, viewportRef.current, tiledMode),
      );
      const renderResult = renderer.renderPlan(buildRenderPlanRef.current());
      // A render has been submitted to the current swapchain; the mirror
      // path can now safely createImageBitmap.
      mirrorReadyRef.current = true;

      // Tiled mode: blit GPU canvas 9 times into the 2D overlay canvas. We
      // scope the copy to whatever sub-rect the renderer just changed
      // (often a tiny brush stamp) instead of redrawing 9× the full
      // canvas every frame.
      if (tiledMode && renderResult.kind !== "noop") {
        const tc = tiledCanvasRef.current;
        const gc = canvasRef.current;
        if (tc && gc) {
          const ctx2d = tc.getContext("2d");
          if (ctx2d) {
            const isFull = renderResult.kind === "full";
            const r = isFull
              ? { x: 0, y: 0, w: width, h: height }
              : renderResult.rect;
            if (isFull) {
              ctx2d.clearRect(0, 0, tc.width, tc.height);
            }
            for (let row = 0; row < 3; row++) {
              for (let col = 0; col < 3; col++) {
                const dx = col * width + r.x;
                const dy = row * height + r.y;
                if (!isFull) ctx2d.clearRect(dx, dy, r.w, r.h);
                ctx2d.drawImage(gc, r.x, r.y, r.w, r.h, dx, dy, r.w, r.h);
              }
            }
            if (showTileGrid) {
              ctx2d.strokeStyle = "rgba(0, 220, 200, 0.55)";
              ctx2d.lineWidth = 0.75;
              ctx2d.beginPath();
              ctx2d.moveTo(width, 0);
              ctx2d.lineTo(width, 3 * height);
              ctx2d.moveTo(2 * width, 0);
              ctx2d.lineTo(2 * width, 3 * height);
              ctx2d.moveTo(0, height);
              ctx2d.lineTo(3 * width, height);
              ctx2d.moveTo(0, 2 * height);
              ctx2d.lineTo(3 * width, 2 * height);
              ctx2d.stroke();
            }
          }
        }
      }
      scheduleMirrorUpdate();
    });
  };

  // Keep the ref current every render so subscribers always call the latest
  // closure. (Critical: doRender closes over `tiledMode`, `width`, etc.)
  doRenderRef.current = doRender;

  // ── Wire the renderer's effect-recompute throttle ─────────────────────────
  // When an adjustment / effect cache is reused mid-stroke (instead of being
  // recomputed), the renderer needs a way to re-trigger a render after the
  // throttle window so the user sees the updated output even if no further
  // input events arrive.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setRefreshCallback(() => doRenderRef.current());
    return () => {
      renderer.setRefreshCallback(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendererVersion]);

  // ── Backing-buffer resize ─────────────────────────────────────────────────
  // When the canvas backing buffer is resized (zoom crosses a threshold), the
  // WebGPU swapchain texture is reallocated and contains undefined pixels.
  // Block any in-flight or pending mirror update from reading the new
  // uninitialized swapchain; doRender re-arms `mirrorReadyRef`.
  useEffect(() => {
    if (!isActive) return;
    mirrorReadyRef.current = false;
    if (mirrorTrailingTimeoutRef.current !== null) {
      clearTimeout(mirrorTrailingTimeoutRef.current);
      mirrorTrailingTimeoutRef.current = null;
    }
    rendererRef.current?.markViewportDirty();
    doRenderRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backingW, backingH, isActive]);

  return { doRender, doRenderRef };
}
