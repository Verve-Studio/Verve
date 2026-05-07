import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Manages zoom-to-cursor (Ctrl+scroll) and scroll-position save/restore.
 *
 * The viewport-inner div has inline padding = canvasHeight (top/bottom) and
 * canvasWidth (left/right) in CSS px, so the canvas is always at scroll offset
 * (paddingLeft, paddingTop) and the viewport is always scrollable at any zoom.
 *
 * With this layout the padding terms cancel in the zoom formulas, leaving:
 *   scrollLeft' = (scrollLeft + anchorX) * r - anchorX   (r = newZoom/oldZoom)
 *
 * @param canvasWidth   Image pixel width  (used for selection-centroid repositioning)
 * @param canvasHeight  Image pixel height (used for selection-centroid repositioning)
 * @param getSelectionAnchorRef  Returns selection centroid in image-pixel space, or null.
 */
export function useScrollZoom(
  isActive: boolean,
  isActiveRef: React.RefObject<boolean>,
  viewportRef: React.RefObject<HTMLDivElement | null>,
  zoomRef: React.RefObject<number>,
  pendingScrollRef: React.MutableRefObject<{
    scrollLeft: number;
    scrollTop: number;
  } | null>,
  scrollPosRef: React.MutableRefObject<{ left: number; top: number }>,
  zoom: number,
  onZoom: (zoom: number) => void,
  canvasWidth: number,
  canvasHeight: number,
  getSelectionAnchorRef?: React.RefObject<
    (() => { x: number; y: number } | null) | null
  >,
): void {
  const prevZoomRef = useRef(zoom);
  // Keep canvas dims accessible in layout effects without stale closures.
  const canvasWidthRef = useRef(canvasWidth);
  canvasWidthRef.current = canvasWidth;
  const canvasHeightRef = useRef(canvasHeight);
  canvasHeightRef.current = canvasHeight;

  // Ctrl+scroll → zoom to selection centroid (if active) or cursor position
  useEffect(() => {
    if (!isActive) return;
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const oldZoom = zoomRef.current!;
      const dpr = window.devicePixelRatio;
      // Smooth on trackpad (pixel deltaMode), fixed step on mouse wheel
      const factor =
        e.deltaMode === 0
          ? Math.pow(0.998, e.deltaY)
          : e.deltaY < 0
            ? 1.25
            : 0.8;
      const newZoom = parseFloat(
        Math.min(32, Math.max(0.05, oldZoom * factor)).toFixed(4),
      );
      const r = newZoom / oldZoom;
      // Anchor: selection centroid (in viewport CSS-px) when available, else cursor.
      // With padding = canvasSize*zoom/dpr on each side, the VIEWPORT_PADDING terms
      // cancel: scrollLeft' = (scrollLeft + anchorX) * r - anchorX
      const anchor = getSelectionAnchorRef?.current?.();
      const anchorX = anchor
        ? (canvasWidthRef.current * oldZoom) / dpr +
          (anchor.x * oldZoom) / dpr -
          vp.scrollLeft
        : e.clientX - rect.left;
      const anchorY = anchor
        ? (canvasHeightRef.current * oldZoom) / dpr +
          (anchor.y * oldZoom) / dpr -
          vp.scrollTop
        : e.clientY - rect.top;
      pendingScrollRef.current = {
        scrollLeft: (vp.scrollLeft + anchorX) * r - anchorX,
        scrollTop: (vp.scrollTop + anchorY) * r - anchorY,
      };
      onZoom(newZoom);
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Continuously track scroll position — only while active so browser-triggered
  // scroll resets (on visibility change) don't overwrite the saved position.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onScroll = (): void => {
      if (isActiveRef.current) {
        scrollPosRef.current = { left: vp.scrollLeft, top: vp.scrollTop };
      }
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore scroll before paint when becoming active (layout change may have reset it)
  useLayoutEffect(() => {
    if (!isActive) return;
    const vp = viewportRef.current;
    if (vp) {
      vp.scrollLeft = scrollPosRef.current.left;
      vp.scrollTop = scrollPosRef.current.top;
    }
  }, [isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply zoom-scroll after the zoom re-render, before paint.
  // Two cases:
  //   1. pendingScrollRef is set (Ctrl+scroll): apply it directly.
  //   2. No pending scroll (Navigator / toolbar / menu zoom): keep the
  //      selection centroid (or viewport centre) stable in image space.
  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    const oldZoom = prevZoomRef.current;
    prevZoomRef.current = zoom; // update for next time

    const pending = pendingScrollRef.current;
    if (pending) {
      pendingScrollRef.current = null;
      vp.scrollLeft = pending.scrollLeft;
      vp.scrollTop = pending.scrollTop;
      return;
    }

    // No explicit pending scroll — zoom came from the Navigator, toolbar, or
    // a menu action. Reposition so the anchor stays visually centred.
    if (oldZoom === zoom) return;
    const dpr = window.devicePixelRatio;
    const r = zoom / oldZoom;
    const anchor = getSelectionAnchorRef?.current?.();
    if (anchor) {
      // Centre the viewport on the selection centroid at the new zoom level.
      // paddingLeft_new = canvasWidth * zoom/dpr
      vp.scrollLeft =
        ((canvasWidthRef.current + anchor.x) * zoom) / dpr - vp.clientWidth / 2;
      vp.scrollTop =
        ((canvasHeightRef.current + anchor.y) * zoom) / dpr -
        vp.clientHeight / 2;
    } else {
      // Keep the current viewport centre stable in image space.
      // Simplifies to: scrollLeft' = (scrollLeft + clientWidth/2) * r - clientWidth/2
      vp.scrollLeft =
        (vp.scrollLeft + vp.clientWidth / 2) * r - vp.clientWidth / 2;
      vp.scrollTop =
        (vp.scrollTop + vp.clientHeight / 2) * r - vp.clientHeight / 2;
    }
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps
}
