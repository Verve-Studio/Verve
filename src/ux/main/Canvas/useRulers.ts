import { useEffect, useRef } from 'react'
import { cursorStore } from '@/core/store/cursorStore'

export const RULER_SIZE = 20 // CSS pixels

const TICK_INTERVALS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
const MIN_MAJOR_SPACING = 55 // min CSS px between major labeled ticks

function pickInterval(zoom: number, dpr: number): number {
  const cssPxPerDocPx = zoom / dpr
  return TICK_INTERVALS.find(v => v * cssPxPerDocPx >= MIN_MAJOR_SPACING) ?? 10000
}

function drawRuler(
  canvas: HTMLCanvasElement,
  isHorizontal: boolean,
  /** CSS pixel offset of the canvas 0 point within the ruler */
  canvasOrigin: number,
  zoom: number,
  dpr: number,
  /** Cursor position in document pixels, or null if outside */
  cursorDoc: number | null,
): void {
  const cssW = canvas.offsetWidth
  const cssH = canvas.offsetHeight
  if (cssW === 0 || cssH === 0) return

  const physW = Math.round(cssW * dpr)
  const physH = Math.round(cssH * dpr)
  if (canvas.width !== physW) canvas.width = physW
  if (canvas.height !== physH) canvas.height = physH

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, cssW, cssH)

  // Background
  ctx.fillStyle = '#252525'
  ctx.fillRect(0, 0, cssW, cssH)

  // Edge border (facing the canvas)
  ctx.strokeStyle = '#444'
  ctx.lineWidth = 1
  ctx.beginPath()
  if (isHorizontal) {
    ctx.moveTo(0, cssH - 0.5)
    ctx.lineTo(cssW, cssH - 0.5)
  } else {
    ctx.moveTo(cssW - 0.5, 0)
    ctx.lineTo(cssW - 0.5, cssH)
  }
  ctx.stroke()

  const cssPxPerDocPx = zoom / dpr
  const interval = pickInterval(zoom, dpr)
  const subInterval = interval >= 10 ? interval / 5 : interval

  const viewSize = isHorizontal ? cssW : cssH
  // startDoc: the document coordinate at ruler pixel 0
  const startDoc = -canvasOrigin / cssPxPerDocPx
  const endDoc = startDoc + viewSize / cssPxPerDocPx
  const firstSub = Math.floor(startDoc / subInterval) * subInterval

  ctx.font = `9px system-ui, -apple-system, sans-serif`
  ctx.textBaseline = 'top'

  for (let doc = firstSub; doc <= endDoc + subInterval; doc += subInterval) {
    const screenPx = canvasOrigin + doc * cssPxPerDocPx
    if (screenPx < -2 || screenPx > viewSize + 2) continue

    const isMajor = Math.round(doc) % interval === 0
    const tickLen = isMajor ? 9 : 4

    ctx.strokeStyle = isMajor ? '#777' : '#484848'
    ctx.lineWidth = 1
    ctx.beginPath()
    if (isHorizontal) {
      ctx.moveTo(screenPx + 0.5, cssH - tickLen)
      ctx.lineTo(screenPx + 0.5, cssH)
    } else {
      ctx.moveTo(cssW - tickLen, screenPx + 0.5)
      ctx.lineTo(cssW, screenPx + 0.5)
    }
    ctx.stroke()

    if (isMajor) {
      const label = `${Math.round(doc)}`
      ctx.fillStyle = '#909090'
      if (isHorizontal) {
        ctx.fillText(label, screenPx + 2, 2)
      } else {
        ctx.save()
        ctx.translate(cssW - tickLen - 2, screenPx - 1)
        ctx.rotate(-Math.PI / 2)
        ctx.textBaseline = 'bottom'
        ctx.fillText(label, 0, 0)
        ctx.restore()
      }
    }
  }

  // Cursor indicator line
  if (cursorDoc !== null) {
    const cursorPx = canvasOrigin + cursorDoc * cssPxPerDocPx
    if (cursorPx >= 0 && cursorPx <= viewSize) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'
      ctx.lineWidth = 1
      ctx.beginPath()
      if (isHorizontal) {
        ctx.moveTo(cursorPx + 0.5, 0)
        ctx.lineTo(cursorPx + 0.5, cssH)
      } else {
        ctx.moveTo(0, cursorPx + 0.5)
        ctx.lineTo(cssW, cursorPx + 0.5)
      }
      ctx.stroke()
    }
  }

  ctx.restore()
}

interface UseRulersParams {
  showRulers: boolean
  hRulerRef: React.RefObject<HTMLCanvasElement | null>
  vRulerRef: React.RefObject<HTMLCanvasElement | null>
  viewportRef: React.RefObject<HTMLDivElement | null>
  canvasWrapperRef: React.RefObject<HTMLDivElement | null>
  zoom: number
}

export function useRulers({ showRulers, hRulerRef, vRulerRef, viewportRef, canvasWrapperRef, zoom }: UseRulersParams): void {
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  useEffect(() => {
    if (!showRulers) return
    const viewport = viewportRef.current
    if (!viewport) return

    const dpr = window.devicePixelRatio || 1

    const getOrigins = (): { hOrigin: number; vOrigin: number } => {
      const wrapper = canvasWrapperRef.current
      if (!wrapper) return { hOrigin: 0, vOrigin: 0 }
      const vpRect = viewport.getBoundingClientRect()
      const wRect = wrapper.getBoundingClientRect()
      return {
        hOrigin: wRect.left - vpRect.left,
        vOrigin: wRect.top  - vpRect.top,
      }
    }

    const paint = () => {
      const h = hRulerRef.current
      const v = vRulerRef.current
      if (!h || !v) return
      const z = zoomRef.current
      const { hOrigin, vOrigin } = getOrigins()
      const cx = cursorStore.visible ? cursorStore.x : null
      const cy = cursorStore.visible ? cursorStore.y : null
      drawRuler(h, true,  hOrigin, z, dpr, cx)
      drawRuler(v, false, vOrigin, z, dpr, cy)
    }

    const ro = new ResizeObserver(paint)
    ro.observe(viewport)
    if (hRulerRef.current) ro.observe(hRulerRef.current)
    if (vRulerRef.current) ro.observe(vRulerRef.current)

    viewport.addEventListener('scroll', paint, { passive: true })
    cursorStore.subscribe(paint)
    paint()

    return () => {
      viewport.removeEventListener('scroll', paint)
      cursorStore.unsubscribe(paint)
      ro.disconnect()
    }
  }, [showRulers, hRulerRef, vRulerRef, viewportRef, canvasWrapperRef])

  // Repaint when zoom changes
  useEffect(() => {
    if (!showRulers) return
    const viewport = viewportRef.current
    const h = hRulerRef.current
    const v = vRulerRef.current
    const wrapper = canvasWrapperRef.current
    if (!viewport || !h || !v || !wrapper) return
    const dpr = window.devicePixelRatio || 1
    const vpRect = viewport.getBoundingClientRect()
    const wRect = wrapper.getBoundingClientRect()
    const hOrigin = wRect.left - vpRect.left
    const vOrigin = wRect.top  - vpRect.top
    const cx = cursorStore.visible ? cursorStore.x : null
    const cy = cursorStore.visible ? cursorStore.y : null
    drawRuler(h, true,  hOrigin, zoom, dpr, cx)
    drawRuler(v, false, vOrigin, zoom, dpr, cy)
  }, [zoom, showRulers, hRulerRef, vRulerRef, viewportRef, canvasWrapperRef])
}
