import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * Manages zoom-to-cursor (Ctrl+scroll) and scroll-position save/restore.
 *
 * @param isActive        Whether this canvas tab is currently visible.
 * @param isActiveRef     Ref mirror of isActive (readable inside async/event handlers).
 * @param viewportRef     Ref to the scrollable viewport div.
 * @param zoomRef         Ref that always holds the current zoom level.
 * @param pendingScrollRef   Written by the wheel handler; consumed by the layout effect.
 * @param scrollPosRef    Persists scroll position across tab switches.
 * @param zoom            Current zoom level (used as layout-effect dependency).
 * @param onZoom          Called with the new zoom value when Ctrl+scroll fires.
 * @param getSelectionAnchorRef  Ref to a callback that returns the selection centroid in
 *                        **image-pixel** space, or null when there is no active selection.
 *                        When provided:
 *                        - Ctrl+scroll zooms toward the centroid's current viewport position.
 *                        - Navigator/toolbar zoom centers the viewport on the centroid.
 *                        Falls back to cursor (Ctrl+scroll) or viewport-centre (Navigator)
 *                        when null.
 */
export function useScrollZoom(
  isActive: boolean,
  isActiveRef: React.RefObject<boolean>,
  viewportRef: React.RefObject<HTMLDivElement | null>,
  zoomRef: React.RefObject<number>,
  pendingScrollRef: React.MutableRefObject<{ scrollLeft: number; scrollTop: number } | null>,
  scrollPosRef: React.MutableRefObject<{ left: number; top: number }>,
  zoom: number,
  onZoom: (zoom: number) => void,
  getSelectionAnchorRef?: React.RefObject<(() => { x: number; y: number } | null) | null>,
): void {
  // Track previous zoom so the layout effect can compute the image-space centre
  // before the zoom change when no explicit pending scroll was set.
  const prevZoomRef = useRef(zoom)

  // Ctrl+scroll → zoom to selection centroid (if active) or cursor position
  useEffect(() => {
    if (!isActive) return
    const vp = viewportRef.current
    if (!vp) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const rect = vp.getBoundingClientRect()
      const oldZoom = zoomRef.current!
      const dpr = window.devicePixelRatio
      // Smooth on trackpad (pixel deltaMode), fixed step on mouse wheel
      const factor = e.deltaMode === 0
        ? Math.pow(0.998, e.deltaY)
        : e.deltaY < 0 ? 1.25 : 0.8
      const newZoom = parseFloat(
        Math.min(32, Math.max(0.05, oldZoom * factor)).toFixed(4)
      )
      // Anchor: selection centroid (in viewport CSS-px) when available, else cursor
      const anchor = getSelectionAnchorRef?.current?.()
      const anchorX = anchor
        ? anchor.x * oldZoom / dpr - vp.scrollLeft
        : e.clientX - rect.left
      const anchorY = anchor
        ? anchor.y * oldZoom / dpr - vp.scrollTop
        : e.clientY - rect.top
      pendingScrollRef.current = {
        scrollLeft: (vp.scrollLeft + anchorX) * (newZoom / oldZoom) - anchorX,
        scrollTop:  (vp.scrollTop  + anchorY) * (newZoom / oldZoom) - anchorY,
      }
      onZoom(newZoom)
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [isActive]) // eslint-disable-line react-hooks/exhaustive-deps

  // Continuously track scroll position — only while active so browser-triggered
  // scroll resets (on visibility change) don't overwrite the saved position.
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const onScroll = (): void => {
      if (isActiveRef.current) {
        scrollPosRef.current = { left: vp.scrollLeft, top: vp.scrollTop }
      }
    }
    vp.addEventListener('scroll', onScroll, { passive: true })
    return () => vp.removeEventListener('scroll', onScroll)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Restore scroll before paint when becoming active (layout change may have reset it)
  useLayoutEffect(() => {
    if (!isActive) return
    const vp = viewportRef.current
    if (vp) { vp.scrollLeft = scrollPosRef.current.left; vp.scrollTop = scrollPosRef.current.top }
  }, [isActive]) // eslint-disable-line react-hooks/exhaustive-deps

  // Apply zoom-scroll after the zoom re-render, before paint.
  // Two cases:
  //   1. pendingScrollRef is set (Ctrl+scroll): apply it directly.
  //   2. No pending scroll (Navigator / toolbar / menu zoom): keep the
  //      selection centroid (or viewport centre) stable in image space.
  useLayoutEffect(() => {
    const vp = viewportRef.current
    if (!vp) return

    const oldZoom = prevZoomRef.current
    prevZoomRef.current = zoom  // update for next time

    const pending = pendingScrollRef.current
    if (pending) {
      pendingScrollRef.current = null
      vp.scrollLeft = pending.scrollLeft
      vp.scrollTop  = pending.scrollTop
      return
    }

    // No explicit pending scroll — zoom came from the Navigator, toolbar, or
    // a menu action. Reposition so the anchor stays visually centred.
    if (oldZoom === zoom) return
    const dpr = window.devicePixelRatio
    const anchor = getSelectionAnchorRef?.current?.()
    if (anchor) {
      // Centre the viewport on the selection centroid at the new zoom level.
      vp.scrollLeft = anchor.x * zoom / dpr - vp.clientWidth  / 2
      vp.scrollTop  = anchor.y * zoom / dpr - vp.clientHeight / 2
    } else {
      // Keep the current viewport centre stable in image space.
      const centreImgX = (vp.scrollLeft + vp.clientWidth  / 2) / (oldZoom / dpr)
      const centreImgY = (vp.scrollTop  + vp.clientHeight / 2) / (oldZoom / dpr)
      vp.scrollLeft = centreImgX * zoom / dpr - vp.clientWidth  / 2
      vp.scrollTop  = centreImgY * zoom / dpr - vp.clientHeight / 2
    }
  }, [zoom]) // eslint-disable-line react-hooks/exhaustive-deps
}
