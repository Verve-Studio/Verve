/**
 * Imperative brush / pixel-brush cursor manager.
 *
 * Two distinct on-screen cursors live in Canvas:
 *   1. `brushCursor` — a CSS-circle overlay used by every "thick" pixel tool
 *      (brush, eraser, dodge, burn, liquify, blur, sharpen, smudge,
 *      healing brush, quick select, clone stamp). Sizes per its tool's
 *      module-level options object.
 *   2. `pixelBrushCursor` — a tiny preview tile used by the pencil tool that
 *      renders the actual brush shape coloured with the primary colour.
 *
 * Both are driven imperatively (no React re-render per pointer event) and
 * are positioned in CSS pixels relative to the canvas wrapper. The
 * tiled-mode renderer wraps coordinates into [-W, 2W); see `setCursors`'s
 * `tiledOffset` argument.
 *
 * This hook returns plain callbacks — call them from `onHover` (and from
 * tool-switch cleanup). It owns no state and runs no effects; the caller
 * keeps the underlying DOM refs.
 */
import { useCallback } from "react";
import { brushOptions } from "@/core/tools/Brush/Brush";
import {
  pencilOptions,
  getPencilBrushPreviewDataUrl,
  getPencilShapePreviewDataUrl,
} from "@/core/tools/Pencil/Pencil";
import { eraserOptions } from "@/core/tools/Eraser/Eraser";
import { liquifyOptions } from "@/core/tools/Liquify/Liquify";
import { blurOptions } from "@/core/tools/Blur/Blur";
import { sharpenOptions } from "@/core/tools/Sharpen/Sharpen";
import { smudgeOptions } from "@/core/tools/Smudge/Smudge";
import { healingBrushOptions } from "@/core/tools/HealingBrush/HealingBrush";
import { objectRemovalOptions } from "@/core/tools/ObjectRemoval/ObjectRemoval";
import { quickSelectOptions } from "@/core/tools/QuickSelect/QuickSelect";
import { cloneStampOptions } from "@/core/tools/CloneStamp/CloneStamp";
import { dodgeOptions, burnOptions } from "@/core/tools/Dodge/Dodge";
import { activeScope } from "@/core/store/scope";
import type { Tool, RGBAColor } from "@/types";

/** Identity check for the "thick" circle-cursor tools. Updating this list
 *  alone is enough to add a new tool to the brush-cursor pool. */
const CIRCLE_CURSOR_TOOLS: ReadonlySet<Tool> = new Set<Tool>([
  "brush",
  "eraser",
  "clone-stamp",
  "dodge",
  "burn",
  "liquify",
  "blur",
  "sharpen",
  "smudge",
  "healing-brush",
  "object-removal",
  "quick-select",
]);

function sizeForTool(tool: Tool): number {
  switch (tool) {
    case "brush":
      return brushOptions.size;
    case "eraser":
      return eraserOptions.size;
    case "dodge":
      return dodgeOptions.size;
    case "burn":
      return burnOptions.size;
    case "liquify":
      return liquifyOptions.size;
    case "blur":
      return blurOptions.size;
    case "sharpen":
      return sharpenOptions.size;
    case "smudge":
      return smudgeOptions.size;
    case "healing-brush":
      return healingBrushOptions.size;
    case "object-removal":
      return objectRemovalOptions.size;
    case "quick-select":
      return quickSelectOptions.size;
    default:
      return cloneStampOptions.size;
  }
}

export interface BrushCursorParams {
  brushCursorRef: React.RefObject<HTMLDivElement | null>;
  pixelBrushCursorRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  zoomRef: React.RefObject<number>;
  activeTool: Tool;
  primaryColor: RGBAColor;
  /** Document size, used to translate tiled-mode coords ([-W, 2W)) into
   *  wrapper-space CSS coords. */
  width: number;
  height: number;
  /** CSS module class names — passed through so the hook stays
   *  styling-agnostic. */
  baseClass: string;
  crossHairClass: string;
}

export interface BrushCursorApi {
  /** Update the circle cursor's CSS position/size for a hover at `pos`.
   *  When `tiled` is true, `pos.x/y` are in [-W, 2W) and the function
   *  translates them into wrapper-space (which sits at +W, +H). */
  updateCircleCursor(pos: { x: number; y: number }, tiled: boolean): void;
  /** Update the pencil pixel-brush preview cursor. No-op when the active
   *  tool is not `pencil`. */
  updatePencilCursor(pos: { x: number; y: number }): void;
  /** Hide both cursors. Used on pointer-leave / tool switch. */
  hideAll(): void;
}

