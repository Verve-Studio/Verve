import React, {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useWebGPU } from "@/core/services/useWebGPU";
import { useCanvas } from "@/core/services/useCanvas";
import { useAppContext } from "@/core/store/AppContext";
import { useCanvasContext } from "@/core/store/CanvasContext";
import type {
  GpuLayer,
  RenderPlanEntry,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import type {
  TextLayerState,
  ShapeLayerState,
  FrameLayerState,
  MaskLayerState,
} from "@/types";
import { TOOL_REGISTRY } from "@/tools";
import type { ToolContext, ToolHandler } from "@/tools";
import { brushOptions } from "@/tools/Brush/Brush";
import {
  pencilOptions,
  getPencilBrushPreviewDataUrl,
  getPencilShapePreviewDataUrl,
} from "@/tools/Pencil/Pencil";
import { eraserOptions } from "@/tools/Eraser/Eraser";
import { liquifyOptions } from "@/tools/Liquify/Liquify";
import { blurOptions } from "@/tools/Blur/Blur";
import { sharpenOptions } from "@/tools/Sharpen/Sharpen";
import { smudgeOptions } from "@/tools/Smudge/Smudge";
import { healingBrushOptions } from "@/tools/HealingBrush/HealingBrush";
import { quickSelectOptions } from "@/tools/QuickSelect/QuickSelect";
import { cloneStampOptions } from "@/tools/CloneStamp/CloneStamp";
import { dodgeOptions, burnOptions } from "@/tools/Dodge/Dodge";
import { cloneStampStore } from "@/core/store/cloneStampStore";
import { drawCloneStampOverlay } from "./cloneStampOverlay";
import { polygonalSelectionStore } from "@/core/store/polygonalSelectionStore";
import { objectSelectionStore } from "@/core/store/objectSelectionStore";
import { selectionStore } from "@/core/store/selectionStore";
import { measureStore } from "@/core/store/measureStore";
import { cursorStore } from "@/core/store/cursorStore";
import { transformStore } from "@/core/store/transformStore";
import { drawTransformOverlay } from "@/tools/Transform/Transform";
import { TextLayerEditor } from "./TextLayerEditor";
import { rasterizeTextToLayer } from "./textRasterizer";
import { rasterizeShapeToLayer } from "./shapeRasterizer";
import {
  rasterizeFrameToLayer,
  ensureContentDecoded,
} from "./frameRasterizer";
import { resolveNearestPaletteIndex } from "@/utils/indexedColorUtils";
import { decodePng } from "./pngHelpers";
import { useCanvasHandle } from "./canvasHandle";
import type { CanvasHandle } from "./canvasHandle";
import { buildRenderPlan as buildCanvasRenderPlan } from "./canvasPlan";
import { useMarchingAnts } from "./useMarchingAnts";
import { useScrollZoom } from "./useScrollZoom";
import { useSpacePan } from "./useSpacePan";
import { useRulers } from "./useRulers";
import { useGuides } from "./useGuides";
import { adjustmentPreviewStore } from "@/core/store/adjustmentPreviewStore";
import { displayStore } from "@/core/store/displayStore";
import {
  f32TransferStore,
  u8TransferStore,
} from "@/core/store/layerDataTransfer";
import styles from "./Canvas.module.scss";

// Re-export so external importers (App.tsx etc.) don't need to change their paths.
export type { CanvasHandle } from "./canvasHandle";

// ─── Component ────────────────────────────────────────────────────────────────

interface CanvasProps {
  width: number;
  height: number;
  /** Per-layer base64 PNG data URLs to populate on mount (used when opening a file). */
  initialLayerData?: Map<string, string>;
  /** Called with the tool label after a pixel-modifying stroke completes. */
  onStrokeEnd?: (label: string) => void;
  /** Called once after the canvas has finished its first initialization render. */
  onReady?: () => void;
  /** When false the canvas is hidden and all interactive effects are suspended. Default true. */
  isActive?: boolean;
}

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(function Canvas(
  { width, height, initialLayerData, onStrokeEnd, onReady, isActive = true },
  ref,
) {
  const { state, dispatch } = useAppContext();
  const { canvasElRef, thumbnailCanvasRef } = useCanvasContext();
  const { canvasRef, rendererRef, rendererVersion } = useWebGPU({
    pixelWidth: width,
    pixelHeight: height,
    pixelFormat: state.pixelFormat,
  });

  const glLayersRef = useRef<Map<string, GpuLayer>>(new Map());
  const adjustmentMaskMap = useRef<Map<string, GpuLayer>>(new Map());
  const toolHandlerRef = useRef<ToolHandler>(
    TOOL_REGISTRY[state.activeTool].createHandler(),
  );
  const hasInitializedRef = useRef(false);
  // Track isActive in a ref so async init can read the current value
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  // Saved scroll position, restored when the canvas becomes active again
  const scrollPosRef = useRef({ left: 0, top: 0 });
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const toolOverlayRef = useRef<HTMLCanvasElement>(null);
  const tiledCanvasRef = useRef<HTMLCanvasElement>(null);
  const brushCursorRef = useRef<HTMLDivElement>(null);
  const pixelBrushCursorRef = useRef<HTMLDivElement>(null);
  const canvasWrapperRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const hRulerRef = useRef<HTMLCanvasElement>(null);
  const vRulerRef = useRef<HTMLCanvasElement>(null);
  const zoomRef = useRef(state.canvas.zoom);
  zoomRef.current = state.canvas.zoom;
  const activeToolRef = useRef(state.activeTool);
  activeToolRef.current = state.activeTool;
  const pendingScrollRef = useRef<{
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  // Canvas backing-buffer (swapchain) size. The HTML canvas backing buffer drives the
  // WebGPU swapchain texture size — every frame we write `backingW * backingH * 4` bytes
  // to it (checker + blit). At a 7016×9933 document that's 278 MB per frame, which is
  // the single biggest cost on the painting hot path.
  //
  // When zoom < 1 the document is being downscaled for display, so the on-screen pixel
  // count is `width * zoom`. Sizing the swapchain to that count instead of the document
  // size lets the GPU downsample once during the blit (sampling stableTex with linear
  // UV) and write only the pixels that will actually be displayed. Cost shrinks
  // proportionally to zoom².
  //
  // At zoom ≥ 1 we keep the swapchain at document resolution; the browser's compositor
  // upscales (cheap, and we want crisp pixel-doubling at integer zooms anyway).
  //
  // Tiled mode reads from the canvas backing buffer with `drawImage(gc, col*width, …)`,
  // so it requires the backing buffer at document size.
  const displayScale = state.canvas.tiledMode
    ? 1
    : Math.min(state.canvas.zoom, 1);
  const backingW = Math.max(1, Math.round(width * displayScale));
  const backingH = Math.max(1, Math.round(height * displayScale));

  // Keep a ref to the current layer list so the imperative handle can access
  // up-to-date ordering and visibility without being re-created on every render.
  const layersStateRef = useRef(state.layers);
  layersStateRef.current = state.layers;
  const swatchesRef = useRef(state.swatches);
  swatchesRef.current = state.swatches;
  const onStrokeEndRef = useRef(onStrokeEnd);
  onStrokeEndRef.current = onStrokeEnd;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // ── Inline text layer editor state ────────────────────────────
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);

  // When a pixel-modifying tool starts on a text/shape layer, this holds the
  // newly-created pixel layer so buildCtx can target it before React re-renders.
  const newPixelLayerRef = useRef<GpuLayer | null>(null);

  // ── Thumbnail mirror canvas ────────────────────────────────────
  // A plain 2D canvas kept in sync with the WebGPU output so Navigator (and any
  // other panel) can read pixel content without touching the WebGPU canvas directly
  // (which can cause GPU-process crashes in Electron when cross-context read is attempted).
  //
  // The mirror is capped at MIRROR_MAX_DIM on its longest side. createImageBitmap is called
  // with matching resizeWidth/resizeHeight so Chromium downscales in GPU memory before the
  // CPU readback — turning an 84 MB readback at 7000×3000 into ~450 KB.
  const MIRROR_MAX_DIM = 512;
  const mirrorScale = Math.min(1, MIRROR_MAX_DIM / Math.max(width, height));
  const mirrorW = Math.max(1, Math.round(width * mirrorScale));
  const mirrorH = Math.max(1, Math.round(height * mirrorScale));
  useEffect(() => {
    const mirror = document.createElement("canvas");
    mirror.width = mirrorW;
    mirror.height = mirrorH;
    // Force-allocate the 2D backing store. Navigator's RAF loop reads the
    // mirror via drawImage every frame; without this, the first reads (before
    // scheduleMirrorUpdate has populated the mirror) hit an uninitialized
    // SharedImage and Chromium logs GL_INVALID_OPERATION.
    mirror.getContext("2d")?.clearRect(0, 0, mirrorW, mirrorH);
    thumbnailCanvasRef.current = mirror;
    return () => {
      thumbnailCanvasRef.current = null;
    };
  }, [mirrorW, mirrorH, thumbnailCanvasRef]);

  // doRender: wrapper around renderPlan that also asynchronously refreshes the mirror canvas.
  // Mirror updates are flight-controlled: at most one in-flight createImageBitmap. During a
  // high-frequency drag (60–120 fps) without this, bitmap snapshots queue up faster than they
  // resolve, causing perceived memory growth from large in-flight bitmaps.
  //
  // Render calls themselves are coalesced to one-per-animation-frame. A 1000 Hz mouse drag would
  // otherwise issue ~1000 renderPlan() calls/sec, each creating GPUBindGroups, GPUTextureViews,
  // and a GPUCommandBuffer. These objects rely on GC (no destroy API) and the WebGPU driver
  // retains them until the GPU consumes the submitted command buffers — at 1000 Hz the in-flight
  // set grows faster than it drains, producing visible memory growth during sustained drags.
  const mirrorBitmapInFlightRef = useRef(false);
  const mirrorBitmapPendingRef = useRef(false);
  const mirrorLastUpdateMsRef = useRef(0);
  const mirrorTrailingTimeoutRef = useRef<number | null>(null);
  // False after a canvas backing resize until at least one renderPlan has
  // submitted to the new swapchain. Reading the swapchain (createImageBitmap)
  // before then sees an uninitialized SharedImage — produces a black mirror
  // and a Chromium GL_INVALID_OPERATION console error.
  const mirrorReadyRef = useRef(false);
  const MIRROR_MIN_INTERVAL_MS = 500; // 2 fps cap on the navigator/thumbnail repaint
  const renderRafIdRef = useRef<number>(0);
  const doRenderRef = useRef<() => void>(() => {});
  /**
   * Compute the visible portion of the canvas backing buffer in backing-pixel coords.
   * Returns null when the entire backing is visible (no scissor needed) or in tiled
   * mode (we read the full backing into the tile overlay via drawImage).
   */
  const computeViewportScissor = (): {
    x: number;
    y: number;
    w: number;
    h: number;
  } | null => {
    if (state.canvas.tiledMode) return null;
    const canvas = canvasRef.current;
    const vp = viewportRef.current;
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
    // Clamp to backing bounds.
    x = Math.max(0, Math.min(canvas.width - 1, x));
    y = Math.max(0, Math.min(canvas.height - 1, y));
    w = Math.max(1, Math.min(canvas.width - x, w));
    h = Math.max(1, Math.min(canvas.height - y, h));
    // No-op scissor when the visible rect covers the entire backing.
    if (x === 0 && y === 0 && w === canvas.width && h === canvas.height)
      return null;
    return { x, y, w, h };
  };
  const doRender = (): void => {
    if (renderRafIdRef.current !== 0) return; // already scheduled for this frame
    renderRafIdRef.current = requestAnimationFrame(() => {
      renderRafIdRef.current = 0;
      const renderer = rendererRef.current;
      if (!renderer) return;
      // Restrict the screen blit + checker pass to the actually-visible portion
      // of the canvas backing buffer. At zoom > 1 the backing is full-document
      // size but only a small slice is on-screen — without this scissor we'd
      // write the entire backing every frame (e.g. 278 MB at 7000×9933) only
      // for the browser compositor to clip most of it away.
      renderer.setViewportScissor(computeViewportScissor());
      renderer.renderPlan(buildRenderPlan());
      // A render has been submitted to the current swapchain; the mirror path
      // can now safely createImageBitmap without reading uninitialized memory.
      mirrorReadyRef.current = true;
      // Tiled mode: blit GPU canvas 9 times into the 2D overlay canvas
      if (state.canvas.tiledMode) {
        const tc = tiledCanvasRef.current;
        const gc = canvasRef.current;
        if (tc && gc) {
          const ctx2d = tc.getContext("2d");
          if (ctx2d) {
            ctx2d.clearRect(0, 0, tc.width, tc.height);
            for (let row = 0; row < 3; row++) {
              for (let col = 0; col < 3; col++) {
                ctx2d.drawImage(gc, col * width, row * height, width, height);
              }
            }
            if (state.canvas.showTileGrid) {
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
  const scheduleMirrorUpdate = (): void => {
    const gpuCanvas = canvasRef.current;
    const mirror = thumbnailCanvasRef.current;
    if (!gpuCanvas || !mirror) return;
    // Backing was just resized; the swapchain SharedImage is uninitialized
    // until the next render submits to it. Defer until then.
    if (!mirrorReadyRef.current) {
      mirrorBitmapPendingRef.current = true;
      return;
    }
    if (mirrorBitmapInFlightRef.current) {
      // Coalesce: a frame is already in flight; mark that we owe one more update once it resolves.
      mirrorBitmapPendingRef.current = true;
      return;
    }
    // 2 fps cap: if the previous update was less than MIRROR_MIN_INTERVAL_MS ago,
    // schedule a single trailing update at the rate-limit boundary instead of
    // firing now. The full repaintScreenNoScissor + GPU readback is the most
    // expensive part of the mirror path; capping it preserves a live thumbnail
    // without burning bandwidth on every paint frame.
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
    // The screen blit is scissored to the visible viewport for performance, so
    // outside that rect the canvas backing buffer holds stale pixels. Re-blit
    // the full stableTex to the swapchain (no scissor) so createImageBitmap
    // captures the entire canvas, not just the visible slice.
    rendererRef.current?.repaintScreenNoScissor();
    // Snapshot the backing dimensions at submit time. If the canvas is resized
    // before createImageBitmap resolves, the captured bitmap targets a stale
    // size and must be discarded \u2014 a fresh mirror update will be scheduled
    // by the post-render path.
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
        // Skip if the backing was resized between submit and resolve \u2014 the
        // bitmap reflects an obsolete buffer state.
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

  // ── Expose handle for save / export / clipboard ────────────────
  useCanvasHandle({
    ref,
    rendererRef,
    glLayersRef,
    adjustmentMaskMap,
    layersStateRef,
    swatchesRef,
    buildRenderArgs: () => ({
      layers: buildOrderedGLLayers(),
      maskMap: buildMaskMap(),
      plan: buildRenderPlan(),
    }),
    width,
    height,
    viewportRef,
    pendingScrollRef,
    onZoom: (zoom) => dispatch({ type: "SET_ZOOM", payload: zoom }),
    tiledMode: state.canvas.tiledMode,
    requestRender: doRender,
  });

  // ── Zoom to cursor + scroll save/restore ───────────────────────
  // When a selection is active, zoom towards its centroid (Photoshop behaviour).
  // Returns the selection centroid in image-pixel space, used by useScrollZoom
  // to keep the selection anchor stable while zooming (Ctrl+scroll and Navigator).
  const getSelectionAnchorRef = useRef<
    (() => { x: number; y: number } | null) | null
  >(null);
  getSelectionAnchorRef.current = (): { x: number; y: number } | null => {
    const mask = selectionStore.mask;
    if (!mask) return null;
    const sw = selectionStore.width;
    const sh = selectionStore.height;
    let lx = sw,
      ly = sh,
      rx = -1,
      ry = -1;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (mask[y * sw + x]) {
          if (x < lx) lx = x;
          if (x > rx) rx = x;
          if (y < ly) ly = y;
          if (y > ry) ry = y;
        }
      }
    }
    if (rx < 0) return null;
    // Return centroid in image pixels
    return { x: (lx + rx) / 2, y: (ly + ry) / 2 };
  };

  // ── Frame-clip info: drives layout + clip in animation mode ────────────
  const frameClipInfo = useMemo(() => {
    if (!state.animationMode || !state.spritesheet.enabled) return null;
    const ss = state.spritesheet;
    const cellW = Math.max(1, ss.cellWidth);
    const cellH = Math.max(1, ss.cellHeight);
    const cols = Math.max(1, Math.floor(width / cellW));
    let globalIdx = 0;
    const selectedAnim =
      ss.animations.find((a) => a.id === ss.selectedAnimationId) ??
      ss.animations[0];
    if (selectedAnim) {
      let animStart = 0;
      for (const a of ss.animations) {
        if (a.id === selectedAnim.id) break;
        animStart += a.frames.length;
      }
      if (ss.selectedFrameId) {
        const fi = selectedAnim.frames.findIndex(
          (f) => f.id === ss.selectedFrameId,
        );
        globalIdx = animStart + (fi >= 0 ? fi : 0);
      } else {
        globalIdx = animStart;
      }
    }
    const cellX = (globalIdx % cols) * cellW;
    const cellY = Math.floor(globalIdx / cols) * cellH;
    return { cellX, cellY, cellW, cellH };
  }, [
    state.animationMode,
    state.spritesheet.enabled,
    state.spritesheet.selectedAnimationId,
    state.spritesheet.selectedFrameId,
    state.spritesheet.cellWidth,
    state.spritesheet.cellHeight,
    width,
    height,
  ]);

  useScrollZoom(
    isActive,
    isActiveRef,
    viewportRef,
    zoomRef,
    pendingScrollRef,
    scrollPosRef,
    state.canvas.zoom,
    (zoom) => dispatch({ type: "SET_ZOOM", payload: zoom }),
    frameClipInfo ? frameClipInfo.cellW : width,
    frameClipInfo ? frameClipInfo.cellH : height,
    getSelectionAnchorRef,
  );

  // One-shot: center the viewport on the canvas when this tab first becomes active.
  // Runs after useScrollZoom's restore effect (declaration order) so it wins on mount.
  const centeredOnceRef = useRef(false);
  useLayoutEffect(() => {
    if (!isActive || centeredOnceRef.current) return;
    const vp = viewportRef.current;
    if (!vp) return;
    centeredOnceRef.current = true;
    const dpr = window.devicePixelRatio;
    const zoom = zoomRef.current;
    const logW = frameClipInfo ? frameClipInfo.cellW : width;
    const logH = frameClipInfo ? frameClipInfo.cellH : height;
    const padW = (logW * zoom) / dpr;
    const padH = (logH * zoom) / dpr;
    // padding = padW (left/right) + padH (top/bottom); logical-canvas centre at 1.5×pad
    const left = padW + padW / 2 - vp.clientWidth / 2;
    const top = padH + padH / 2 - vp.clientHeight / 2;
    vp.scrollLeft = Math.max(0, left);
    vp.scrollTop = Math.max(0, top);
    scrollPosRef.current = { left: vp.scrollLeft, top: vp.scrollTop };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Init selection store dimensions once canvas is sized
  useEffect(() => {
    if (!isActive) return;
    selectionStore.setDimensions(width, height);
    return () => {
      selectionStore.clear();
      measureStore.clear();
    };
  }, [width, height, isActive]);

  // ── Animation mode: fit viewport to the selected frame cell ────────────
  // Layout already clips to the cell via clip-path + offset canvasWrapper.
  // This effect only needs to pick a good zoom and centre the scroll.
  useEffect(() => {
    if (!isActive || !frameClipInfo) return;
    const { cellW, cellH } = frameClipInfo;
    const vp = viewportRef.current;
    if (!vp) return;
    const dpr = window.devicePixelRatio || 1;
    const newZoom = parseFloat(
      Math.max(
        0.05,
        Math.min(
          32,
          Math.min(
            (vp.clientWidth / (cellW / dpr)) * 0.95,
            (vp.clientHeight / (cellH / dpr)) * 0.95,
          ),
        ),
      ).toFixed(4),
    );
    dispatch({ type: "SET_ZOOM", payload: newZoom });
    requestAnimationFrame(() => {
      const vp2 = viewportRef.current;
      if (!vp2) return;
      const z = newZoom;
      // padding = cellW*z/dpr on each side; centre scroll centres the cell
      const scrollLeft = Math.max(
        0,
        (cellW * z) / dpr + ((cellW / 2) * z) / dpr - vp2.clientWidth / 2,
      );
      const scrollTop = Math.max(
        0,
        (cellH * z) / dpr + ((cellH / 2) * z) / dpr - vp2.clientHeight / 2,
      );
      vp2.scrollLeft = scrollLeft;
      vp2.scrollTop = scrollTop;
      scrollPosRef.current = { left: scrollLeft, top: scrollTop };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, frameClipInfo]);

  // ── Marching ants + crop overlay + polygonal selection overlay ──
  useMarchingAnts(
    isActive,
    overlayRef,
    viewportRef,
    canvasWrapperRef,
    zoomRef,
    activeToolRef,
  );
  useSpacePan(isActive, viewportRef);
  useRulers({
    showRulers: state.canvas.showRulers,
    hRulerRef,
    vRulerRef,
    viewportRef,
    canvasWrapperRef,
    zoom: state.canvas.zoom,
  });
  const { dragPreview, startGuideDrag } = useGuides({
    dispatch,
    showRulers: state.canvas.showRulers,
    showGuides: state.canvas.showGuides,
    zoom: state.canvas.zoom,
    hRulerRef,
    vRulerRef,
    canvasWrapperRef,
  });

  // Publish canvas element into shared context (active canvas only)
  useEffect(() => {
    if (!isActive) return;
    canvasElRef.current = canvasRef.current;
  });

  // Initialize all layers once renderer is ready — runs once per mount
  useEffect(() => {
    if (hasInitializedRef.current) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (!state.layers.length) return;
    hasInitializedRef.current = true;
    let cancelled = false;
    const isStale = (): boolean =>
      cancelled || rendererRef.current !== renderer;

    const init = async (): Promise<void> => {
      if (isStale()) return;
      const { pixelWidth: cw, pixelHeight: ch } = renderer;
      for (let i = 0; i < state.layers.length; i++) {
        const ls = state.layers[i];

        if ("type" in ls && ls.type === "adjustment") {
          const maskData = initialLayerData?.get(`${ls.id}:adjustment-mask`);
          if (maskData) {
            const maskLayer = renderer.createLayer(
              `${ls.id}:adjustment-mask`,
              `${ls.name} Mask`,
              cw,
              ch,
              0,
              0,
            );
            if (maskData.startsWith("data:raw/rgba8-ref;id=")) {
              const u8 = u8TransferStore.take(
                maskData.slice("data:raw/rgba8-ref;id=".length),
              );
              if (u8) maskLayer.data.set(u8);
              renderer.flushLayer(maskLayer);
              adjustmentMaskMap.current.set(ls.id, maskLayer);
            } else {
              try {
                const rgba = await decodePng(maskData, cw, ch);
                if (isStale()) return;
                maskLayer.data.set(rgba);
                renderer.flushLayer(maskLayer);
                adjustmentMaskMap.current.set(ls.id, maskLayer);
              } catch (e) {
                renderer.destroyLayer(maskLayer);
                console.error(
                  "[Canvas] Failed to load adjustment mask PNG:",
                  e,
                );
              }
            }
          }
          continue;
        }

        let layer;
        const imageData = initialLayerData?.get(ls.id);
        if (!("type" in ls) && !imageData) {
          const prev = glLayersRef.current.get(ls.id);
          if (prev) {
            layer = renderer.createLayer(
              ls.id,
              ls.name,
              prev.layerWidth,
              prev.layerHeight,
              prev.offsetX,
              prev.offsetY,
            );
            layer.data.set(prev.data);
          }
        }
        if (imageData) {
          // ── Opening a file: imageData may be layer-local, canvas-size, or a raw typed-array blob.
          const geoKey = `${ls.id}:geo`;
          const geoJson = initialLayerData?.get(geoKey);

          if (imageData.startsWith("data:raw/f32-ref;id=")) {
            // rgba32f layer via in-process transfer store (no base64 roundtrip)
            const refId = imageData.slice("data:raw/f32-ref;id=".length);
            const f32 = f32TransferStore.take(refId);
            if (geoJson) {
              const geo = JSON.parse(geoJson) as {
                layerWidth: number;
                layerHeight: number;
                offsetX: number;
                offsetY: number;
              };
              layer = renderer.createLayer(
                ls.id,
                ls.name,
                geo.layerWidth,
                geo.layerHeight,
                geo.offsetX,
                geo.offsetY,
                "rgba32f",
              );
            } else {
              layer = renderer.createLayer(
                ls.id,
                ls.name,
                cw,
                ch,
                0,
                0,
                "rgba32f",
              );
            }
            if (f32) (layer.data as Float32Array).set(f32);
          } else if (imageData.startsWith("data:raw/rgba8-ref;id=")) {
            // rgba8 layer via in-process transfer store (no PNG encode/decode roundtrip)
            const refId = imageData.slice("data:raw/rgba8-ref;id=".length);
            const u8 = u8TransferStore.take(refId);
            if (geoJson) {
              const geo = JSON.parse(geoJson) as {
                layerWidth: number;
                layerHeight: number;
                offsetX: number;
                offsetY: number;
              };
              layer = renderer.createLayer(
                ls.id,
                ls.name,
                geo.layerWidth,
                geo.layerHeight,
                geo.offsetX,
                geo.offsetY,
                "rgba8",
              );
            } else {
              layer = renderer.createLayer(
                ls.id,
                ls.name,
                cw,
                ch,
                0,
                0,
                "rgba8",
              );
            }
            if (u8) layer.data.set(u8);
          } else if (imageData.startsWith("data:raw/f32;base64,")) {
            // rgba32f layer: base64-encoded raw Float32Array bytes (file open path)
            const b64 = imageData.slice("data:raw/f32;base64,".length);
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const f32 = new Float32Array(bytes.buffer);
            if (geoJson) {
              const geo = JSON.parse(geoJson) as {
                layerWidth: number;
                layerHeight: number;
                offsetX: number;
                offsetY: number;
              };
              layer = renderer.createLayer(
                ls.id,
                ls.name,
                geo.layerWidth,
                geo.layerHeight,
                geo.offsetX,
                geo.offsetY,
                "rgba32f",
              );
            } else {
              layer = renderer.createLayer(
                ls.id,
                ls.name,
                cw,
                ch,
                0,
                0,
                "rgba32f",
              );
            }
            (layer.data as Float32Array).set(f32);
          } else if (imageData.startsWith("data:raw/indexed8;base64,")) {
            // indexed8 layer: base64-encoded raw palette-index bytes
            const b64 = imageData.slice("data:raw/indexed8;base64,".length);
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            if (geoJson) {
              const geo = JSON.parse(geoJson) as {
                layerWidth: number;
                layerHeight: number;
                offsetX: number;
                offsetY: number;
              };
              layer = renderer.createLayer(
                ls.id,
                ls.name,
                geo.layerWidth,
                geo.layerHeight,
                geo.offsetX,
                geo.offsetY,
                "indexed8",
              );
            } else {
              layer = renderer.createLayer(
                ls.id,
                ls.name,
                cw,
                ch,
                0,
                0,
                "indexed8",
              );
            }
            (layer.data as Uint8Array).set(bytes);
          } else if (geoJson) {
            // Layer-local PNG with geometry
            const geo = JSON.parse(geoJson) as {
              layerWidth: number;
              layerHeight: number;
              offsetX: number;
              offsetY: number;
            };
            layer = renderer.createLayer(
              ls.id,
              ls.name,
              geo.layerWidth,
              geo.layerHeight,
              geo.offsetX,
              geo.offsetY,
            );
            try {
              const rgba = await decodePng(
                imageData,
                geo.layerWidth,
                geo.layerHeight,
              );
              if (isStale()) return;
              layer.data.set(rgba);
            } catch (e) {
              console.error("[Canvas] Failed to load layer PNG:", e);
            }
          } else {
            // Legacy / image import: PNG is canvas-sized
            layer = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
            try {
              const rgba = await decodePng(imageData, cw, ch);
              if (isStale()) return;
              layer.data.set(rgba);
            } catch (e) {
              console.error("[Canvas] Failed to load layer PNG:", e);
            }
          }
        } else if (i === 0 && !initialLayerData) {
          // New document — background layer covers the full canvas
          const fmt = state.pixelFormat;
          layer = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0, fmt);
          const bg = state.canvas.backgroundFill;
          if (fmt === "indexed8") {
            if (bg === "white" || bg === "black") {
              const tr = bg === "white" ? 255 : 0;
              const tg = bg === "white" ? 255 : 0;
              const tb = bg === "white" ? 255 : 0;
              const fillIdx = resolveNearestPaletteIndex(
                tr,
                tg,
                tb,
                255,
                swatchesRef.current as import("@/types").RGBAColor[],
              );
              (layer.data as Uint8Array).fill(fillIdx);
            } else {
              // transparent — void fill
              (layer.data as Uint8Array).fill(255);
            }
          } else {
            if (bg === "white") {
              layer.data.fill(255);
            } else if (bg === "black") {
              for (let j = 0; j < layer.data.length; j += 4) {
                layer.data[j] = 0;
                layer.data[j + 1] = 0;
                layer.data[j + 2] = 0;
                layer.data[j + 3] = 255;
              }
            }
          }
        } else if ("type" in ls && ls.type === "shape") {
          // Shape layers are full-canvas-sized (rasterized vector data)
          layer = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
          rasterizeShapeToLayer(
            ls,
            layer,
            cw,
            ch,
            state.pixelFormat,
            state.swatches,
          );
        } else if ("type" in ls && ls.type === "mask") {
          // Mask layers are full-canvas-sized; initialized all-white (fully reveal parent)
          layer = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
          layer.data.fill(255);
        } else {
          // New blank layer — start at 128×128 centered on the canvas
          const initW = Math.min(128, cw);
          const initH = Math.min(128, ch);
          const ox = Math.round((cw - initW) / 2);
          const oy = Math.round((ch - initH) / 2);
          const fmt = state.pixelFormat;
          layer = renderer.createLayer(
            ls.id,
            ls.name,
            initW,
            initH,
            ox,
            oy,
            fmt,
          );
          if (fmt === "indexed8") (layer.data as Uint8Array).fill(255);
        }

        layer.opacity = "opacity" in ls ? ls.opacity : 1;
        layer.visible = ls.visible;
        layer.blendMode = "blendMode" in ls ? ls.blendMode : "normal";
        if (isStale()) return;
        renderer.flushLayer(
          layer,
          layer.format === "indexed8"
            ? (swatchesRef.current as import("@/types").RGBAColor[])
            : undefined,
        );
        glLayersRef.current.set(ls.id, layer);
      }
      if (isStale()) return;
      doRender();
      if (!isStale() && isActiveRef.current) {
        onReadyRef.current?.();
      }
    };

    init();
    return () => {
      cancelled = true;
      hasInitializedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendererVersion]);

  // Sync WebGL layers whenever AppState layer list changes
  useEffect(() => {
    if (!isActive) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const map = glLayersRef.current;

    for (const ls of state.layers) {
      if ("type" in ls && ls.type === "adjustment") continue;
      if (!map.has(ls.id)) {
        if ("type" in ls && ls.type === "text") {
          // Text layers are created imperatively in addTextLayer before the dispatch;
          // if they somehow still aren't in the map, create a full-canvas layer for them.
          const cw = renderer.pixelWidth;
          const ch = renderer.pixelHeight;
          const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
          rasterizeTextToLayer(ls, gl);
          renderer.flushLayer(gl);
          map.set(ls.id, gl);
        } else if ("type" in ls && ls.type === "shape") {
          // Shape layers created imperatively via addShapeLayer; recreate if missing.
          const cw = renderer.pixelWidth;
          const ch = renderer.pixelHeight;
          const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
          rasterizeShapeToLayer(
          ls,
          gl,
          cw,
          ch,
          state.pixelFormat,
          state.swatches,
        );
          renderer.flushLayer(gl);
          map.set(ls.id, gl);
        } else if ("type" in ls && ls.type === "frame") {
          // Frame layers created imperatively via addFrameLayer; recreate if missing.
          const cw = renderer.pixelWidth;
          const ch = renderer.pixelHeight;
          const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
          rasterizeFrameToLayer(ls, gl, cw, ch);
          renderer.flushLayer(gl);
          map.set(ls.id, gl);
          if (ls.content) {
            const content = ls.content;
            ensureContentDecoded(content, () => {
              // Re-rasterize once the bitmap is decoded.
              const cur = map.get(ls.id);
              if (!cur) return;
              rasterizeFrameToLayer(ls, cur, cw, ch);
              renderer.flushLayer(cur);
              doRender();
            });
          }
        } else if ("type" in ls && ls.type === "mask") {
          // Newly added mask layer — full-canvas white (default: fully reveal parent)
          const cw = renderer.pixelWidth;
          const ch = renderer.pixelHeight;
          const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
          gl.data.fill(255);
          renderer.flushLayer(gl);
          map.set(ls.id, gl);
        } else {
          // Pixel layers start at 128×128 centered on the canvas
          const cw = renderer.pixelWidth;
          const ch = renderer.pixelHeight;
          const initW = Math.min(128, cw);
          const initH = Math.min(128, ch);
          const ox = Math.round((cw - initW) / 2);
          const oy = Math.round((ch - initH) / 2);
          const fmt = state.pixelFormat;
          const gl = renderer.createLayer(
            ls.id,
            ls.name,
            initW,
            initH,
            ox,
            oy,
            fmt,
          );
          if (fmt === "indexed8") (gl.data as Uint8Array).fill(255);
          map.set(ls.id, gl);
        }
      }
    }

    const stateIds = new Set(state.layers.map((l) => l.id));
    for (const [id, gl] of map) {
      if (!stateIds.has(id)) {
        renderer.destroyLayer(gl);
        map.delete(id);
      }
    }
    for (const [id, gl] of adjustmentMaskMap.current) {
      if (!stateIds.has(id)) {
        renderer.destroyLayer(gl);
        adjustmentMaskMap.current.delete(id);
      }
    }

    if (state.activeTool === "clone-stamp" && cloneStampStore.source) {
      if (!stateIds.has(cloneStampStore.source.layerId)) {
        cloneStampStore.clearSource();
      }
    }

    for (const ls of state.layers) {
      if ("type" in ls && ls.type === "adjustment") continue;
      const gl = map.get(ls.id);
      if (!gl) continue;
      gl.opacity = "opacity" in ls ? ls.opacity : 1;
      gl.visible = ls.visible;
      gl.blendMode = "blendMode" in ls ? ls.blendMode : "normal";
      // Re-rasterize text layers whenever their state changes (text, style, position, color).
      if ("type" in ls && ls.type === "text") {
        // Always reset offset — move tool may have shifted it temporarily for preview.
        gl.offsetX = 0;
        gl.offsetY = 0;
        rasterizeTextToLayer(ls, gl);
        renderer.flushLayer(gl);
      } else if ("type" in ls && ls.type === "shape") {
        // Re-rasterize whenever shape parameters change
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        rasterizeShapeToLayer(
          ls,
          gl,
          cw,
          ch,
          state.pixelFormat,
          state.swatches,
        );
        renderer.flushLayer(gl);
      } else if ("type" in ls && ls.type === "frame") {
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        gl.offsetX = 0;
        gl.offsetY = 0;
        rasterizeFrameToLayer(ls, gl, cw, ch);
        renderer.flushLayer(gl);
        if (ls.content) {
          const content = ls.content;
          ensureContentDecoded(content, () => {
            const cur = map.get(ls.id);
            if (!cur) return;
            rasterizeFrameToLayer(ls, cur, cw, ch);
            renderer.flushLayer(cur);
            doRender();
          });
        }
      }
    }

    doRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.layers, isActive]);

  useEffect(() => {
    if (!isActive) return;
    // Shape layers with a palette-index reference resolve their colour
    // from `state.swatches` at rasterise time. When swatches change
    // (e.g. user edits a palette entry, swap, palette-cycle preview),
    // re-rasterise those shapes so the canvas reflects the new colours.
    const renderer = rendererRef.current;
    if (renderer) {
      const cw = renderer.pixelWidth;
      const ch = renderer.pixelHeight;
      const map = glLayersRef.current;
      for (const ls of state.layers) {
        if (!("type" in ls) || ls.type !== "shape") continue;
        if (ls.strokeIndex === undefined && ls.fillIndex === undefined)
          continue;
        const gl = map.get(ls.id);
        if (!gl) continue;
        rasterizeShapeToLayer(
          ls,
          gl,
          cw,
          ch,
          state.pixelFormat,
          state.swatches,
        );
        renderer.flushLayer(gl);
      }
    }
    doRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.swatches, isActive]);

  useEffect(() => {
    if (!isActive) return;
    doRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.canvas.tiledMode, state.canvas.showTileGrid, isActive]);

  // Keep doRenderRef current every render so subscriptions always call the latest closure
  doRenderRef.current = doRender;

  // Wire the renderer's effect-recompute throttle: when an adjustment/effect
  // cache is reused mid-stroke (instead of recomputed), the renderer needs a
  // way to re-trigger a render after the 250 ms throttle window so the user
  // sees the updated effect output even if no further input events arrive.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setRefreshCallback(() => doRenderRef.current());
    return () => {
      renderer.setRefreshCallback(null);
    };
  }, [rendererVersion]);

  // When the canvas backing buffer is resized (zoom crosses a threshold), the
  // WebGPU swapchain texture is reallocated and contains undefined pixels.
  // Force the next renderPlan() to actually run (not be skipped by the
  // fingerprint cache) so the new swapchain is filled with valid content.
  useEffect(() => {
    if (!isActive) return;
    // Block any in-flight or pending mirror update from reading the
    // newly-allocated, uninitialized swapchain. doRender re-arms it.
    mirrorReadyRef.current = false;
    if (mirrorTrailingTimeoutRef.current !== null) {
      clearTimeout(mirrorTrailingTimeoutRef.current);
      mirrorTrailingTimeoutRef.current = null;
    }
    rendererRef.current?.markViewportDirty();
    doRenderRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backingW, backingH, isActive]);

  // Re-render on viewport scroll: scrolling changes which slice of the canvas
  // backing buffer is visible, and the WebGPU blit is scissored to that slice
  // (see computeViewportScissor + renderer.setViewportScissor). Without this,
  // newly-revealed regions of the backing would show stale pixels until the
  // next plan-changing event.
  useEffect(() => {
    if (!isActive) return;
    const vp = viewportRef.current;
    if (!vp) return;
    const onScroll = (): void => {
      doRenderRef.current();
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // Re-render when HDR tone-mapping settings change (EV slider, operator)
  useEffect(() => {
    if (!isActive) return;
    const onDisplayChange = (): void => {
      doRenderRef.current();
    };
    displayStore.subscribe(onDisplayChange);
    return () => displayStore.unsubscribe(onDisplayChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  useEffect(() => {
    if (!isActive || !state.canvas.tiledMode) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const dpr = window.devicePixelRatio;
    const zoom = zoomRef.current;
    // padding = canvasSize*zoom/dpr; middle tile starts at padding + 1×tile = 2×tile
    viewport.scrollLeft = (2 * width * zoom) / dpr;
    viewport.scrollTop = (2 * height * zoom) / dpr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.canvas.tiledMode, isActive]);

  useEffect(() => {
    if (!isActive) return;
    const unsubscribe = adjustmentPreviewStore.subscribe(() => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      doRender();
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // When a swatch is removed in indexed8 mode, remap layer pixel indices:
  // pixels that pointed to the removed index → 255 (void), pixels above it → decremented.
  useEffect(() => {
    if (!isActive || state.pixelFormat !== "indexed8") return;
    const removedIndex = state.lastRemovedSwatchIndex;
    if (removedIndex == null) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    for (const gl of glLayersRef.current.values()) {
      if (gl.format !== "indexed8") continue;
      const data = gl.data as Uint8Array;
      for (let i = 0; i < data.length; i++) {
        if (data[i] === removedIndex) {
          data[i] = 255;
        } else if (data[i] > removedIndex && data[i] < 255) {
          data[i]--;
        }
      }
    }
    dispatch({ type: "CLEAR_REMOVED_SWATCH_INDEX" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.lastRemovedSwatchIndex, isActive]);

  // When swatches change in indexed8 mode, re-flush all indexed layers so the GPU
  // textures reflect the new palette mapping, then re-render.
  useEffect(() => {
    if (!isActive || state.pixelFormat !== "indexed8") return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    for (const [, layer] of glLayersRef.current) {
      if (layer.format === "indexed8") {
        renderer.flushLayer(layer, state.swatches);
      }
    }
    doRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.swatches, isActive]);

  useEffect(() => {
    if (!isActive || state.activeTool !== "transform") return;
    const redraw = (): void => {
      const oc = toolOverlayRef.current;
      if (!oc) return;
      drawTransformOverlay(oc, transformStore, zoomRef.current);
    };
    redraw();
    transformStore.subscribe(redraw);
    return () => {
      transformStore.unsubscribe(redraw);
      const oc = toolOverlayRef.current;
      if (oc) {
        const ctx = oc.getContext("2d");
        ctx?.clearRect(0, 0, oc.width, oc.height);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, state.activeTool]);

  useEffect(() => {
    if (!isActive || state.activeTool !== "clone-stamp") return;
    const redraw = (): void => {
      const oc = toolOverlayRef.current;
      if (!oc) return;
      const canvas = canvasRef.current;
      if (canvas)
        canvas.style.cursor = cloneStampStore.source ? "none" : "crosshair";
      if (!cloneStampStore.source) {
        oc.getContext("2d")?.clearRect(0, 0, oc.width, oc.height);
        return;
      }
      drawCloneStampOverlay(
        oc,
        cloneStampStore.source.x,
        cloneStampStore.source.y,
        cursorStore.x,
        cursorStore.y,
        cloneStampOptions.aligned,
      );
    };

    redraw();
    cloneStampStore.subscribe(redraw);
    return () => {
      cloneStampStore.unsubscribe(redraw);
      const oc = toolOverlayRef.current;
      oc?.getContext("2d")?.clearRect(0, 0, oc.width, oc.height);
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, state.activeTool]);

  // Move tool: show the OS 4-direction move cursor over the canvas.
  useEffect(() => {
    if (!isActive || state.activeTool !== "move") return;
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = "move";
    return () => {
      if (canvas) canvas.style.cursor = "";
    };
  }, [isActive, state.activeTool]);

  // Cursor updates for polygonal selection (drawing handled by useMarchingAnts)
  useEffect(() => {
    if (!isActive || state.activeTool !== "polygonal-selection") return;

    const updateCursor = (): void => {
      if (canvasRef.current) {
        canvasRef.current.style.cursor = polygonalSelectionStore.nearClose
          ? "cell"
          : "crosshair";
      }
    };

    updateCursor();
    polygonalSelectionStore.subscribe(updateCursor);
    return () => {
      polygonalSelectionStore.unsubscribe(updateCursor);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, state.activeTool]);

  // ── Object selection overlay ──────────────────────────────────────────────────
  useEffect(() => {
    if (!isActive || state.activeTool !== "object-selection") return;

    const redraw = (): void => {
      const oc = toolOverlayRef.current;
      if (!oc) return;
      const ctx2d = oc.getContext("2d");
      if (!ctx2d) return;
      ctx2d.clearRect(0, 0, oc.width, oc.height);

      const store = objectSelectionStore;

      // Draw drag rectangle
      if (store.dragRect) {
        const { x1, y1, x2, y2 } = store.dragRect;
        const rx = Math.min(x1, x2);
        const ry = Math.min(y1, y2);
        const rw = Math.abs(x2 - x1);
        const rh = Math.abs(y2 - y1);
        ctx2d.strokeStyle = "rgba(0,0,0,0.6)";
        ctx2d.lineWidth = 2;
        ctx2d.setLineDash([5, 4]);
        ctx2d.strokeRect(rx, ry, rw, rh);
        ctx2d.strokeStyle = "white";
        ctx2d.lineWidth = 1;
        ctx2d.setLineDash([5, 4]);
        ctx2d.strokeRect(rx, ry, rw, rh);
        ctx2d.setLineDash([]);
      }

      // Draw point prompts
      for (const pt of store.points) {
        const color = pt.positive ? "#22cc44" : "#ee3333";
        ctx2d.beginPath();
        ctx2d.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
        ctx2d.fillStyle = color;
        ctx2d.fill();
        ctx2d.strokeStyle = "white";
        ctx2d.lineWidth = 1.5;
        ctx2d.setLineDash([]);
        ctx2d.stroke();
        ctx2d.fillStyle = "white";
        ctx2d.font = "bold 9px sans-serif";
        ctx2d.textAlign = "center";
        ctx2d.textBaseline = "middle";
        ctx2d.fillText(pt.positive ? "+" : "\u2212", pt.x, pt.y);
      }
    };

    redraw();
    objectSelectionStore.subscribe(redraw);

    return () => {
      objectSelectionStore.unsubscribe(redraw);
      const oc = toolOverlayRef.current;
      oc?.getContext("2d")?.clearRect(0, 0, oc.width, oc.height);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, state.activeTool]);

  function buildMaskMap(): Map<string, GpuLayer> {
    const maskMap = new Map<string, GpuLayer>();
    for (const ls of state.layers) {
      if ("type" in ls && ls.type === "mask" && ls.visible) {
        const gl = glLayersRef.current.get(ls.id);
        if (gl) maskMap.set((ls as MaskLayerState).parentId, gl);
      }
    }
    return maskMap;
  }

  function buildOrderedGLLayers(): GpuLayer[] {
    const map = glLayersRef.current;
    // Exclude mask and adjustment layers — mask applied via buildMaskMap, adjustments via renderPlan
    const layers = state.layers
      .filter(
        (ls) =>
          !("type" in ls && (ls.type === "mask" || ls.type === "adjustment")),
      )
      .map((ls) => map.get(ls.id))
      .filter((l): l is GpuLayer => !!l);
    // Include any pending new pixel layer before state re-renders with it
    const pending = newPixelLayerRef.current;
    if (pending && !layers.some((l) => l === pending)) layers.push(pending);
    return layers;
  }

  function buildRenderPlan(): RenderPlanEntry[] {
    const plan = buildCanvasRenderPlan(
      layersStateRef.current,
      glLayersRef.current,
      buildMaskMap(),
      adjustmentMaskMap.current,
      adjustmentPreviewStore.snapshot(),
      state.swatches,
      state.pixelFormat,
    );
    const pending = newPixelLayerRef.current;
    if (
      pending &&
      !plan.some((e) => e.kind === "layer" && e.layer === pending)
    ) {
      plan.push({ kind: "layer", layer: pending });
    }
    return plan;
  }

  useEffect(() => {
    if (!isActive) return;
    const sel = state.activeTool;
    if (
      sel !== "select" &&
      sel !== "lasso" &&
      sel !== "magic-wand" &&
      sel !== "patch" &&
      sel !== "healing-brush"
    ) {
      selectionStore.setPending(null);
    }
    toolHandlerRef.current = TOOL_REGISTRY[state.activeTool].createHandler();
    // Cancel any in-progress polygonal selection when switching tools
    polygonalSelectionStore.cancel();
    if (sel !== "object-selection") objectSelectionStore.reset();
    // Hide brush cursor when switching away from a circle-cursor tool
    if (brushCursorRef.current) {
      if (
        sel !== "brush" &&
        sel !== "eraser" &&
        sel !== "clone-stamp" &&
        sel !== "dodge" &&
        sel !== "burn" &&
        sel !== "liquify" &&
        sel !== "blur" &&
        sel !== "sharpen" &&
        sel !== "smudge" &&
        sel !== "healing-brush" &&
        sel !== "quick-select"
      ) {
        brushCursorRef.current.style.display = "none";
      }
      // Always reset the class so brushCursorCrossHair doesn't linger when switching between circle-cursor tools
      brushCursorRef.current.className = styles.brushCursor;
    }
    if (pixelBrushCursorRef.current)
      pixelBrushCursorRef.current.style.display = "none";
  }, [state.activeTool, isActive]);

  const buildCtx = (): ToolContext | null => {
    const renderer = rendererRef.current;
    if (!renderer) return null;
    const activeId = state.activeLayerId;
    let activeLayer = activeId ? glLayersRef.current.get(activeId) : undefined;

    // Text/shape/frame tools create their own; pick/hand/zoom don't touch
    // pixels so they're fine without an active pixel layer.
    if (
      !activeLayer &&
      state.activeTool !== "text" &&
      state.activeTool !== "shape" &&
      state.activeTool !== "frame" &&
      state.activeTool !== "pick" &&
      state.activeTool !== "hand" &&
      state.activeTool !== "zoom" &&
      state.activeTool !== "measure"
    )
      return null;
    // Block pixel-modifying tools on locked layers and on non-pixel layers (text, shape, group, adjustment).
    // Mask layers are allowed — tools paint grayscale onto the mask buffer.
    if (TOOL_REGISTRY[state.activeTool].modifiesPixels) {
      const stateMeta = state.layers.find((l) => l.id === activeId);
      if (stateMeta && "locked" in stateMeta && stateMeta.locked) return null;
      const isParametric =
        stateMeta && "type" in stateMeta && stateMeta.type !== "mask";
      if (isParametric && !TOOL_REGISTRY[state.activeTool].worksOnAllLayers)
        return null;
    }
    // Detect mask layer — constrain colors to grayscale
    const activeMeta = state.layers.find((l) => l.id === activeId);
    const isMaskLayer =
      activeMeta && "type" in activeMeta && activeMeta.type === "mask";
    // For mask layers: convert float primaryColor/secondaryColor to grayscale float.
    const toGray = (c: { r: number; g: number; b: number; a: number }) => {
      const g = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      return { r: g, g: g, b: g, a: 1 };
    };
    return {
      renderer,
      layer: activeLayer!, // text tool never dereferences this; all others are guarded above
      layers: buildOrderedGLLayers(),
      primaryColor: isMaskLayer
        ? toGray(state.primaryColor)
        : state.primaryColor,
      secondaryColor: isMaskLayer
        ? toGray(state.secondaryColor)
        : state.secondaryColor,
      selectionMask: selectionStore.mask,
      render: () => {
        doRender();
      },
      growLayerToFit: (
        canvasX: number,
        canvasY: number,
        extraRadius = 0,
      ): void => {
        // Mask layers are always full-canvas sized — never grow them.
        // Growing a mask shifts its existing pixel data to a non-zero offset inside
        // the new larger buffer, while new regions are zero-initialized (R=0 = hide).
        // The shader samples the mask at canvas UV [0,1]², so a shifted/grown mask
        // causes the parent layer to appear invisible ("squished mask" artifact).
        if (isMaskLayer) return;
        // Tiled mode: wrap the coord into canvas range. blendPixelOver applies the
        // same wrap before bounds-checking against the layer rect, so the layer
        // must cover the wrapped destination, not the raw out-of-canvas input.
        const W = renderer.pixelWidth;
        const H = renderer.pixelHeight;
        if (state.canvas.tiledMode) {
          canvasX = ((canvasX % W) + W) % W;
          canvasY = ((canvasY % H) + H) % H;
        } else {
          // Clamp to canvas bounds — painting outside the canvas should not grow
          // the layer beyond the canvas dimensions.
          canvasX = Math.max(0, Math.min(W - 1, canvasX));
          canvasY = Math.max(0, Math.min(H - 1, canvasY));
        }
        renderer.growLayerToFit(activeLayer!, canvasX, canvasY, extraRadius);
      },
      setColor: (color) => {
        dispatch({
          type: "SET_PRIMARY_COLOR",
          payload: isMaskLayer ? toGray(color) : color,
        });
      },
      commitStroke: (label: string) => {
        onStrokeEndRef.current?.(label);
      },
      overlayCanvas: toolOverlayRef.current,
      addTextLayer: (ls) => {
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
        rasterizeTextToLayer(ls, gl);
        renderer.flushLayer(gl);
        glLayersRef.current.set(ls.id, gl);
        doRender();
        dispatch({ type: "ADD_TEXT_LAYER", payload: ls });
        setEditingLayerId(ls.id);
      },
      updateTextLayer: (ls) => {
        dispatch({ type: "UPDATE_TEXT_LAYER", payload: ls });
      },
      openTextLayerEditor: (id) => {
        dispatch({ type: "SET_ACTIVE_LAYER", payload: id });
        setEditingLayerId(id);
      },
      textLayers: state.layers.filter(
        (l): l is TextLayerState => "type" in l && l.type === "text",
      ),
      previewTextAt: (ls, x, y) => {
        const gl = glLayersRef.current.get(ls.id);
        if (!gl) return;
        rasterizeTextToLayer({ ...ls, x, y }, gl);
        renderer.flushLayer(gl);
        doRender();
      },
      addShapeLayer: (ls) => {
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
        rasterizeShapeToLayer(
          ls,
          gl,
          cw,
          ch,
          state.pixelFormat,
          state.swatches,
        );
        renderer.flushLayer(gl);
        glLayersRef.current.set(ls.id, gl);
        doRender();
        dispatch({ type: "ADD_SHAPE_LAYER", payload: ls });
      },
      updateShapeLayer: (ls) => {
        dispatch({ type: "UPDATE_SHAPE_LAYER", payload: ls });
      },
      previewShapeLayer: (ls) => {
        const gl = glLayersRef.current.get(ls.id);
        if (!gl) return;
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        rasterizeShapeToLayer(
          ls,
          gl,
          cw,
          ch,
          state.pixelFormat,
          state.swatches,
        );
        renderer.flushLayer(gl);
        doRender();
      },
      shapeLayers: state.layers.filter(
        (l): l is ShapeLayerState => "type" in l && l.type === "shape",
      ),
      activeShapeLayer: (() => {
        const l = state.layers.find((l) => l.id === activeId);
        return l && "type" in l && l.type === "shape" ? l : null;
      })(),
      addFrameLayer: (ls) => {
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
        rasterizeFrameToLayer(ls, gl, cw, ch);
        renderer.flushLayer(gl);
        glLayersRef.current.set(ls.id, gl);
        doRender();
        dispatch({ type: "ADD_FRAME_LAYER", payload: ls });
      },
      updateFrameLayer: (ls) => {
        dispatch({ type: "UPDATE_FRAME_LAYER", payload: ls });
      },
      previewFrameLayer: (ls) => {
        const gl = glLayersRef.current.get(ls.id);
        if (!gl) return;
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        rasterizeFrameToLayer(ls, gl, cw, ch);
        renderer.flushLayer(gl);
        doRender();
      },
      frameLayers: state.layers.filter(
        (l): l is FrameLayerState => "type" in l && l.type === "frame",
      ),
      activeFrameLayer: (() => {
        const l = state.layers.find((l) => l.id === activeId);
        return l && "type" in l && l.type === "frame" ? l : null;
      })(),
      zoom: state.canvas.zoom,
      tiledMode: state.canvas.tiledMode,
      pixelFormat: state.pixelFormat,
      swatches: swatchesRef.current,
      swatchGroups: state.swatchGroups,
      setSwatch: (index) => {
        dispatch({ type: "SET_ACTIVE_SWATCH", payload: index });
      },
      guides: state.canvas.guides,
      maskMap: buildMaskMap(),
      selectedLayerIds: state.selectedLayerIds,
      setActiveLayer: (id: string) => {
        dispatch({ type: "SET_ACTIVE_LAYER", payload: id });
      },
      setActiveTool: (t) => {
        dispatch({ type: "SET_TOOL", payload: t });
      },
      setCursor: (cursor: string) => {
        const c = canvasRef.current;
        if (c) c.style.cursor = cursor;
      },
      panViewport: (dxCss: number, dyCss: number) => {
        const vp = viewportRef.current;
        if (!vp) return;
        vp.scrollLeft += dxCss;
        vp.scrollTop += dyCss;
      },
      setZoom: (
        nextZoom: number,
        focus?: { canvasX: number; canvasY: number },
      ) => {
        const clamped = parseFloat(
          Math.max(0.05, Math.min(32, nextZoom)).toFixed(4),
        );
        const vp = viewportRef.current;
        const oldZoom = state.canvas.zoom;
        if (vp && focus && oldZoom > 0 && clamped !== oldZoom) {
          // Anchor the supplied canvas-space point so it stays at the same
          // viewport CSS-px location. Mirrors useScrollZoom's wheel formula.
          const dpr = window.devicePixelRatio;
          const anchorX =
            (width * oldZoom) / dpr +
            (focus.canvasX * oldZoom) / dpr -
            vp.scrollLeft;
          const anchorY =
            (height * oldZoom) / dpr +
            (focus.canvasY * oldZoom) / dpr -
            vp.scrollTop;
          const r = clamped / oldZoom;
          pendingScrollRef.current = {
            scrollLeft: (vp.scrollLeft + anchorX) * r - anchorX,
            scrollTop: (vp.scrollTop + anchorY) * r - anchorY,
          };
        }
        dispatch({ type: "SET_ZOOM", payload: clamped });
      },
    };
  };

  // Fire onActivate on the current tool whenever the active tool or active
  // layer changes — gives tools like shape/frame a chance to draw their edit
  // overlay immediately (e.g. so double-clicking a shape via the pick tool
  // drops straight into edit mode without an extra click).
  useEffect(() => {
    if (!isActive) return;
    const ctx = buildCtx();
    if (ctx) toolHandlerRef.current.onActivate?.(ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeTool, state.activeLayerId, isActive]);

  const {
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerLeave,
  } = useCanvas({
    onPointerDown: (pos) => {
      const ctx = buildCtx();
      if (ctx) toolHandlerRef.current.onPointerDown(pos, ctx);
    },
    onPointerMove: (pos) => {
      const ctx = buildCtx();
      if (ctx) toolHandlerRef.current.onPointerMove(pos, ctx);
      // Pixel-info tracking for indexed8 mode (feeds StatusBar "idx N · #RRGGBB")
      if (state.pixelFormat === "indexed8") {
        const renderer = rendererRef.current;
        const activeId = state.activeLayerId;
        const layer = activeId ? glLayersRef.current.get(activeId) : undefined;
        if (renderer && layer && layer.format === "indexed8") {
          const lx = Math.floor(pos.x) - layer.offsetX;
          const ly = Math.floor(pos.y) - layer.offsetY;
          if (
            lx >= 0 &&
            lx < layer.layerWidth &&
            ly >= 0 &&
            ly < layer.layerHeight
          ) {
            const idx = (layer.data as Uint8Array)[ly * layer.layerWidth + lx];
            const palette = swatchesRef.current;
            const color = idx < palette.length ? palette[idx] : null;
            cursorStore.setPixelInfo({
              index: idx,
              color: color
                ? { r: color.r, g: color.g, b: color.b, a: color.a }
                : null,
            });
          } else {
            cursorStore.setPixelInfo(null);
          }
        } else {
          cursorStore.setPixelInfo(null);
        }
        cursorStore.setPixelValues(null, false);
      } else if (state.pixelFormat === "rgba32f") {
        if (cursorStore.pixelInfo !== null) cursorStore.setPixelInfo(null);
        const renderer = rendererRef.current;
        const activeId = state.activeLayerId;
        const layer = activeId ? glLayersRef.current.get(activeId) : undefined;
        if (renderer && layer && layer.format === "rgba32f") {
          const lx = Math.floor(pos.x) - layer.offsetX;
          const ly = Math.floor(pos.y) - layer.offsetY;
          if (
            lx >= 0 &&
            lx < layer.layerWidth &&
            ly >= 0 &&
            ly < layer.layerHeight
          ) {
            const base = (ly * layer.layerWidth + lx) * 4;
            const data = layer.data as Float32Array;
            cursorStore.setPixelValues(
              [data[base], data[base + 1], data[base + 2], data[base + 3]],
              true,
            );
          } else {
            cursorStore.setPixelValues(null, false);
          }
        } else {
          cursorStore.setPixelValues(null, false);
        }
      } else {
        if (cursorStore.pixelInfo !== null) cursorStore.setPixelInfo(null);
        cursorStore.setPixelValues(null, false);
      }
    },
    onPointerMoveBatch: (positions) => {
      // Pen coalesced-event batch: accumulate all CPU drawing first, then do a
      // single GPU texture upload + composite render at the end.
      // This reduces GPU work from N×(flushLayer + render) to 1×(flushLayer + render)
      // per display frame — critical for Wacom pens on large (4K) canvases.
      const renderer = rendererRef.current;
      const ctx = buildCtx();
      if (!ctx || !renderer) return;

      // Suppress GPU uploads and renders during the loop
      renderer.deferFlush = true;
      const noopRender = (): void => {
        /* deferred */
      };
      for (const pos of positions) {
        toolHandlerRef.current.onPointerMove(pos, {
          ...ctx,
          render: noopRender,
        });
      }

      // Single GPU flush + composite after all CPU drawing is complete
      renderer.deferFlush = false;
      renderer.flushLayer(ctx.layer);
      ctx.render();
    },
    onPointerUp: (pos) => {
      const ctx = buildCtx();
      if (ctx) toolHandlerRef.current.onPointerUp(pos, ctx);
      newPixelLayerRef.current = null;
      const def = TOOL_REGISTRY[state.activeTool];
      if (def.modifiesPixels && !def.skipAutoHistory && ctx) {
        const label =
          state.activeTool.charAt(0).toUpperCase() + state.activeTool.slice(1);
        onStrokeEndRef.current?.(label);
      }
    },
    onHover: (pos) => {
      if (isActive) cursorStore.setPosition(pos.x, pos.y);
      // Update circle cursor for brush / eraser / clone-stamp / dodge / burn / liquify / blur / sharpen / smudge
      const tool = state.activeTool;
      if (
        (tool === "brush" ||
          tool === "eraser" ||
          tool === "clone-stamp" ||
          tool === "dodge" ||
          tool === "burn" ||
          tool === "liquify" ||
          tool === "blur" ||
          tool === "sharpen" ||
          tool === "smudge" ||
          tool === "healing-brush" ||
          tool === "quick-select") &&
        brushCursorRef.current
      ) {
        const dpr = window.devicePixelRatio;
        const zoom = zoomRef.current;
        const size =
          tool === "brush"
            ? brushOptions.size
            : tool === "eraser"
              ? eraserOptions.size
              : tool === "dodge"
                ? dodgeOptions.size
                : tool === "burn"
                  ? burnOptions.size
                  : tool === "liquify"
                    ? liquifyOptions.size
                    : tool === "blur"
                      ? blurOptions.size
                      : tool === "sharpen"
                        ? sharpenOptions.size
                        : tool === "smudge"
                          ? smudgeOptions.size
                          : tool === "healing-brush"
                            ? healingBrushOptions.size
                            : tool === "quick-select"
                              ? quickSelectOptions.size
                              : cloneStampOptions.size;
        const r = Math.max(1, ((size / 2) * zoom) / dpr);
        const cx = (pos.x * zoom) / dpr;
        const cy = (pos.y * zoom) / dpr;
        const el = brushCursorRef.current;
        el.style.left = `${cx - r}px`;
        el.style.top = `${cy - r}px`;
        el.style.width = `${r * 2}px`;
        el.style.height = `${r * 2}px`;
        if (tool === "clone-stamp") {
          el.style.display = cloneStampStore.source ? "block" : "none";
          el.className = `${styles.brushCursor} ${styles.brushCursorCrossHair}`;
        } else {
          el.style.display = "block";
          el.className = styles.brushCursor;
        }
      }
      if (tool === "pencil" && pixelBrushCursorRef.current) {
        // primaryColor is float [0,1]; scale to 0-255 for cursor preview rendering.
        const r = Math.round(Math.min(state.primaryColor.r, 1) * 255);
        const g = Math.round(Math.min(state.primaryColor.g, 1) * 255);
        const b = Math.round(Math.min(state.primaryColor.b, 1) * 255);
        const a = Math.round(state.primaryColor.a * 255);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        void a; // used below through getPencilBrushPreviewDataUrl / getPencilShapePreviewDataUrl
        const dpr = window.devicePixelRatio;
        const zoom = zoomRef.current;
        const preview = pencilOptions.pixelBrush
          ? getPencilBrushPreviewDataUrl(r, g, b, a)
          : getPencilShapePreviewDataUrl(r, g, b, a);
        if (preview) {
          // Pencil quantises hover positions to the nearest pixel via
          // `Math.round(pos.x/y)` when stamping (pencil.tsx). Match that
          // here so the preview lands on the same pixel that will actually
          // be plotted — otherwise the cursor floats up to half a pixel
          // off-grid, drifting from the soon-to-be-painted cell.
          let canvasX = Math.round(pos.x),
            canvasY = Math.round(pos.y);
          if (
            pencilOptions.pixelBrush &&
            pencilOptions.snapToBrush &&
            "tileW" in preview
          ) {
            canvasX = Math.round(pos.x / preview.tileW) * preview.tileW;
            canvasY = Math.round(pos.y / preview.tileH) * preview.tileH;
          }
          const previewW =
            "previewW" in preview ? preview.previewW : preview.size;
          const previewH =
            "previewH" in preview ? preview.previewH : preview.size;
          const scaledW = (previewW * zoom) / dpr;
          const scaledH = (previewH * zoom) / dpr;
          // Match the pencil's discrete footprint: it stamps
          // `paintBrushPixel(cx + dx, cy + dy)` with dx ∈ [-half, size-half)
          // where half = floor(size/2). So the top-left pixel of the
          // footprint sits at canvasX - half. A continuous `+0.5 - size/2`
          // formulation is half a pixel off for even sizes (pencil biases
          // even brushes toward the top-left).
          const halfW = Math.floor(previewW / 2);
          const halfH = Math.floor(previewH / 2);
          const screenX = ((canvasX - halfW) * zoom) / dpr;
          const screenY = ((canvasY - halfH) * zoom) / dpr;
          const el = pixelBrushCursorRef.current;
          el.style.display = "block";
          el.style.left = `${screenX}px`;
          el.style.top = `${screenY}px`;
          el.style.width = `${scaledW}px`;
          el.style.height = `${scaledH}px`;
          el.style.backgroundImage = `url("${preview.dataUrl}")`;
          el.style.backgroundSize = "100% 100%";
        } else {
          pixelBrushCursorRef.current.style.display = "none";
        }
      } else if (
        pixelBrushCursorRef.current &&
        pixelBrushCursorRef.current.style.display !== "none"
      ) {
        pixelBrushCursorRef.current.style.display = "none";
      }
      if (tool === "pencil" && canvasRef.current) {
        canvasRef.current.style.cursor = "none";
      }
      const ctx = buildCtx();
      if (ctx) toolHandlerRef.current.onHover?.(pos, ctx);
    },
    onLeave: () => {
      const ctx = buildCtx();
      if (ctx) toolHandlerRef.current.onLeave?.(ctx);
    },
    documentWidth: width,
    documentHeight: height,
  });

  // Stable offset object for the tiled canvas second useCanvas call
  const tiledOffset = useMemo(() => ({ x: width, y: height }), [width, height]);

  const {
    handlePointerDown: handleTiledPointerDown,
    handlePointerMove: handleTiledPointerMove,
    handlePointerUp: handleTiledPointerUp,
    handlePointerLeave: handleTiledPointerLeave,
  } = useCanvas({
    onPointerDown: (pos) => {
      const ctx = buildCtx();
      if (ctx) toolHandlerRef.current.onPointerDown(pos, ctx);
    },
    onPointerMove: (pos) => {
      const ctx = buildCtx();
      if (ctx) toolHandlerRef.current.onPointerMove(pos, ctx);
    },
    onPointerMoveBatch: (positions) => {
      const renderer = rendererRef.current;
      const ctx = buildCtx();
      if (!ctx || !renderer) return;
      renderer.deferFlush = true;
      const noopRender = (): void => {
        /* deferred */
      };
      for (const pos of positions) {
        toolHandlerRef.current.onPointerMove(pos, {
          ...ctx,
          render: noopRender,
        });
      }
      renderer.deferFlush = false;
      renderer.flushLayer(ctx.layer);
      ctx.render();
    },
    onPointerUp: (pos) => {
      const ctx = buildCtx();
      if (ctx) toolHandlerRef.current.onPointerUp(pos, ctx);
      newPixelLayerRef.current = null;
      const def = TOOL_REGISTRY[state.activeTool];
      if (def.modifiesPixels && !def.skipAutoHistory && ctx) {
        const label =
          state.activeTool.charAt(0).toUpperCase() + state.activeTool.slice(1);
        onStrokeEndRef.current?.(label);
      }
    },
    onHover: (pos) => {
      if (isActive) cursorStore.setPosition(pos.x, pos.y);
      const tool = state.activeTool;
      if (
        (tool === "brush" ||
          tool === "eraser" ||
          tool === "clone-stamp" ||
          tool === "dodge" ||
          tool === "burn" ||
          tool === "liquify" ||
          tool === "blur" ||
          tool === "sharpen" ||
          tool === "smudge" ||
          tool === "healing-brush" ||
          tool === "quick-select") &&
        brushCursorRef.current
      ) {
        const dpr = window.devicePixelRatio;
        const zoom = zoomRef.current;
        const size =
          tool === "brush"
            ? brushOptions.size
            : tool === "eraser"
              ? eraserOptions.size
              : tool === "dodge"
                ? dodgeOptions.size
                : tool === "burn"
                  ? burnOptions.size
                  : tool === "liquify"
                    ? liquifyOptions.size
                    : tool === "blur"
                      ? blurOptions.size
                      : tool === "sharpen"
                        ? sharpenOptions.size
                        : tool === "smudge"
                          ? smudgeOptions.size
                          : tool === "healing-brush"
                            ? healingBrushOptions.size
                            : tool === "quick-select"
                              ? quickSelectOptions.size
                              : cloneStampOptions.size;
        const r = Math.max(1, ((size / 2) * zoom) / dpr);
        // In tiled mode, coordinates are in [-W, 2W). Map to wrapper-space:
        const cx = ((pos.x + width) * zoom) / dpr;
        const cy = ((pos.y + height) * zoom) / dpr;
        const el = brushCursorRef.current;
        el.style.left = `${cx - r}px`;
        el.style.top = `${cy - r}px`;
        el.style.width = `${r * 2}px`;
        el.style.height = `${r * 2}px`;
        if (tool === "clone-stamp") {
          el.style.display = cloneStampStore.source ? "block" : "none";
          el.className = `${styles.brushCursor} ${styles.brushCursorCrossHair}`;
        } else {
          el.style.display = "block";
          el.className = styles.brushCursor;
        }
      }
      const ctx = buildCtx();
      if (ctx) toolHandlerRef.current.onHover?.(pos, ctx);
    },
    onLeave: () => {
      const ctx = buildCtx();
      if (ctx) toolHandlerRef.current.onLeave?.(ctx);
    },
    coordinateOffset: tiledOffset,
  });

  return (
    <>
      <div
        className={`${styles.canvasOuter}${state.canvas.showRulers ? ` ${styles.withRulers}` : ""}`}
      >
        {state.canvas.showRulers && (
          <>
            <div className={styles.rulerCorner} />
            <canvas ref={hRulerRef} className={styles.hRuler} />
            <canvas ref={vRulerRef} className={styles.vRuler} />
          </>
        )}
        <div
          ref={viewportRef}
          className={styles.viewport}
          data-canvas-viewport
          data-active-viewport={isActive ? "" : undefined}
        >
          <div
            className={styles.viewportInner}
            style={(() => {
              // In frame mode use cell dimensions as the logical canvas size so the
              // scroll area is bounded to the frame, not the full sprite sheet.
              const logW = frameClipInfo ? frameClipInfo.cellW : width;
              const logH = frameClipInfo ? frameClipInfo.cellH : height;
              const z = state.canvas.zoom / window.devicePixelRatio;
              return {
                width: `max(100%, ${3 * logW * z}px)`,
                height: `max(100%, ${3 * logH * z}px)`,
                // Clip absolutely-positioned canvasWrapper so it cannot widen the scroll area
                overflow: frameClipInfo ? "hidden" : undefined,
              };
            })()}
          >
            <div
              ref={canvasWrapperRef}
              className={styles.canvasWrapper}
              style={(() => {
                const z = state.canvas.zoom / window.devicePixelRatio;
                const w = (state.canvas.tiledMode ? 3 : 1) * width * z;
                const h = (state.canvas.tiledMode ? 3 : 1) * height * z;
                if (frameClipInfo) {
                  const { cellX, cellY, cellW, cellH } = frameClipInfo;
                  // Translate canvas so pixel (cellX, cellY) aligns with the scroll
                  // centre (padding = cellW/H on each side of viewportInner).
                  // clip-path hides every pixel outside the selected frame cell.
                  // Snap each value to whole device pixels — at fractional
                  // z (e.g. Retina DPR=2 at zoom=1 → z=0.5, or scroll-wheel
                  // zoom like 1.33), sub-pixel CSS edges anti-alias and let
                  // the row/column above-or-below the cell bleed in (visible
                  // as a 1-px halo on one frame and a 1-px shift on the next).
                  const dpr = window.devicePixelRatio;
                  const snap = (cssPx: number): number =>
                    Math.round(cssPx * dpr) / dpr;
                  const top = snap(cellY * z);
                  const right = snap((width - cellX - cellW) * z);
                  const bottom = snap((height - cellY - cellH) * z);
                  const left = snap(cellX * z);
                  return {
                    position: "absolute" as const,
                    left: snap((frameClipInfo.cellW - cellX) * z),
                    top: snap((frameClipInfo.cellH - cellY) * z),
                    width: w,
                    height: h,
                    clipPath: `inset(${top}px ${right}px ${bottom}px ${left}px)`,
                  };
                }
                return {
                  position: "absolute" as const,
                  left: `max(${width * z}px, calc(50% - ${(width * z) / 2}px))`,
                  top: `max(${height * z}px, calc(50% - ${(height * z) / 2}px))`,
                  width: w,
                  height: h,
                };
              })()}
            >
              <canvas
                ref={canvasRef}
                className={styles.canvas}
                width={backingW}
                height={backingH}
                style={{
                  display: state.canvas.tiledMode ? "none" : "block",
                  width: (width * state.canvas.zoom) / window.devicePixelRatio,
                  height:
                    (height * state.canvas.zoom) / window.devicePixelRatio,
                  cursor:
                    state.activeTool === "brush" ||
                    state.activeTool === "eraser" ||
                    state.activeTool === "dodge" ||
                    state.activeTool === "burn"
                      ? "none"
                      : state.activeTool === "pencil"
                        ? "none"
                        : state.activeTool === "polygonal-selection"
                          ? "crosshair"
                          : undefined,
                  // Bilinear when zoomed out (smooth downscale); nearest when at or above 100% (crisp pixel art)
                  imageRendering: state.canvas.zoom < 1 ? "auto" : "pixelated",
                }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerLeave}
                aria-label={`Canvas ${width}\u00d7${height}`}
              />
              {state.canvas.tiledMode && (
                <canvas
                  ref={tiledCanvasRef}
                  width={3 * width}
                  height={3 * height}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: "100%",
                    cursor:
                      state.activeTool === "brush" ||
                      state.activeTool === "eraser" ||
                      state.activeTool === "dodge" ||
                      state.activeTool === "burn"
                        ? "none"
                        : state.activeTool === "pencil"
                          ? "none"
                          : state.activeTool === "polygonal-selection"
                            ? "crosshair"
                            : undefined,
                    imageRendering:
                      state.canvas.zoom < 1 ? "auto" : "pixelated",
                    touchAction: "none",
                  }}
                  onPointerDown={handleTiledPointerDown}
                  onPointerMove={handleTiledPointerMove}
                  onPointerUp={handleTiledPointerUp}
                  onPointerLeave={handleTiledPointerLeave}
                />
              )}
              <canvas
                ref={toolOverlayRef}
                className={styles.overlay}
                width={width}
                height={height}
              />
              <div ref={brushCursorRef} className={styles.brushCursor} />
              <div
                ref={pixelBrushCursorRef}
                className={styles.pixelBrushCursor}
              />
              {/* Guide overlay */}
              {state.canvas.showGuides &&
                (() => {
                  const dpr = window.devicePixelRatio || 1;
                  const cssPxPerDocPx = state.canvas.zoom / dpr;
                  const allGuides = [
                    ...state.canvas.guides,
                    ...(dragPreview
                      ? [
                          {
                            id: "__preview__",
                            axis: dragPreview.axis,
                            position: dragPreview.position,
                          },
                        ]
                      : []),
                  ];
                  if (allGuides.length === 0) return null;
                  return (
                    <div className={styles.guideContainer}>
                      {allGuides.map((guide) => {
                        const isPreview = guide.id === "__preview__";
                        const px = guide.position * cssPxPerDocPx;
                        return (
                          <div
                            key={guide.id}
                            className={`${styles.guideHitArea} ${guide.axis === "h" ? styles.guideH : styles.guideV}${isPreview ? ` ${styles.guidePreview}` : ""}`}
                            style={
                              guide.axis === "h" ? { top: px } : { left: px }
                            }
                            onPointerDown={
                              !isPreview
                                ? (e) => startGuideDrag(e, guide.id, guide.axis)
                                : undefined
                            }
                          />
                        );
                      })}
                    </div>
                  );
                })()}
              {state.canvas.showGrid &&
                (() => {
                  const { gridType, gridColor, gridSize, zoom } = state.canvas;
                  const dpr = window.devicePixelRatio;
                  const cellPx = (gridSize * zoom) / dpr;

                  if (gridType === "normal") {
                    return (
                      <div
                        className={styles.gridOverlay}
                        style={
                          {
                            "--grid-size": `${cellPx}px`,
                            "--grid-color": gridColor,
                          } as React.CSSProperties
                        }
                      />
                    );
                  }

                  const svgStyle: React.CSSProperties = {
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: "100%",
                    pointerEvents: "none",
                    zIndex: 2,
                    overflow: "visible",
                  };
                  const stroke = gridColor;
                  const sw = Math.max(1, zoom / dpr);

                  if (gridType === "thirds") {
                    return (
                      <svg
                        style={svgStyle}
                        viewBox="0 0 100 100"
                        preserveAspectRatio="none"
                      >
                        <line
                          x1="33.333"
                          y1="0"
                          x2="33.333"
                          y2="100"
                          stroke={stroke}
                          strokeWidth={sw}
                          vectorEffect="non-scaling-stroke"
                        />
                        <line
                          x1="66.667"
                          y1="0"
                          x2="66.667"
                          y2="100"
                          stroke={stroke}
                          strokeWidth={sw}
                          vectorEffect="non-scaling-stroke"
                        />
                        <line
                          x1="0"
                          y1="33.333"
                          x2="100"
                          y2="33.333"
                          stroke={stroke}
                          strokeWidth={sw}
                          vectorEffect="non-scaling-stroke"
                        />
                        <line
                          x1="0"
                          y1="66.667"
                          x2="100"
                          y2="66.667"
                          stroke={stroke}
                          strokeWidth={sw}
                          vectorEffect="non-scaling-stroke"
                        />
                      </svg>
                    );
                  }

                  // safe-zone: action safe 80%, title safe 90%
                  return (
                    <svg
                      style={svgStyle}
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                    >
                      {/* Title safe – 90% */}
                      <rect
                        x="5"
                        y="5"
                        width="90"
                        height="90"
                        fill="none"
                        stroke={stroke}
                        strokeWidth={sw}
                        vectorEffect="non-scaling-stroke"
                      />
                      {/* Action safe – 80% */}
                      <rect
                        x="10"
                        y="10"
                        width="80"
                        height="80"
                        fill="none"
                        stroke={stroke}
                        strokeWidth={sw}
                        strokeDasharray="4 3"
                        vectorEffect="non-scaling-stroke"
                      />
                      {/* Centre crosshair */}
                      <line
                        x1="49"
                        y1="50"
                        x2="51"
                        y2="50"
                        stroke={stroke}
                        strokeWidth={sw}
                        vectorEffect="non-scaling-stroke"
                      />
                      <line
                        x1="50"
                        y1="49"
                        x2="50"
                        y2="51"
                        stroke={stroke}
                        strokeWidth={sw}
                        vectorEffect="non-scaling-stroke"
                      />
                    </svg>
                  );
                })()}
            </div>
          </div>
          {/* Marching-ants overlay: viewport-sized, screen-space, never scrolls */}
          <canvas ref={overlayRef} className={styles.antsOverlay} />
        </div>
      </div>
      <TextLayerEditor
        editingLayerId={editingLayerId}
        layers={state.layers}
        zoom={state.canvas.zoom}
        canvasWrapperRef={canvasWrapperRef}
        onCommit={(ls) => dispatch({ type: "UPDATE_TEXT_LAYER", payload: ls })}
        onClose={() => {
          // If the layer being closed is empty (never typed into), destroy it.
          const closingLayer = state.layers.find(
            (l) => "type" in l && l.type === "text" && l.id === editingLayerId,
          );
          if (
            closingLayer &&
            "text" in closingLayer &&
            closingLayer.text.trim() === ""
          ) {
            dispatch({ type: "REMOVE_LAYER", payload: editingLayerId! });
          } else {
            onStrokeEndRef.current?.("Text");
          }
          setEditingLayerId(null);
        }}
      />
    </>
  );
});
