/**
 * Viewport + re-render trigger effects for the canvas component.
 *
 * Five concerns, all gated on `isActive`:
 *
 *   1. **One-shot centering on mount.** When this tab first becomes active
 *      we centre the document inside the viewport (3× canvas-padded layout
 *      means the document sits at 1.5× pad on both axes).
 *   2. **Animation-mode fit-to-cell.** When the user enters animation mode
 *      (or switches frame), pick a zoom that fits the selected cell with
 *      a 5% margin and centre the scroll on it.
 *   3. **Tiled-mode auto-centre.** Toggling on tiled mode pans the
 *      viewport so the middle (un-shifted) tile is centred.
 *   4. **Viewport scroll re-render.** The GPU blit is scissored to the
 *      visible portion of the backing buffer — newly-revealed regions
 *      after a scroll would otherwise show stale pixels.
 *   5. **HDR display-store + adjustment-preview re-render triggers** + the
 *      tiled-mode toggle / showTileGrid re-render.
 *
 * The hook owns no state of its own beyond a `centeredOnceRef` flag.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { AppAction } from "@/core/store/AppContext";
import { activeScope } from "@/core/store/scope";
import { displayStore } from "@/ux/main/Canvas/displayStore";
import type { WebGPURenderer } from "@/graphics/webgpu/rendering/WebGPURenderer";

export interface CanvasViewportParams {
  isActive: boolean;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  rendererRef: React.RefObject<WebGPURenderer | null>;
  /** Document size — used for centering math. In animation mode, prefer
   *  `frameClipInfo.cellW/cellH` here so the centre lands on the cell. */
  width: number;
  height: number;
  zoomRef: React.RefObject<number>;
  scrollPosRef: React.RefObject<{ left: number; top: number }>;
  tiledMode: boolean;
  showTileGrid: boolean;
  /** Non-null when the doc is in animation mode and a spritesheet cell is
   *  selected; drives the fit-to-cell effect. */
  frameClipInfo: {
    cellX: number;
    cellY: number;
    cellW: number;
    cellH: number;
  } | null;
  dispatch: React.Dispatch<AppAction>;
  /** Latest `doRender` closure ref from useCanvasRenderLoop. */
  doRenderRef: React.RefObject<() => void>;
}

export function useCanvasViewport(params: CanvasViewportParams): void {
  const {
    isActive,
    viewportRef,
    rendererRef,
    width,
    height,
    zoomRef,
    scrollPosRef,
    tiledMode,
    showTileGrid,
    frameClipInfo,
    dispatch,
    doRenderRef,
  } = params;

  // ── One-shot centering ────────────────────────────────────────────────────
  // useLayoutEffect so we win the first paint against useScrollZoom's
  // restore effect (declaration order matters).
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
    // padding = padW (left/right) + padH (top/bottom); logical-canvas
    // centre at 1.5×pad.
    const left = padW + padW / 2 - vp.clientWidth / 2;
    const top = padH + padH / 2 - vp.clientHeight / 2;
    vp.scrollLeft = Math.max(0, left);
    vp.scrollTop = Math.max(0, top);
    scrollPosRef.current = { left: vp.scrollLeft, top: vp.scrollTop };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Animation-mode fit-to-cell ────────────────────────────────────────────
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

  // ── Tiled-mode auto-centre ────────────────────────────────────────────────
  useEffect(() => {
    if (!isActive || !tiledMode) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const dpr = window.devicePixelRatio;
    const zoom = zoomRef.current;
    const z = zoom / dpr;
    // Wrapper sits at left = 3W in tiled mode (= its own width) so the
    // middle tile starts at 3W + W = 4W. Centre that tile in the viewport.
    const tileW = width * z;
    const tileH = height * z;
    viewport.scrollLeft = 4 * tileW + tileW / 2 - viewport.clientWidth / 2;
    viewport.scrollTop = 4 * tileH + tileH / 2 - viewport.clientHeight / 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiledMode, isActive]);

  // ── Re-render on viewport scroll ──────────────────────────────────────────
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

  // ── Re-render on HDR display change (EV, tone-mapping operator) ───────────
  useEffect(() => {
    if (!isActive) return;
    const onDisplayChange = (): void => {
      doRenderRef.current();
    };
    displayStore.subscribe(onDisplayChange);
    return () => displayStore.unsubscribe(onDisplayChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // ── Re-render on adjustment-preview snapshot change ───────────────────────
  useEffect(() => {
    if (!isActive) return;
    const unsubscribe = activeScope().adjustmentPreview.subscribe(() => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      doRenderRef.current();
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // ── Tiled toggle + grid toggle re-render ──────────────────────────────────
  // Toggling tiled mode doesn't change the render plan (the renderer doesn't
  // know about tiled mode), so without a dirty marker `renderPlan()` would
  // early-return on fingerprint match and the GPU canvas would still hold
  // its prior-frame content. The tiled-overlay path below then
  // `drawImage(gc, …)`s a stale/blank backing into the overlay until the
  // next plan-changing event. Mark viewport-dirty so the executor re-blits
  // the stable composite into the swap chain before the overlay copy.
  useEffect(() => {
    if (!isActive) return;
    rendererRef.current?.markViewportDirty();
    doRenderRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiledMode, showTileGrid, isActive]);
}
