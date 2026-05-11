import { useEffect, useRef } from "react";
import { cursorStore } from "@/ux/main/Canvas/cursorStore";

export const RULER_SIZE = 20; // CSS pixels

const TICK_INTERVALS = [
  1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000,
];
const MIN_MAJOR_SPACING = 55; // min CSS px between major labeled ticks

function pickInterval(zoom: number, dpr: number): number {
  const cssPxPerDocPx = zoom / dpr;
  return (
    TICK_INTERVALS.find((v) => v * cssPxPerDocPx >= MIN_MAJOR_SPACING) ?? 10000
  );
}

interface RulerPalette {
  bg: string;
  edge: string;
  tickMajor: string;
  tickMinor: string;
  label: string;
  cursor: string;
}

/** Read the active theme tokens from <html>'s computed style. */
function readPalette(): RulerPalette {
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string): string => {
    const v = cs.getPropertyValue(name).trim();
    return v.length > 0 ? v : fallback;
  };
  return {
    bg: get("--color-surface-2", "#252525"),
    edge: get("--color-border", "#444"),
    tickMajor: get("--color-text-muted", "#777"),
    // Sub-ticks: a low-contrast version of the major tick colour, derived in
    // CSS at use-time via color-mix so it adapts to either theme.
    tickMinor:
      "color-mix(in srgb, " +
      get("--color-text-muted", "#777") +
      " 45%, transparent)",
    label: get("--color-text-dim", "#909090"),
    cursor:
      "color-mix(in srgb, " +
      get("--color-text", "#ffffff") +
      " 85%, transparent)",
  };
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
  palette: RulerPalette,
): void {
  const cssW = canvas.offsetWidth;
  const cssH = canvas.offsetHeight;
  if (cssW === 0 || cssH === 0) return;

  const physW = Math.round(cssW * dpr);
  const physH = Math.round(cssH * dpr);
  if (canvas.width !== physW) canvas.width = physW;
  if (canvas.height !== physH) canvas.height = physH;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  // Background
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  // Edge border (facing the canvas)
  ctx.strokeStyle = palette.edge;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (isHorizontal) {
    ctx.moveTo(0, cssH - 0.5);
    ctx.lineTo(cssW, cssH - 0.5);
  } else {
    ctx.moveTo(cssW - 0.5, 0);
    ctx.lineTo(cssW - 0.5, cssH);
  }
  ctx.stroke();

  const cssPxPerDocPx = zoom / dpr;
  const interval = pickInterval(zoom, dpr);
  const subInterval = interval >= 10 ? interval / 5 : interval;

  const viewSize = isHorizontal ? cssW : cssH;
  // startDoc: the document coordinate at ruler pixel 0
  const startDoc = -canvasOrigin / cssPxPerDocPx;
  const endDoc = startDoc + viewSize / cssPxPerDocPx;
  const firstSub = Math.floor(startDoc / subInterval) * subInterval;

  ctx.font = `9px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = "top";

  for (let doc = firstSub; doc <= endDoc + subInterval; doc += subInterval) {
    const screenPx = canvasOrigin + doc * cssPxPerDocPx;
    if (screenPx < -2 || screenPx > viewSize + 2) continue;

    const isMajor = Math.round(doc) % interval === 0;
    const tickLen = isMajor ? 9 : 4;

    ctx.strokeStyle = isMajor ? palette.tickMajor : palette.tickMinor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (isHorizontal) {
      ctx.moveTo(screenPx + 0.5, cssH - tickLen);
      ctx.lineTo(screenPx + 0.5, cssH);
    } else {
      ctx.moveTo(cssW - tickLen, screenPx + 0.5);
      ctx.lineTo(cssW, screenPx + 0.5);
    }
    ctx.stroke();

    if (isMajor) {
      const label = `${Math.round(doc)}`;
      ctx.fillStyle = palette.label;
      if (isHorizontal) {
        ctx.fillText(label, screenPx + 2, 2);
      } else {
        ctx.save();
        ctx.translate(cssW - tickLen - 2, screenPx - 1);
        ctx.rotate(-Math.PI / 2);
        ctx.textBaseline = "bottom";
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    }
  }

  // Cursor indicator line
  if (cursorDoc !== null) {
    const cursorPx = canvasOrigin + cursorDoc * cssPxPerDocPx;
    if (cursorPx >= 0 && cursorPx <= viewSize) {
      ctx.strokeStyle = palette.cursor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (isHorizontal) {
        ctx.moveTo(cursorPx + 0.5, 0);
        ctx.lineTo(cursorPx + 0.5, cssH);
      } else {
        ctx.moveTo(0, cursorPx + 0.5);
        ctx.lineTo(cssW, cursorPx + 0.5);
      }
      ctx.stroke();
    }
  }

  ctx.restore();
}

interface UseRulersParams {
  showRulers: boolean;
  hRulerRef: React.RefObject<HTMLCanvasElement | null>;
  vRulerRef: React.RefObject<HTMLCanvasElement | null>;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  canvasWrapperRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
}

export function useRulers({
  showRulers,
  hRulerRef,
  vRulerRef,
  viewportRef,
  canvasWrapperRef,
  zoom,
}: UseRulersParams): void {
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    if (!showRulers) return;
    const viewport = viewportRef.current;
    if (!viewport) return;

    const dpr = window.devicePixelRatio || 1;

    const getOrigins = (): { hOrigin: number; vOrigin: number } => {
      const wrapper = canvasWrapperRef.current;
      if (!wrapper) return { hOrigin: 0, vOrigin: 0 };
      const vpRect = viewport.getBoundingClientRect();
      const wRect = wrapper.getBoundingClientRect();
      return {
        hOrigin: wRect.left - vpRect.left,
        vOrigin: wRect.top - vpRect.top,
      };
    };

    const paint = (): void => {
      const h = hRulerRef.current;
      const v = vRulerRef.current;
      if (!h || !v) return;
      const z = zoomRef.current;
      const { hOrigin, vOrigin } = getOrigins();
      const cx = cursorStore.visible ? cursorStore.x : null;
      const cy = cursorStore.visible ? cursorStore.y : null;
      const palette = readPalette();
      drawRuler(h, true, hOrigin, z, dpr, cx, palette);
      drawRuler(v, false, vOrigin, z, dpr, cy, palette);
    };

    const ro = new ResizeObserver(paint);
    ro.observe(viewport);
    if (hRulerRef.current) ro.observe(hRulerRef.current);
    if (vRulerRef.current) ro.observe(vRulerRef.current);

    viewport.addEventListener("scroll", paint, { passive: true });
    cursorStore.subscribe(paint);

    // Repaint when the theme attribute on <html> changes so rulers swap to
    // the active palette without waiting for a scroll/resize/cursor event.
    const themeObserver = new MutationObserver(paint);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    paint();

    return () => {
      viewport.removeEventListener("scroll", paint);
      cursorStore.unsubscribe(paint);
      ro.disconnect();
      themeObserver.disconnect();
    };
  }, [showRulers, hRulerRef, vRulerRef, viewportRef, canvasWrapperRef]);

  // Repaint when zoom changes
  useEffect(() => {
    if (!showRulers) return;
    const viewport = viewportRef.current;
    const h = hRulerRef.current;
    const v = vRulerRef.current;
    const wrapper = canvasWrapperRef.current;
    if (!viewport || !h || !v || !wrapper) return;
    const dpr = window.devicePixelRatio || 1;
    const vpRect = viewport.getBoundingClientRect();
    const wRect = wrapper.getBoundingClientRect();
    const hOrigin = wRect.left - vpRect.left;
    const vOrigin = wRect.top - vpRect.top;
    const cx = cursorStore.visible ? cursorStore.x : null;
    const cy = cursorStore.visible ? cursorStore.y : null;
    const palette = readPalette();
    drawRuler(h, true, hOrigin, zoom, dpr, cx, palette);
    drawRuler(v, false, vOrigin, zoom, dpr, cy, palette);
  }, [zoom, showRulers, hRulerRef, vRulerRef, viewportRef, canvasWrapperRef]);
}
