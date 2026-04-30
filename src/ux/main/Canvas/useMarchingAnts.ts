import { useEffect } from 'react'
import { selectionStore } from '@/core/store/selectionStore'
import { cropStore } from '@/core/store/cropStore'
import { polygonalSelectionStore } from '@/core/store/polygonalSelectionStore'

/**
 * Drives the marching-ants / crop-overlay / polygonal-selection RAF animation
 * loop on a single viewport-level canvas.
 *
 * The overlay canvas lives at viewport level (not inside the image canvas
 * wrapper), so it is always sized to the viewport in physical pixels.
 * Coordinates are transformed from image-pixel space to physical-pixel space
 * using getBoundingClientRect(), giving Photoshop-style fixed-width lines
 * that stay exactly 1 physical pixel wide regardless of zoom.
 */
export function useMarchingAnts(
  isActive: boolean,
  overlayRef: React.RefObject<HTMLCanvasElement | null>,
  viewportRef: React.RefObject<HTMLElement | null>,
  canvasWrapperRef: React.RefObject<HTMLElement | null>,
  zoomRef: React.RefObject<number>,
  activeToolRef: React.RefObject<string>,
): void {
  useEffect(() => {
    if (!isActive) return
    let rafId: number
    let dashOffset = 0

    const tick = (): void => {
      rafId = requestAnimationFrame(tick)
      const overlay  = overlayRef.current
      const viewport = viewportRef.current
      const wrapper  = canvasWrapperRef.current
      if (!overlay || !viewport || !wrapper) return
      const ctx2d = overlay.getContext('2d')
      if (!ctx2d) return

      // Resize the overlay to match the viewport's physical-pixel dimensions.
      const dpr = window.devicePixelRatio
      const vw  = Math.round(viewport.clientWidth  * dpr)
      const vh  = Math.round(viewport.clientHeight * dpr)
      if (overlay.width !== vw || overlay.height !== vh) {
        overlay.width  = vw
        overlay.height = vh
      }

      // The overlay is an absolute child of the scrolling viewport, so it
      // scrolls along with the canvas content by default. Counteract that by
      // translating it back by the current scroll offset every frame — this
      // pins the overlay to the viewport in screen space, while keeping its
      // buffer viewport-sized (no clipping when zoomed-in content extends
      // past the visible area).
      const sx = viewport.scrollLeft
      const sy = viewport.scrollTop
      overlay.style.transform = `translate(${sx}px, ${sy}px)`

      ctx2d.clearRect(0, 0, overlay.width, overlay.height)

      const { mask, pending, borderSegments } = selectionStore
      const hasCrop = !!(cropStore.pendingRect || cropStore.rect)
      const isPolyTool = activeToolRef.current === 'polygonal-selection'
      const hasPolyVerts = isPolyTool && polygonalSelectionStore.vertices.length > 0
      if (!mask && !pending && !hasCrop && !hasPolyVerts) return

      // Map from image-pixel coordinates to overlay physical-pixel coordinates.
      // getBoundingClientRect returns CSS pixels; multiply by dpr for physical px.
      // zoom = physical pixels per image pixel (zoom factor in Verve).
      // The overlay is translated above to compensate for scroll, so the
      // viewport-relative offset (wRect.left - vRect.left) is the correct
      // origin in overlay-local pixel space.
      const vRect   = viewport.getBoundingClientRect()
      const wRect   = wrapper.getBoundingClientRect()
      const originX = (wRect.left - vRect.left) * dpr
      const originY = (wRect.top  - vRect.top)  * dpr
      const zoom    = zoomRef.current          // physical px per image px

      const toX = (ix: number): number => originX + ix * zoom
      const toY = (iy: number): number => originY + iy * zoom

      // All sizes below are in physical pixels (canvas is physical-pixel-sized).
      const DASH = 4   // dash length, physical px

      // ── Selection marching ants ──────────────────────────────────────────
      // Each segment is stroked individually with a phase offset based on its
      // *physical* start position, so the ant pattern is anchored to a single
      // global screen-space grid. Ant size is constant (DASH px) regardless of
      // zoom — fewer ants when zoomed out, more when zoomed in.
      if (borderSegments && borderSegments.length > 0) {
        dashOffset = (dashOffset + 0.5) % (DASH * 2)
        ctx2d.lineWidth = 1
        ctx2d.setLineDash([DASH, DASH])
        for (const [color, extra] of [['#000000', 0], ['#ffffff', DASH]] as [string, number][]) {
          ctx2d.strokeStyle = color
          for (let i = 0; i < borderSegments.length; i += 4) {
            const x1 = toX(borderSegments[i])
            const y1 = toY(borderSegments[i + 1])
            const x2 = toX(borderSegments[i + 2])
            const y2 = toY(borderSegments[i + 3])
            // Anchor dash phase to the segment's physical start coordinate
            // along the segment's axis (horizontal → x, vertical → y).
            const along = (y1 === y2) ? x1 : y1
            ctx2d.lineDashOffset = along + dashOffset + extra
            ctx2d.beginPath()
            ctx2d.moveTo(x1, y1)
            ctx2d.lineTo(x2, y2)
            ctx2d.stroke()
          }
        }
      }

      // ── Pending drag preview ─────────────────────────────────────────────
      if (pending) {
        ctx2d.strokeStyle    = '#00aaff'
        ctx2d.lineWidth      = 1
        ctx2d.setLineDash([4, 2])
        ctx2d.lineDashOffset = 0
        ctx2d.beginPath()
        if (pending.type === 'rect') {
          const { x1, y1, x2, y2 } = pending
          ctx2d.rect(
            toX(Math.min(x1, x2)), toY(Math.min(y1, y2)),
            Math.abs(x2 - x1) * zoom, Math.abs(y2 - y1) * zoom,
          )
        } else {
          const pts = pending.points
          if (pts.length > 1) {
            ctx2d.moveTo(toX(pts[0].x), toY(pts[0].y))
            for (let i = 1; i < pts.length; i++) ctx2d.lineTo(toX(pts[i].x), toY(pts[i].y))
          }
        }
        ctx2d.stroke()
      }

      // ── Crop overlay ─────────────────────────────────────────────────────
      const cp = cropStore.pendingRect
      const cr = cropStore.rect
      if (cp) {
        ctx2d.strokeStyle    = '#ff9900'
        ctx2d.lineWidth      = 1
        ctx2d.setLineDash([4, 2])
        ctx2d.lineDashOffset = 0
        ctx2d.strokeRect(
          toX(Math.min(cp.x1, cp.x2)), toY(Math.min(cp.y1, cp.y2)),
          Math.abs(cp.x2 - cp.x1) * zoom, Math.abs(cp.y2 - cp.y1) * zoom,
        )
      } else if (cr) {
        dashOffset = (dashOffset + 0.5) % (DASH * 2)
        ctx2d.lineWidth = 1
        ctx2d.setLineDash([DASH, DASH])
        for (const [color, extra] of [['#000000', 0], ['#ff9900', DASH]] as [string, number][]) {
          ctx2d.strokeStyle    = color
          ctx2d.lineDashOffset = dashOffset + extra
          ctx2d.strokeRect(toX(cr.x), toY(cr.y), cr.w * zoom, cr.h * zoom)
        }
      }

      // ── Polygonal selection tool overlay ─────────────────────────────────
      if (hasPolyVerts) {
        const { vertices, cursor, nearClose } = polygonalSelectionStore

        // 1. Black backing stroke on committed segments
        if (vertices.length >= 2) {
          ctx2d.strokeStyle = 'rgba(0,0,0,0.8)'
          ctx2d.lineWidth   = 3
          ctx2d.setLineDash([])
          ctx2d.beginPath()
          ctx2d.moveTo(toX(vertices[0].x), toY(vertices[0].y))
          for (let i = 1; i < vertices.length; i++) ctx2d.lineTo(toX(vertices[i].x), toY(vertices[i].y))
          ctx2d.stroke()

          // 2. White top stroke
          ctx2d.strokeStyle = 'white'
          ctx2d.lineWidth   = 1.5
          ctx2d.setLineDash([])
          ctx2d.beginPath()
          ctx2d.moveTo(toX(vertices[0].x), toY(vertices[0].y))
          for (let i = 1; i < vertices.length; i++) ctx2d.lineTo(toX(vertices[i].x), toY(vertices[i].y))
          ctx2d.stroke()
        }

        // 3. Rubber-band from last vertex to cursor
        ctx2d.strokeStyle    = 'rgba(42, 113, 255, 0.8)'
        ctx2d.lineWidth      = 1
        ctx2d.setLineDash([4, 3])
        ctx2d.lineDashOffset = 0
        ctx2d.beginPath()
        ctx2d.moveTo(toX(vertices[vertices.length - 1].x), toY(vertices[vertices.length - 1].y))
        ctx2d.lineTo(toX(cursor.x), toY(cursor.y))
        ctx2d.stroke()
        ctx2d.setLineDash([])

        // 4. Vertex dots
        for (const v of vertices) {
          ctx2d.beginPath()
          ctx2d.arc(toX(v.x), toY(v.y), 4, 0, Math.PI * 2)
          ctx2d.fillStyle = 'white'
          ctx2d.fill()
          ctx2d.strokeStyle = 'rgba(0,0,0,0.8)'
          ctx2d.lineWidth   = 1.5
          ctx2d.setLineDash([])
          ctx2d.stroke()
        }

        // 5. Close-snap ring on origin vertex
        if (nearClose) {
          ctx2d.lineWidth   = 2
          ctx2d.strokeStyle = '#ffffff'
          ctx2d.beginPath()
          ctx2d.arc(toX(vertices[0].x), toY(vertices[0].y), 7, 0, Math.PI * 2)
          ctx2d.stroke()
        }
      }
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])
}
