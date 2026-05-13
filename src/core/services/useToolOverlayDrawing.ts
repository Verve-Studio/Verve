/**
 * Per-tool overlay-canvas drawing + cursor management.
 *
 * Each branch is a separate effect gated on `state.activeTool`. They share
 * the same shape — subscribe to a scope-owned store, redraw the
 * `toolOverlay` 2D canvas (or update `canvasRef.style.cursor`), unsubscribe
 * on cleanup — so they're consolidated into a single hook to keep
 * Canvas.tsx focused on rendering and pointer routing.
 *
 * Branches covered:
 *   - transform: draws the rotation handle + corner handles
 *   - clone-stamp: shows the source marker + Δ-offset cursor
 *   - move: sets `cursor: move` on the canvas
 *   - polygonal-selection: switches `cursor` between crosshair and cell
 *   - object-removal: paints a translucent red overlay where the inpaint mask is set
 */
import { useEffect } from "react";
import { drawTransformOverlay } from "@/core/tools/Transform/Transform";
import { drawCloneStampOverlay } from "@/ux/main/Canvas/cloneStampOverlay";
import { cursorStore } from "@/ux/main/Canvas/cursorStore";
import { cloneStampOptions } from "@/core/tools/CloneStamp/CloneStamp";
import { activeScope } from "@/core/store/scope";
import type { Tool } from "@/types";

export interface ToolOverlayDrawingParams {
  isActive: boolean;
  activeTool: Tool;
  toolOverlayRef: React.RefObject<HTMLCanvasElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  zoomRef: React.RefObject<number>;
}

export function useToolOverlayDrawing(params: ToolOverlayDrawingParams): void {
  const { isActive, activeTool, toolOverlayRef, canvasRef, zoomRef } = params;

  // ── Transform overlay ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!isActive || activeTool !== "transform") return;
    const redraw = (): void => {
      const oc = toolOverlayRef.current;
      if (!oc) return;
      drawTransformOverlay(oc, activeScope().transform, zoomRef.current);
    };
    redraw();
    activeScope().transform.subscribe(redraw);
    return () => {
      activeScope().transform.unsubscribe(redraw);
      const oc = toolOverlayRef.current;
      if (oc) {
        const ctx = oc.getContext("2d");
        ctx?.clearRect(0, 0, oc.width, oc.height);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, activeTool]);

  // ── Clone-stamp source marker + cursor ────────────────────────────────────
  useEffect(() => {
    if (!isActive || activeTool !== "clone-stamp") return;
    const redraw = (): void => {
      const oc = toolOverlayRef.current;
      if (!oc) return;
      const source = activeScope().cloneStamp.source;
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = source ? "none" : "crosshair";
      if (!source) {
        oc.getContext("2d")?.clearRect(0, 0, oc.width, oc.height);
        return;
      }
      drawCloneStampOverlay(
        oc,
        source.x,
        source.y,
        cursorStore.x,
        cursorStore.y,
        cloneStampOptions.aligned,
      );
    };
    redraw();
    activeScope().cloneStamp.subscribe(redraw);
    return () => {
      activeScope().cloneStamp.unsubscribe(redraw);
      const oc = toolOverlayRef.current;
      oc?.getContext("2d")?.clearRect(0, 0, oc.width, oc.height);
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, activeTool]);

  // ── Move tool: OS 4-direction cursor ──────────────────────────────────────
  useEffect(() => {
    if (!isActive || activeTool !== "move") return;
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = "move";
    return () => {
      if (canvas) canvas.style.cursor = "";
    };
  }, [isActive, activeTool, canvasRef]);

  // ── Polygonal selection cursor (drawing handled by useMarchingAnts) ───────
  useEffect(() => {
    if (!isActive || activeTool !== "polygonal-selection") return;
    const updateCursor = (): void => {
      if (canvasRef.current) {
        canvasRef.current.style.cursor = activeScope().polygonalSelection
          .nearClose
          ? "cell"
          : "crosshair";
      }
    };
    updateCursor();
    activeScope().polygonalSelection.subscribe(updateCursor);
    return () => {
      activeScope().polygonalSelection.unsubscribe(updateCursor);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, activeTool]);

  // ── Object removal: red translucent mask overlay ──────────────────────────
  // The store grows monotonically during a stroke (no eraser yet), so this
  // is a full redraw per change. Mask is sparse for typical brush sizes so
  // the ImageData fill stays fast enough for interactive feedback.
  useEffect(() => {
    if (!isActive || activeTool !== "object-removal") return;
    const redraw = (): void => {
      const oc = toolOverlayRef.current;
      if (!oc) return;
      const ctx2d = oc.getContext("2d");
      if (!ctx2d) return;
      ctx2d.clearRect(0, 0, oc.width, oc.height);
      const store = activeScope().inpaintMask;
      const mask = store.mask;
      if (!mask || store.width !== oc.width || store.height !== oc.height) {
        return;
      }
      const img = ctx2d.createImageData(store.width, store.height);
      const data = img.data;
      for (let i = 0; i < mask.length; i++) {
        if (mask[i] > 0) {
          const o = i * 4;
          data[o] = 255;
          data[o + 1] = 50;
          data[o + 2] = 50;
          data[o + 3] = 140;
        }
      }
      ctx2d.putImageData(img, 0, 0);
    };
    redraw();
    activeScope().inpaintMask.subscribe(redraw);
    return () => {
      activeScope().inpaintMask.unsubscribe(redraw);
      const oc = toolOverlayRef.current;
      oc?.getContext("2d")?.clearRect(0, 0, oc.width, oc.height);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, activeTool]);
}