export function useBrushCursor(params: BrushCursorParams): BrushCursorApi {
  const {
    brushCursorRef,
    pixelBrushCursorRef,
    canvasRef,
    zoomRef,
    activeTool,
    primaryColor,
    width,
    height,
    baseClass,
    crossHairClass,
  } = params;

  const updateCircleCursor = useCallback(
    (pos: { x: number; y: number }, tiled: boolean): void => {
      const tool = activeTool;
      const el = brushCursorRef.current;
      if (!el) return;
      if (!CIRCLE_CURSOR_TOOLS.has(tool)) return;
      const dpr = window.devicePixelRatio;
      const zoom = zoomRef.current;
      const r = Math.max(1, ((sizeForTool(tool) / 2) * zoom) / dpr);
      const cx = tiled
        ? ((pos.x + width) * zoom) / dpr
        : (pos.x * zoom) / dpr;
      const cy = tiled
        ? ((pos.y + height) * zoom) / dpr
        : (pos.y * zoom) / dpr;
      el.style.left = `${cx - r}px`;
      el.style.top = `${cy - r}px`;
      el.style.width = `${r * 2}px`;
      el.style.height = `${r * 2}px`;
      if (tool === "clone-stamp") {
        // Clone stamp only draws the cursor once the user has Alt+clicked
        // a source — otherwise we'd be showing a circle for a no-op tool.
        el.style.display = activeScope().cloneStamp.source ? "block" : "none";
        el.className = `${baseClass} ${crossHairClass}`;
      } else {
        el.style.display = "block";
        el.className = baseClass;
      }
    },
    [
      activeTool,
      brushCursorRef,
      zoomRef,
      width,
      height,
      baseClass,
      crossHairClass,
    ],
  );

  const updatePencilCursor = useCallback(
    (pos: { x: number; y: number }): void => {
      const el = pixelBrushCursorRef.current;
      if (!el) return;
      if (activeTool !== "pencil") {
        if (el.style.display !== "none") el.style.display = "none";
        return;
      }
      // primaryColor is float [0,1] — scale to 0-255 for the preview path
      // (which writes into a 2D canvas and produces a data URL).
      const r = Math.round(Math.min(primaryColor.r, 1) * 255);
      const g = Math.round(Math.min(primaryColor.g, 1) * 255);
      const b = Math.round(Math.min(primaryColor.b, 1) * 255);
      const a = Math.round(primaryColor.a * 255);
      const dpr = window.devicePixelRatio;
      const zoom = zoomRef.current;
      const preview = pencilOptions.pixelBrush
        ? getPencilBrushPreviewDataUrl(r, g, b, a)
        : getPencilShapePreviewDataUrl(r, g, b, a);
      if (!preview) {
        el.style.display = "none";
        return;
      }
      // Pencil quantises hover positions to the nearest pixel via
      // Math.round(pos.x/y) when stamping (pencil.tsx). Match that here so
      // the preview lands on the same pixel that will actually be
      // plotted — otherwise the cursor floats up to half a pixel off-grid.
      let canvasX = Math.round(pos.x);
      let canvasY = Math.round(pos.y);
      if (
        pencilOptions.pixelBrush &&
        pencilOptions.snapToBrush &&
        "tileW" in preview
      ) {
        canvasX = Math.round(pos.x / preview.tileW) * preview.tileW;
        canvasY = Math.round(pos.y / preview.tileH) * preview.tileH;
      }
      const previewW =
        "previewW" in preview ? preview.previewW : preview.size;
      const previewH =
        "previewH" in preview ? preview.previewH : preview.size;
      const scaledW = (previewW * zoom) / dpr;
      const scaledH = (previewH * zoom) / dpr;
      // Match the pencil's discrete footprint: it stamps
      // `paintBrushPixel(cx + dx, cy + dy)` with dx ∈ [-half, size-half)
      // where half = floor(size/2). So the top-left pixel of the footprint
      // sits at canvasX - half. A continuous `+0.5 - size/2` formulation is
      // half a pixel off for even sizes (pencil biases even brushes toward
      // the top-left).
      const halfW = Math.floor(previewW / 2);
      const halfH = Math.floor(previewH / 2);
      const screenX = ((canvasX - halfW) * zoom) / dpr;
      const screenY = ((canvasY - halfH) * zoom) / dpr;
      el.style.display = "block";
      el.style.left = `${screenX}px`;
      el.style.top = `${screenY}px`;
      el.style.width = `${scaledW}px`;
      el.style.height = `${scaledH}px`;
      el.style.backgroundImage = `url("${preview.dataUrl}")`;
      el.style.backgroundSize = "100% 100%";
      // Pencil hides the OS cursor while hovering — the canvas-native cursor
      // would otherwise sit on top of the preview tile.
      if (canvasRef.current) canvasRef.current.style.cursor = "none";
    },
    [activeTool, pixelBrushCursorRef, canvasRef, zoomRef, primaryColor],
  );

  const hideAll = useCallback((): void => {
    if (brushCursorRef.current) brushCursorRef.current.style.display = "none";
    if (pixelBrushCursorRef.current)
      pixelBrushCursorRef.current.style.display = "none";
  }, [brushCursorRef, pixelBrushCursorRef]);

  return { updateCircleCursor, updatePencilCursor, hideAll };
}
