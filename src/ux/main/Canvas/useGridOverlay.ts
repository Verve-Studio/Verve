import { useEffect } from "react";

export interface GridOverlayParams {
  /** Draw the normal (square-cell) grid. */
  enabled: boolean;
  overlayRef: React.RefObject<HTMLCanvasElement | null>;
  viewportRef: React.RefObject<HTMLElement | null>;
  canvasWrapperRef: React.RefObject<HTMLElement | null>;
  /** Device pixels per image pixel. */
  zoom: number;
  /** Cell size in image pixels. */
  gridSize: number;
  gridColor: string;
  /** Document size. */
  width: number;
  height: number;
  tiledMode: boolean;
  /** Animation frame mode: only the selected cell is shown. */
  frameClip: { cellX: number; cellY: number; cellW: number; cellH: number } | null;
}

/** Below this line spacing (device px) the grid would be a solid wash. */
const MIN_SPACING = 4;

/**
 * The normal grid, drawn on a viewport-sized, screen-space canvas.
 *
 * A repeating CSS background can't align with image pixels: its tile is
 * `gridSize × zoom / dpr` CSS px — almost always fractional — and the browser
 * rounds each tile to device pixels, so lines drift off the pixel edges
 * across the canvas. Here every line is placed at its own image-pixel
 * boundary (`canvasLeft + k·gridSize·zoom`, rounded to a device pixel), the
 * same rounding the pixel edges themselves land on, and stays 1 device px
 * wide at any zoom. Only visible lines are drawn; redraws happen on scroll,
 * viewport resize and grid / zoom changes, coalesced to one per frame.
 */
export function useGridOverlay({
  enabled,
  overlayRef,
  viewportRef,
  canvasWrapperRef,
  zoom,
  gridSize,
  gridColor,
  width,
  height,
  tiledMode,
  frameClip,
}: GridOverlayParams): void {
  const clipX = frameClip?.cellX;
  const clipY = frameClip?.cellY;
  const clipW = frameClip?.cellW;
  const clipH = frameClip?.cellH;

  useEffect(() => {
    const overlay = overlayRef.current;
    const viewport = viewportRef.current;
    if (!overlay || !viewport) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;

    if (!enabled) {
      overlay.style.display = "none";
      return;
    }
    overlay.style.display = "";

    let raf = 0;
    const draw = (): void => {
      raf = 0;
      const wrapper = canvasWrapperRef.current;
      if (!wrapper) return;
      const dpr = window.devicePixelRatio || 1;
      const vw = Math.round(viewport.clientWidth * dpr);
      const vh = Math.round(viewport.clientHeight * dpr);
      if (overlay.width !== vw || overlay.height !== vh) {
        overlay.width = vw;
        overlay.height = vh;
      }
      // Pin to the viewport in screen space (it's a child of the scroller).
      overlay.style.transform = `translate(${viewport.scrollLeft}px, ${viewport.scrollTop}px)`;
      ctx.clearRect(0, 0, vw, vh);

      const step = gridSize * zoom; // device px between lines
      if (!(gridSize > 0) || step < MIN_SPACING) return;

      // Image origin in overlay device pixels.
      const vRect = viewport.getBoundingClientRect();
      const wRect = wrapper.getBoundingClientRect();
      const ox = (wRect.left - vRect.left) * dpr;
      const oy = (wRect.top - vRect.top) * dpr;

      // Image-space extent the grid covers.
      const factor = tiledMode ? 3 : 1;
      let ix0 = 0;
      let iy0 = 0;
      let ix1 = width * factor;
      let iy1 = height * factor;
      if (clipX !== undefined && clipY !== undefined && clipW !== undefined && clipH !== undefined) {
        ix0 = clipX;
        iy0 = clipY;
        ix1 = clipX + clipW;
        iy1 = clipY + clipH;
      }
      const dev = (o: number, i: number): number => Math.round(o + i * zoom);
      const left = Math.max(0, dev(ox, ix0));
      const top = Math.max(0, dev(oy, iy0));
      const right = Math.min(vw, dev(ox, ix1));
      const bottom = Math.min(vh, dev(oy, iy1));
      if (right <= left || bottom <= top) return;

      ctx.fillStyle = gridColor;
      // Lines sit on multiples of gridSize from the image origin (like the
      // old CSS grid, whose first line was at image x = 0).
      const kx0 = Math.max(Math.ceil(ix0 / gridSize), Math.ceil((left - ox) / step));
      const kx1 = Math.min(Math.floor(ix1 / gridSize), Math.floor((right - ox) / step));
      for (let k = kx0; k <= kx1; k++) {
        const x = dev(ox, k * gridSize);
        if (x >= left && x < right) ctx.fillRect(x, top, 1, bottom - top);
      }
      const ky0 = Math.max(Math.ceil(iy0 / gridSize), Math.ceil((top - oy) / step));
      const ky1 = Math.min(Math.floor(iy1 / gridSize), Math.floor((bottom - oy) / step));
      for (let k = ky0; k <= ky1; k++) {
        const y = dev(oy, k * gridSize);
        if (y >= top && y < bottom) ctx.fillRect(left, y, right - left, 1);
      }
    };
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    // Draw after layout settles (a zoom change re-lays out the wrapper and
    // may adjust the scroll position in the same frame).
    schedule();
    viewport.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(viewport);
    const wrapper = canvasWrapperRef.current;
    if (wrapper) ro.observe(wrapper);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      viewport.removeEventListener("scroll", schedule);
      ro.disconnect();
    };
  }, [
    enabled,
    overlayRef,
    viewportRef,
    canvasWrapperRef,
    zoom,
    gridSize,
    gridColor,
    width,
    height,
    tiledMode,
    clipX,
    clipY,
    clipW,
    clipH,
  ]);
}
