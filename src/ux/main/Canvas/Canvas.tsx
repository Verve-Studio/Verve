import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useWebGPU } from "@/core/services/useWebGPU";
import {
  shallowEqual,
  useAppStore,
  useAppSelector,
} from "@/core/store/AppContext";
import { useCanvasContext } from "@/core/store/CanvasContext";
import type {
  GpuLayer,
  RenderPlanEntry,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import type { MaskLayerState, TextLayerState } from "@/types";
import { TextLayerEditor } from "./TextLayerEditor";
import { useCanvasHandle } from "./canvasHandle";
import type { CanvasHandle } from "./canvasHandle";
import { buildRenderPlan as buildCanvasRenderPlan } from "./canvasPlan";
import { useMarchingAnts } from "./useMarchingAnts";
import { useGridOverlay } from "./useGridOverlay";
import { useScrollZoom } from "./useScrollZoom";
import { useSpacePan } from "./useSpacePan";
import { useRulers } from "./useRulers";
import { useGuides } from "./useGuides";
import { useBrushCursor } from "@/core/services/useBrushCursor";
import { useCursorPixelInfo } from "@/core/services/useCursorPixelInfo";
import { useToolOverlayDrawing } from "@/core/services/useToolOverlayDrawing";
import { useIndexedSwatchSync } from "@/core/services/useIndexedSwatchSync";
import { useCanvasRenderLoop } from "@/core/services/useCanvasRenderLoop";
import { useCanvasViewport } from "@/core/services/useCanvasViewport";
import { useToolHandler } from "@/core/services/useToolHandler";
import { useToolContext } from "@/core/services/useToolContext";
import { useCanvasPointerInput } from "@/core/services/useCanvasPointerInput";
import { useGpuLayerInit } from "@/core/services/useGpuLayerInit";
import { useGpuLayerSync } from "@/core/services/useGpuLayerSync";
import { measureStore } from "@/core/tools/Measure/measureStore";
import { activeScope } from "@/core/store/scope";
import { selectionRevision } from "@/core/store/selectionStore";
import { rasterizeTextToLayer } from "./textRasterizer";
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

/** Cap on the thumbnail mirror canvas's longest side. */
const MIRROR_MAX_DIM = 512;

export const Canvas = memo(
  forwardRef<CanvasHandle, CanvasProps>(function Canvas(
  { width, height, initialLayerData, onStrokeEnd, onReady, isActive = true },
  ref,
) {
  // Everything the canvas view renders from — but not the colours: a
  // colour-picker / eyedropper drag must not re-render the canvas. Tools
  // read live state (colours included) per pointer event via getState.
  const store = useAppStore();
  const dispatch = store.dispatch;
  const state = useAppSelector(
    (s) => ({
      activeLayerId: s.activeLayerId,
      activeTool: s.activeTool,
      animationMode: s.animationMode,
      canvas: s.canvas,
      lastRemovedSwatchIndex: s.lastRemovedSwatchIndex,
      layers: s.layers,
      pixelFormat: s.pixelFormat,
      spritesheet: s.spritesheet,
      swatches: s.swatches,
    }),
    shallowEqual,
  );
  const getPrimaryColor = useCallback(
    () => store.getState().primaryColor,
    [store],
  );
  const { canvasElRef, thumbnailCanvasRef } = useCanvasContext();
  const { canvasRef, rendererRef, rendererVersion } = useWebGPU({
    pixelWidth: width,
    pixelHeight: height,
    pixelFormat: state.pixelFormat,
  });

  // ── Refs ──────────────────────────────────────────────────────────────────
  const glLayersRef = useRef<Map<string, GpuLayer>>(new Map());
  const adjustmentMaskMap = useRef<Map<string, GpuLayer>>(new Map());
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const scrollPosRef = useRef({ left: 0, top: 0 });
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const gridOverlayRef = useRef<HTMLCanvasElement>(null);
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
  const layersStateRef = useRef(state.layers);
  layersStateRef.current = state.layers;
  const swatchesRef = useRef(state.swatches);
  swatchesRef.current = state.swatches;
  const pixelFormatRef = useRef(state.pixelFormat);
  pixelFormatRef.current = state.pixelFormat;
  const onStrokeEndRef = useRef(onStrokeEnd);
  onStrokeEndRef.current = onStrokeEnd;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // Inline text-layer editor state — kept as React state because
  // `TextLayerEditor` re-renders when it changes.
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const textOpenAtRef = useRef<{ x: number; y: number } | null>(null);
  const openTextEditor = useCallback(
    (id: string, at?: { x: number; y: number }) => {
      textOpenAtRef.current = at ?? null;
      setEditingLayerId(id);
    },
    [],
  );


  // ── Canvas backing-buffer sizing ──────────────────────────────────────────
  // At a 7016×9933 document we write `backingW * backingH * 4` bytes to the
  // swapchain every frame — 278 MB just for the screen blit. When zoom < 1
  // the document is being downscaled for display, so we size the swapchain
  // to the actually-displayed pixel count and let the GPU downsample once
  // during the blit. Cost shrinks proportionally to zoom².
  //
  // At zoom ≥ 1 we keep the swapchain at document resolution; the browser's
  // compositor upscales (cheap, and we want crisp pixel-doubling at integer
  // zooms). Tiled mode reads the backing buffer for the 9-tile blit, so it
  // requires document size regardless.
  const displayScale = state.canvas.tiledMode
    ? 1
    : Math.min(state.canvas.zoom, 1);
  const backingW = Math.max(1, Math.round(width * displayScale));
  const backingH = Math.max(1, Math.round(height * displayScale));

  // ── Thumbnail mirror canvas ───────────────────────────────────────────────
  // A plain 2D canvas kept in sync with the WebGPU output so Navigator (and
  // any other panel) can read pixel content without touching the WebGPU
  // canvas directly (which can cause GPU-process crashes in Electron when
  // a cross-context read is attempted). createImageBitmap downscales to
  // MIRROR_MAX_DIM in GPU memory before the CPU readback — turning an
  // 84 MB readback at 7000×3000 into ~450 KB.
  const mirrorScale = Math.min(1, MIRROR_MAX_DIM / Math.max(width, height));
  const mirrorW = Math.max(1, Math.round(width * mirrorScale));
  const mirrorH = Math.max(1, Math.round(height * mirrorScale));
  useEffect(() => {
    const mirror = document.createElement("canvas");
    mirror.width = mirrorW;
    mirror.height = mirrorH;
    // Force-allocate the 2D backing store. Navigator's RAF loop reads the
    // mirror via drawImage every frame; without this, the first reads
    // (before scheduleMirrorUpdate has populated the mirror) hit an
    // uninitialized SharedImage and Chromium logs GL_INVALID_OPERATION.
    mirror.getContext("2d")?.clearRect(0, 0, mirrorW, mirrorH);
    thumbnailCanvasRef.current = mirror;
    return () => {
      thumbnailCanvasRef.current = null;
    };
  }, [mirrorW, mirrorH, thumbnailCanvasRef]);

  // ── Frame-clip info: drives layout + clip in animation mode ───────────────
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

  // ── Selection anchor (passed to useScrollZoom) ────────────────────────────
  // When a selection is active, zoom towards its centroid (Photoshop
  // behaviour). Computed lazily — only called when the user actually
  // ctrl-scrolls; rebuilds each call so we always see the current mask.
  const getSelectionAnchorRef = useRef<
    (() => { x: number; y: number } | null) | null
  >(null);
  // Cached per (mask, selectionRevision): Ctrl+wheel / pinch zoom asks for
  // this on every event, and each call used to scan the whole mask.
  const selectionAnchorCache = useRef<{
    mask: Uint8Array;
    rev: number;
    anchor: { x: number; y: number } | null;
  } | null>(null);
  getSelectionAnchorRef.current = (): { x: number; y: number } | null => {
    const mask = activeScope().selection.mask;
    if (!mask) return null;
    const cached = selectionAnchorCache.current;
    if (cached && cached.mask === mask && cached.rev === selectionRevision) {
      return cached.anchor;
    }
    const anchor = computeSelectionAnchor(mask);
    selectionAnchorCache.current = { mask, rev: selectionRevision, anchor };
    return anchor;
  };
  const computeSelectionAnchor = (
    mask: Uint8Array,
  ): { x: number; y: number } | null => {
    const sw = activeScope().selection.width;
    const sh = activeScope().selection.height;
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
    return { x: (lx + rx) / 2, y: (ly + ry) / 2 };
  };

  // ── Plan / mask-map builders ──────────────────────────────────────────────
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
    // Exclude mask + adjustment layers — masks applied via buildMaskMap,
    // adjustments via renderPlan.
    const layers = state.layers
      .filter(
        (ls) =>
          !("type" in ls && (ls.type === "mask" || ls.type === "adjustment")),
      )
      .map((ls) => map.get(ls.id))
      .filter((l): l is GpuLayer => !!l);
    return layers;
  }

  function buildRenderPlan(
    bypassedAdjustmentIds: ReadonlySet<string> = activeScope().adjustmentPreview.snapshot(),
  ): RenderPlanEntry[] {
    const plan = buildCanvasRenderPlan(
      layersStateRef.current,
      glLayersRef.current,
      buildMaskMap(),
      adjustmentMaskMap.current,
      bypassedAdjustmentIds,
      state.swatches,
      state.pixelFormat,
    );
    return plan;
  }

  /**
   * Plan for flatten / export / merge output. Unlike the screen plan it
   * ignores adjustment preview-bypass toggles. (A text layer mid-edit is
   * already current: the editor rasterises its draft on every change.)
   */
  function buildOutputPlan(): RenderPlanEntry[] {
    return buildRenderPlan(new Set());
  }

  // useCanvasRenderLoop captures the plan builder via a ref so its doRender
  // always invokes the freshest closure (which closes over `state`).
  const buildRenderPlanRef = useRef(buildRenderPlan);
  buildRenderPlanRef.current = buildRenderPlan;

  // ── Render loop ───────────────────────────────────────────────────────────
  const { doRender, doRenderRef } = useCanvasRenderLoop({
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
    tiledMode: state.canvas.tiledMode,
    showTileGrid: state.canvas.showTileGrid,
    isActive,
    buildRenderPlanRef,
  });

  // ── Imperative handle for save / export / clipboard ───────────────────────
  useCanvasHandle({
    ref,
    rendererRef,
    glLayersRef,
    adjustmentMaskMap,
    layersStateRef,
    swatchesRef,
    pixelFormatRef,
    buildRenderArgs: () => ({
      layers: buildOrderedGLLayers(),
      maskMap: buildMaskMap(),
      plan: buildRenderPlan(),
    }),
    buildOutputPlan,
    width,
    height,
    viewportRef,
    pendingScrollRef,
    onZoom: (zoom) => dispatch({ type: "SET_ZOOM", payload: zoom }),
    tiledMode: state.canvas.tiledMode,
    requestRender: doRender,
  });

  // ── Existing canvas-local helpers ─────────────────────────────────────────
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
  useMarchingAnts(
    isActive,
    overlayRef,
    viewportRef,
    canvasWrapperRef,
    zoomRef,
    activeToolRef,
  );
  useGridOverlay({
    enabled:
      isActive && state.canvas.showGrid && state.canvas.gridType === "normal",
    overlayRef: gridOverlayRef,
    viewportRef,
    canvasWrapperRef,
    zoom: state.canvas.zoom,
    gridSize: state.canvas.gridSize,
    gridColor: state.canvas.gridColor,
    width,
    height,
    tiledMode: state.canvas.tiledMode,
    frameClip: frameClipInfo,
  });
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

  // ── Viewport-level effects (centring, fit, scroll re-render, …) ───────────
  useCanvasViewport({
    isActive,
    viewportRef,
    rendererRef,
    width,
    height,
    zoomRef,
    scrollPosRef,
    tiledMode: state.canvas.tiledMode,
    showTileGrid: state.canvas.showTileGrid,
    frameClipInfo,
    dispatch,
    doRenderRef,
  });

  // Init selection store dimensions once canvas is sized
  useEffect(() => {
    if (!isActive) return;
    activeScope().selection.setDimensions(width, height);
    return () => {
      activeScope().selection.clear();
      measureStore.clear();
    };
  }, [width, height, isActive]);

  // Publish canvas element into shared context (active canvas only)
  useEffect(() => {
    if (!isActive) return;
    canvasElRef.current = canvasRef.current;
  });

  // ── GPU layer init + sync ─────────────────────────────────────────────────
  useGpuLayerInit({
    rendererRef,
    rendererVersion,
    isActiveRef,
    glLayersRef,
    adjustmentMaskMapRef: adjustmentMaskMap,
    swatchesRef,
    initialLayers: state.layers,
    initialPixelFormat: state.pixelFormat,
    initialBackgroundFill: state.canvas.backgroundFill,
    initialLayerData,
    doRender,
    onReadyRef,
  });
  useGpuLayerSync({
    isActive,
    rendererRef,
    glLayersRef,
    adjustmentMaskMapRef: adjustmentMaskMap,
    layers: state.layers,
    swatches: state.swatches,
    pixelFormat: state.pixelFormat,
    activeTool: state.activeTool,
    doRender,
    editingTextLayerId: editingLayerId,
  });

  // ── Inline text editing ───────────────────────────────────────────────────
  // The layer itself shows the text being edited (effects, blend mode and
  // stacking stay live): each draft change re-rasterises only the region the
  // text covers. The store receives the text on typing pauses and on close.
  const renderTextDraft = useCallback(
    (ls: TextLayerState) => {
      const renderer = rendererRef.current;
      const gl = glLayersRef.current.get(ls.id);
      if (!renderer || !gl) return;
      gl.offsetX = 0;
      gl.offsetY = 0;
      rasterizeTextToLayer(ls, gl, renderer);
      doRenderRef.current();
    },
    [rendererRef, doRenderRef],
  );
  const commitTextDraft = useCallback(
    (ls: TextLayerState) => dispatch({ type: "UPDATE_TEXT_LAYER", payload: ls }),
    [dispatch],
  );
  const closeTextEditor = useCallback(
    (final: TextLayerState, initial: TextLayerState) => {
      setEditingLayerId(null);
      const current = store
        .getState()
        .layers.find((l) => l.id === final.id);
      if (!current || !("type" in current) || current.type !== "text") return;
      if (final.text.trim() === "") {
        // Emptied text removes the layer; only a layer that had content
        // before this session gets a history entry for it.
        dispatch({ type: "REMOVE_LAYER", payload: final.id });
        if (initial.text.trim() !== "") onStrokeEndRef.current?.("Text");
        return;
      }
      const next = {
        ...current,
        text: final.text,
        x: final.x,
        y: final.y,
        boxWidth: final.boxWidth,
        boxHeight: final.boxHeight,
      };
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        dispatch({ type: "UPDATE_TEXT_LAYER", payload: next });
      }
      // Clicking into text and out again is not an edit.
      if (JSON.stringify(next) !== JSON.stringify(initial)) {
        onStrokeEndRef.current?.("Text");
      }
    },
    [store, dispatch],
  );
  const onTextEditorLost = useCallback(() => setEditingLayerId(null), []);

  // ── Indexed8 palette housekeeping ─────────────────────────────────────────
  useIndexedSwatchSync({
    isActive,
    pixelFormat: state.pixelFormat,
    swatches: state.swatches,
    lastRemovedSwatchIndex: state.lastRemovedSwatchIndex,
    rendererRef,
    glLayersRef,
    dispatch,
    doRender,
  });

  // ── Per-tool overlay subscriptions (transform / clone / poly / object) ────
  useToolOverlayDrawing({
    isActive,
    activeTool: state.activeTool,
    toolOverlayRef,
    canvasRef,
    zoomRef,
  });

  // ── Tool input wiring ─────────────────────────────────────────────────────
  const { toolHandlerRef } = useToolHandler({
    isActive,
    activeTool: state.activeTool,
    brushCursorRef,
    pixelBrushCursorRef,
    brushCursorBaseClass: styles.brushCursor,
  });

  const brushCursorApi = useBrushCursor({
    brushCursorRef,
    pixelBrushCursorRef,
    canvasRef,
    zoomRef,
    activeTool: state.activeTool,
    getPrimaryColor,
    width,
    height,
    baseClass: styles.brushCursor,
    crossHairClass: styles.brushCursorCrossHair,
  });

  const updatePixelInfo = useCursorPixelInfo({
    pixelFormat: state.pixelFormat,
    activeLayerId: state.activeLayerId,
    rendererRef,
    glLayersRef,
    swatchesRef,
  });

  const buildCtx = useToolContext({
    getState: store.getState,
    dispatch,
    rendererRef,
    glLayersRef,
    toolOverlayRef,
    canvasRef,
    viewportRef,
    pendingScrollRef,
    swatchesRef,
    width,
    height,
    buildMaskMap,
    buildOrderedGLLayers,
    buildOutputPlan,
    doRender,
    onStrokeEndRef,
    openTextEditor,
  });

  const { main: mainInput, tiled: tiledInput } = useCanvasPointerInput({
    isActive,
    width,
    height,
    activeTool: state.activeTool,
    activeLayerId: state.activeLayerId,
    toolHandlerRef,
    rendererRef,
    buildCtx,
    onStrokeEndRef,
    brushCursorApi,
    updatePixelInfo,
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
              // In frame mode use cell dimensions as the logical canvas size
              // so the scroll area is bounded to the frame, not the full
              // sprite sheet.
              const logW = frameClipInfo ? frameClipInfo.cellW : width;
              const logH = frameClipInfo ? frameClipInfo.cellH : height;
              const z = state.canvas.zoom / window.devicePixelRatio;
              // Inner = 3× the rendered content, mirroring normal mode. Tiled
              // mode's rendered content is the 3×3 grid, so the inner becomes
              // 9× canvas — same proportional padding.
              const tileFactor = state.canvas.tiledMode ? 3 : 1;
              return {
                width: `max(100%, ${3 * tileFactor * logW * z}px)`,
                height: `max(100%, ${3 * tileFactor * logH * z}px)`,
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
                  // Translate canvas so pixel (cellX, cellY) aligns with the
                  // scroll centre (padding = cellW/H on each side of
                  // viewportInner). clip-path hides every pixel outside the
                  // selected frame cell. Snap each value to whole device
                  // pixels — at fractional z (e.g. Retina DPR=2 at zoom=1
                  // → z=0.5, or scroll-wheel zoom like 1.33), sub-pixel CSS
                  // edges anti-alias and let the row/column above-or-below
                  // the cell bleed in (visible as a 1-px halo).
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
                  left: `max(${w}px, calc(50% - ${w / 2}px))`,
                  top: `max(${h}px, calc(50% - ${h / 2}px))`,
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
                          : state.activeTool === "text"
                            ? "text"
                            : undefined,
                  // Bilinear when zoomed out (smooth downscale); nearest when
                  // at or above 100% (crisp pixel art).
                  imageRendering: state.canvas.zoom < 1 ? "auto" : "pixelated",
                }}
                onPointerDown={mainInput.handlePointerDown}
                onPointerMove={mainInput.handlePointerMove}
                onPointerUp={mainInput.handlePointerUp}
                onPointerLeave={mainInput.handlePointerLeave}
                onPointerCancel={mainInput.handlePointerCancel}
                onLostPointerCapture={mainInput.handlePointerCancel}
                aria-label={`Canvas ${width}×${height}`}
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
                  onPointerDown={tiledInput.handlePointerDown}
                  onPointerMove={tiledInput.handlePointerMove}
                  onPointerUp={tiledInput.handlePointerUp}
                  onPointerLeave={tiledInput.handlePointerLeave}
                  onPointerCancel={tiledInput.handlePointerCancel}
                  onLostPointerCapture={tiledInput.handlePointerCancel}
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
                  const { gridType, gridColor, zoom } = state.canvas;
                  const dpr = window.devicePixelRatio;
                  // The normal grid is drawn pixel-aligned in screen space
                  // by useGridOverlay (gridOverlayRef below).
                  if (gridType === "normal") return null;

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
          {/* Normal grid: viewport-sized, screen-space, pixel-aligned */}
          <canvas ref={gridOverlayRef} className={styles.gridCanvas} />
          {/* Marching-ants overlay: viewport-sized, screen-space, never scrolls */}
          <canvas ref={overlayRef} className={styles.antsOverlay} />
        </div>
      </div>
      <TextLayerEditor
        editingLayerId={editingLayerId}
        openAt={textOpenAtRef.current}
        active={isActive}
        layers={state.layers}
        zoom={state.canvas.zoom}
        canvasWrapperRef={canvasWrapperRef}
        renderDraft={renderTextDraft}
        commitDraft={commitTextDraft}
        onClose={closeTextEditor}
        onLost={onTextEditorLost}
      />
    </>
  );
}),
);
