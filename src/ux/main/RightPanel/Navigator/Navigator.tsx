import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAppContext } from "@/core/store/AppContext";
import { useCanvasContext } from "@/core/store/CanvasContext";
import styles from "./Navigator.module.scss";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;
const THUMB_W = 214;

export function Navigator(): React.JSX.Element {
  const { state, dispatch } = useAppContext();
  const { canvasElRef, thumbnailCanvasRef } = useCanvasContext();
  const thumbRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [zoomInput, setZoomInput] = useState(
    String(Math.round(state.canvas.zoom * 100)),
  );
  const rafRef = useRef<number>(0);

  const { zoom, width: docW, height: docH } = state.canvas;
  const thumbH = Math.round((docH / docW) * THUMB_W);

  // ─── Draw thumbnail + viewport rect (runs every frame) ─────────
  const drawThumb = useCallback(() => {
    const src = thumbnailCanvasRef.current; // safe 2D mirror — never the WebGPU canvas
    const dst = thumbRef.current;
    if (!src || !dst) return;
    const ctx = dst.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, THUMB_W, thumbH);
    try {
      ctx.drawImage(src, 0, 0, THUMB_W, thumbH);
    } catch {
      // mirror not yet updated
    }
  }, [thumbnailCanvasRef, thumbH]);

  // ─── Viewport rect via bounding-rect intersection ────────────────
  const getViewportRect = useCallback((): React.CSSProperties => {
    const canvas = canvasElRef.current;
    const container = document.querySelector<HTMLElement>(
      "[data-active-viewport]",
    );
    if (!canvas || !container) return { display: "none" };

    const cr = canvas.getBoundingClientRect(); // canvas position on screen
    const vr = container.getBoundingClientRect(); // scroll container position on screen

    // Intersection (visible portion of canvas)
    const iLeft = Math.max(cr.left, vr.left);
    const iTop = Math.max(cr.top, vr.top);
    const iRight = Math.min(cr.right, vr.right);
    const iBottom = Math.min(cr.bottom, vr.bottom);

    if (iRight <= iLeft || iBottom <= iTop) return { display: "none" };

    // Convert to fractions of the canvas element
    const fl = (iLeft - cr.left) / cr.width;
    const ft = (iTop - cr.top) / cr.height;
    const fr = (iRight - cr.left) / cr.width;
    const fb = (iBottom - cr.top) / cr.height;

    // Entire canvas visible → hide rect
    if (fl <= 0 && ft <= 0 && fr >= 1 && fb >= 1) return { display: "none" };

    // Use percentages so the overlay scales with the CSS-scaled thumbnail
    return {
      left: `${fl * 100}%`,
      top: `${ft * 100}%`,
      width: `${Math.max(0.5, (fr - fl) * 100)}%`,
      height: `${Math.max(0.5, (fb - ft) * 100)}%`,
    };
  }, [canvasElRef, thumbH]);

  // Refresh thumb + viewport rect on every animation frame while mounted
  useEffect(() => {
    let active = true;
    const loop = (): void => {
      if (!active) return;
      drawThumb();
      setViewRect(getViewportRect());
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      active = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [drawThumb, getViewportRect]);

  // Keep zoom input in sync when zoom changes externally
  useEffect(() => {
    setZoomInput(String(Math.round(zoom * 100)));
  }, [zoom]);

  // ─── Viewport rect overlay ───────────────────────────────────────
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [viewRect, setViewRect] = useState<React.CSSProperties>({
    display: "none",
  });
  useEffect(() => {
    // Keep containerRef in sync for the click-to-pan handler
    const el = document.querySelector<HTMLDivElement>("[data-active-viewport]");
    containerRef.current = el;
  }, []);

  // ─── Click / drag in thumbnail to pan ────────────────────────────
  const handleThumbPointer = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      const thumbEl = e.currentTarget as HTMLCanvasElement;
      const thumbRect = thumbEl.getBoundingClientRect();
      // Divide by actual rendered size, not the canvas buffer dimensions
      const nx = (e.clientX - thumbRect.left) / thumbRect.width;
      const ny = (e.clientY - thumbRect.top) / thumbRect.height;

      const canvas = canvasElRef.current;
      const container = document.querySelector<HTMLDivElement>(
        "[data-active-viewport]",
      );
      if (!canvas || !container) return;

      // Screen position of the target point on the canvas
      const cr = canvas.getBoundingClientRect();
      const vr = container.getBoundingClientRect();
      const targetScreenX = cr.left + nx * cr.width;
      const targetScreenY = cr.top + ny * cr.height;

      // Scroll delta needed to center that point in the viewport
      const dX = targetScreenX - (vr.left + container.clientWidth / 2);
      const dY = targetScreenY - (vr.top + container.clientHeight / 2);
      container.scrollLeft += dX;
      container.scrollTop += dY;
    },
    [canvasElRef, thumbH],
  );

  const isDraggingThumb = useRef(false);
  const onThumbDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      isDraggingThumb.current = true;
      (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
      handleThumbPointer(e);
    },
    [handleThumbPointer],
  );
  const onThumbMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      if (isDraggingThumb.current) handleThumbPointer(e);
    },
    [handleThumbPointer],
  );
  const onThumbUp = useCallback((): void => {
    isDraggingThumb.current = false;
  }, []);

  // ─── Zoom controls ───────────────────────────────────────────────
  const setZoom = useCallback(
    (next: number): void => {
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
      dispatch({ type: "SET_ZOOM", payload: parseFloat(clamped.toFixed(4)) });
    },
    [dispatch],
  );

  const onSliderChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    // Slider is log-scaled: 0-100 → MIN_ZOOM-MAX_ZOOM
    const t = parseFloat(e.target.value) / 100;
    const logZoom = Math.exp(t * Math.log(MAX_ZOOM / MIN_ZOOM)) * MIN_ZOOM;
    setZoom(logZoom);
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setZoomInput(e.target.value);
  };
  const onInputCommit = (): void => {
    const pct = parseFloat(zoomInput);
    if (!isNaN(pct) && pct > 0) setZoom(pct / 100);
    else setZoomInput(String(Math.round(zoom * 100)));
  };
  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") onInputCommit();
    if (e.key === "Escape") setZoomInput(String(Math.round(zoom * 100)));
  };

  // Convert current zoom back to slider position (log-scaled)
  const sliderVal =
    (Math.log(zoom / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM)) * 100;

  return (
    <div className={styles.navigator}>
      {/* ── Thumbnail ─────────────────────────────────────────────── */}
      <div className={styles.thumbWrap}>
        <canvas
          ref={thumbRef}
          className={styles.thumb}
          width={THUMB_W}
          height={thumbH}
          onPointerDown={onThumbDown}
          onPointerMove={onThumbMove}
          onPointerUp={onThumbUp}
          aria-label="Navigator thumbnail"
        />
        {/* Viewport outline rect */}
        {viewRect.display !== "none" && (
          <div ref={viewportRef} className={styles.viewRect} style={viewRect} />
        )}
      </div>

      {/* ── Zoom bar ──────────────────────────────────────────────── */}
      <div className={styles.zoomBar}>
        <button
          className={styles.zoomBtn}
          onClick={() => setZoom(zoom / 1.5)}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <svg
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            width="9"
            height="9"
          >
            <circle cx="4.5" cy="4.5" r="3.5" />
            <line x1="7.5" y1="7.5" x2="9.5" y2="9.5" strokeLinecap="round" />
            <line x1="2.5" y1="4.5" x2="6.5" y2="4.5" strokeLinecap="round" />
          </svg>
        </button>

        <input
          type="range"
          className={styles.slider}
          min={0}
          max={100}
          step={0.1}
          value={sliderVal}
          onChange={onSliderChange}
          aria-label="Zoom level"
        />

        <button
          className={styles.zoomBtn}
          onClick={() => setZoom(zoom * 1.5)}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <svg
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            width="9"
            height="9"
          >
            <circle cx="4.5" cy="4.5" r="3.5" />
            <line x1="7.5" y1="7.5" x2="9.5" y2="9.5" strokeLinecap="round" />
            <line x1="4.5" y1="2.5" x2="4.5" y2="6.5" strokeLinecap="round" />
            <line x1="2.5" y1="4.5" x2="6.5" y2="4.5" strokeLinecap="round" />
          </svg>
        </button>

        <input
          type="text"
          className={styles.zoomInput}
          value={zoomInput}
          onChange={onInputChange}
          onBlur={onInputCommit}
          onKeyDown={onInputKey}
          aria-label="Zoom percentage"
        />
        <span className={styles.zoomPct}>%</span>
      </div>
    </div>
  );
}
