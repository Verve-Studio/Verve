import React, { useEffect, useState } from "react";

import type {
  Guide,
  TextLayerState,
  ShapeLayerState,
  PathLayerState,
  FrameLayerState,
  LinkedLayerState,
  LayerState,
} from "@/types";
import {
  translatePathNodes,
  translateGradient,
} from "@/ux/main/Canvas/pathRasterizer";
import { isContainerLayer } from "@/types";
import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import moveIconSvg from "./move.svg?raw";
import { activeScope } from "@/core/store/scope";
import { drawTextEditOverlay } from "@/ux/main/Canvas/textRasterizer";

// ─── Snap-to-guide options ────────────────────────────────────────────────────

export type SnapPoint =
  | "center"
  | "upper-left"
  | "upper-right"
  | "lower-left"
  | "lower-right"
  | "vertical-middle"
  | "horizontal-middle";

export const moveOptions = {
  snapToGuide: false,
  snapPoint: "upper-left" as SnapPoint,
};

const SNAP_THRESHOLD_CSS_PX = 8;

interface VisibleBounds {
  /** Inclusive min X in layer-local space */
  minX: number;
  /** Inclusive min Y in layer-local space */
  minY: number;
  /** Exclusive max X in layer-local space */
  maxX: number;
  /** Exclusive max Y in layer-local space */
  maxY: number;
}

/**
 * Computes the tight bounding box of non-transparent pixels in layer-local space.
 * Falls back to the full layer rect if the layer is entirely transparent.
 */
function getVisibleBounds(
  data: Uint8Array | Float32Array,
  w: number,
  h: number,
  format: string,
): VisibleBounds {
  let minX = w,
    minY = h,
    maxX = 0,
    maxY = 0;
  if (format === "rgba32f") {
    const d = data as Float32Array;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x + 1 > maxX) maxX = x + 1;
          if (y < minY) minY = y;
          if (y + 1 > maxY) maxY = y + 1;
        }
      }
    }
  } else if (format === "indexed8") {
    const d = data as Uint8Array;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[y * w + x] !== 255) {
          if (x < minX) minX = x;
          if (x + 1 > maxX) maxX = x + 1;
          if (y < minY) minY = y;
          if (y + 1 > maxY) maxY = y + 1;
        }
      }
    }
  } else {
    // rgba8
    const d = data as Uint8Array;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x + 1 > maxX) maxX = x + 1;
          if (y < minY) minY = y;
          if (y + 1 > maxY) maxY = y + 1;
        }
      }
    }
  }
  // All transparent — fall back to full rect
  if (maxX === 0 || maxY === 0) return { minX: 0, minY: 0, maxX: w, maxY: h };
  return { minX, minY, maxX, maxY };
}

/**
 * Returns the canvas-space offset of the snap anchor from offsetX/offsetY
 * given the visible bounding box (layer-local coords).
 */
function getAnchorOffset(
  bounds: VisibleBounds,
  snapPoint: SnapPoint,
): [number, number] {
  const { minX, minY, maxX, maxY } = bounds;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  switch (snapPoint) {
    case "upper-left":
      return [minX, minY];
    case "upper-right":
      return [maxX, minY];
    case "lower-left":
      return [minX, maxY];
    case "lower-right":
      return [maxX, maxY];
    case "center":
      return [cx, cy];
    case "vertical-middle":
      return [cx, minY]; // top-center edge
    case "horizontal-middle":
      return [minX, cy]; // left-center edge
  }
}

/**
 * Adjusts dx/dy so that the chosen snap-point of the visible pixel bounds
 * snaps to the nearest guide within the threshold. Only operates on
 * whole-layer moves (not selection or text/shape moves).
 */
function snapDelta(
  origX: number,
  origY: number,
  dx: number,
  dy: number,
  bounds: VisibleBounds,
  guides: Guide[],
  zoom: number,
): [number, number] {
  if (!moveOptions.snapToGuide || guides.length === 0) return [dx, dy];
  const dpr = window.devicePixelRatio || 1;
  const threshold = SNAP_THRESHOLD_CSS_PX / (zoom / dpr);
  const [anchorOffX, anchorOffY] = getAnchorOffset(
    bounds,
    moveOptions.snapPoint,
  );
  const anchorX = origX + dx + anchorOffX;
  const anchorY = origY + dy + anchorOffY;
  let snappedDx = dx;
  let snappedDy = dy;
  let minDistX = threshold;
  let minDistY = threshold;
  for (const g of guides) {
    if (g.axis === "v") {
      const d = Math.abs(anchorX - g.position);
      if (d < minDistX) {
        minDistX = d;
        snappedDx = g.position - anchorOffX - origX;
      }
    } else {
      const d = Math.abs(anchorY - g.position);
      if (d < minDistY) {
        minDistY = d;
        snappedDy = g.position - anchorOffY - origY;
      }
    }
  }
  return [snappedDx, snappedDy];
}

// ─── Follower collection ────────────────────────────────────────────────────
//
// When a layer is moved, all of its descendants must move with it — masks
// follow their parent, group/composite children follow their container.
// Every follower (pixel, text, shape, frame, AND mask) shifts via its
// `offsetX/Y` — the composite shader factors mask offset into its sampling
// transform, so a mask is just another GpuLayer with a position.
// Adjustment layers carry no spatial offset and are skipped. Group /
// composite containers have no GpuLayer; we descend into their `childIds`.

interface OffsetFollower {
  gl: GpuLayer;
  origX: number;
  origY: number;
  ls: LayerState;
}

function collectFollowers(
  rootIds: readonly string[],
  ctx: ToolContext,
  excludeFromFollowers: readonly string[] = [],
): { offsetFollowers: OffsetFollower[] } {
  const offsetFs: OffsetFollower[] = [];
  const visited = new Set<string>();
  const excludeSet = new Set(excludeFromFollowers);

  const layersById = new Map(ctx.layerStates.map((l) => [l.id, l]));

  // Pre-compute parent → ids of mask/adjustment layers that point at it.
  const parentToImplicitChildren = new Map<string, string[]>();
  for (const l of ctx.layerStates) {
    if ("type" in l && (l.type === "mask" || l.type === "adjustment")) {
      const arr = parentToImplicitChildren.get(l.parentId) ?? [];
      arr.push(l.id);
      parentToImplicitChildren.set(l.parentId, arr);
    }
  }

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const ls = layersById.get(id);
    if (!ls) return;

    // Excluded ids skip self-as-follower but still propagate descent — so
    // when the active text layer is excluded (its parametric path drives
    // its own GpuLayer offset), its mask child still gets pulled along.
    const skipSelf = excludeSet.has(id);

    if ("type" in ls && ls.type === "adjustment") {
      // Adjustments have no spatial offset.
    } else if (isContainerLayer(ls)) {
      // Container — descend into children. Containers themselves have no GpuLayer.
      for (const childId of ls.childIds) visit(childId);
    } else if (!skipSelf) {
      // Pixel / text / shape / frame / mask — track offsetX/Y.
      const gl = ctx.getGpuLayer(id);
      if (gl) {
        offsetFs.push({ gl, origX: gl.offsetX, origY: gl.offsetY, ls });
      }
    }

    // Implicit mask/adjustment children that point at this layer via parentId.
    const implicit = parentToImplicitChildren.get(id);
    if (implicit) for (const childId of implicit) visit(childId);
  };

  for (const id of rootIds) visit(id);
  return { offsetFollowers: offsetFs };
}

// ─── Display store (live position/size for options bar) ───────────────────────

const moveDisplay = {
  x: null as number | null,
  y: null as number | null,
  w: null as number | null,
  h: null as number | null,
  listeners: new Set<() => void>(),
  subscribe(fn: () => void): void {
    this.listeners.add(fn);
  },
  unsubscribe(fn: () => void): void {
    this.listeners.delete(fn);
  },
  /**
   * X/Y: top-left of the layer in canvas-space (origin = canvas top-left).
   * W/H: pixel dimensions of the layer content.
   */
  set(offsetX: number, offsetY: number, layerW: number, layerH: number): void {
    this.x = offsetX;
    this.y = offsetY;
    this.w = layerW;
    this.h = layerH;
    this.listeners.forEach((fn) => fn());
  },
};

// ─── Handler ──────────────────────────────────────────────────────────────────

function translateShapeLayer(
  ls: ShapeLayerState,
  dx: number,
  dy: number,
): ShapeLayerState {
  const fillGradient = ls.fillGradient
    ? translateGradient(ls.fillGradient, dx, dy)
    : ls.fillGradient;
  if (ls.shapeType === "line") {
    return {
      ...ls,
      x1: ls.x1 + dx,
      y1: ls.y1 + dy,
      x2: ls.x2 + dx,
      y2: ls.y2 + dy,
      fillGradient,
    };
  }
  return { ...ls, cx: ls.cx + dx, cy: ls.cy + dy, fillGradient };
}

function createMoveHandler(): ToolHandler {
  let startX = 0;
  let startY = 0;
  let lastDx = 0;
  let lastDy = 0;
  // For selection move: full pixel copy per-drag
  let originalPixels: Uint8Array | Float32Array | null = null;
  let originalMask: Uint8Array | null = null;
  // For whole-layer move: store original offset of the active layer
  let originalOffsetX = 0;
  let originalOffsetY = 0;
  // Followers: every layer that should move with the active drag —
  // explicitly selected layers + all of their descendants (mask children,
  // group/composite contents, recursively). Computed at pointer-down.
  let offsetFollowers: OffsetFollower[] = [];
  // For text layer move: track original ls.x / ls.y
  let textLayerSnapshot: TextLayerState | null = null;
  let textLayerOrigX = 0;
  let textLayerOrigY = 0;
  // For shape layer move: track original parametric coords
  let shapeLayerSnapshot: ShapeLayerState | null = null;
  // For frame layer move: track original parametric center
  let frameLayerSnapshot: FrameLayerState | null = null;
  // For path layer move: track original node geometry
  let pathLayerSnapshot: PathLayerState | null = null;
  let isDown = false;
  // Cached visible-pixel bounding box for snap-to-guide (computed at pointer-down)
  let cachedVisibleBounds: VisibleBounds | null = null;
  // When true, cachedVisibleBounds is already in canvas-space (pass origX=0/origY=0 to snapDelta)
  let boundsAreCanvasSpace = false;

  function applySelectionMove(dx: number, dy: number, ctx: ToolContext): void {
    const { renderer, layer, layers, render } = ctx;
    const w = renderer.pixelWidth;
    const h = renderer.pixelHeight;
    const lw = layer.layerWidth;
    const lh = layer.layerHeight;
    const src = originalPixels!;
    const dst = layer.data;

    // Step 1: restore original pixels
    dst.set(src);
    // Step 2: erase selected pixels from their original position (in layer-local coords)
    for (let i = 0; i < w * h; i++) {
      const a = originalMask![i];
      if (a === 0) continue;
      const cx = i % w;
      const cy = Math.floor(i / w);
      const lx = cx - layer.offsetX;
      const ly = cy - layer.offsetY;
      if (lx < 0 || ly < 0 || lx >= lw || ly >= lh) continue;
      const pi = (ly * lw + lx) * 4;
      const f = 1 - a / 255;
      dst[pi] = Math.round(dst[pi] * f);
      dst[pi + 1] = Math.round(dst[pi + 1] * f);
      dst[pi + 2] = Math.round(dst[pi + 2] * f);
      dst[pi + 3] = Math.round(dst[pi + 3] * f);
    }
    // Step 3: composite selected pixels at the new position (over)
    for (let sy = 0; sy < h; sy++) {
      const ty = sy + dy;
      if (ty < 0 || ty >= h) continue;
      for (let sx = 0; sx < w; sx++) {
        const tx = sx + dx;
        if (tx < 0 || tx >= w) continue;
        const mi = sy * w + sx;
        const a = originalMask![mi];
        if (a === 0) continue;
        const slx = sx - layer.offsetX;
        const sly = sy - layer.offsetY;
        if (slx < 0 || sly < 0 || slx >= lw || sly >= lh) continue;
        const si = (sly * lw + slx) * 4;
        const tlx = tx - layer.offsetX;
        const tly = ty - layer.offsetY;
        if (tlx < 0 || tly < 0 || tlx >= lw || tly >= lh) continue;
        const di = (tly * lw + tlx) * 4;
        const srcA = (src[si + 3] * a) / 255;
        const dstA = dst[di + 3];
        const outA = srcA + dstA * (1 - srcA / 255);
        if (outA === 0) continue;
        dst[di] = Math.round(
          (src[si] * srcA + dst[di] * dstA * (1 - srcA / 255)) / outA,
        );
        dst[di + 1] = Math.round(
          (src[si + 1] * srcA + dst[di + 1] * dstA * (1 - srcA / 255)) / outA,
        );
        dst[di + 2] = Math.round(
          (src[si + 2] * srcA + dst[di + 2] * dstA * (1 - srcA / 255)) / outA,
        );
        dst[di + 3] = Math.min(255, Math.round(outA));
      }
    }

    renderer.flushLayer(layer);
    render(layers);
  }

  // While dragging a text layer, we hide its GpuLayer and render the text on
  // the overlay canvas via Canvas2D. This skips per-frame GPU rasterisation,
  // texture upload, AND effect re-encoding (the adjustment-group cache key
  // includes the layer's offsetX/Y, so shifting offset would otherwise bust
  // the cache and force every layer effect to recompute every frame).
  let hiddenTextLayer: { visible: boolean } | null = null;

  return {
    onPointerDown({ x, y }: ToolPointerPos, ctx: ToolContext) {
      startX = Math.round(x);
      startY = Math.round(y);
      lastDx = 0;
      lastDy = 0;
      isDown = true;
      textLayerSnapshot =
        ctx.textLayers.find((t) => t.id === ctx.layer.id) ?? null;
      shapeLayerSnapshot =
        ctx.shapeLayers.find((s) => s.id === ctx.layer.id) ?? null;
      frameLayerSnapshot =
        ctx.frameLayers.find((f) => f.id === ctx.layer.id) ?? null;
      pathLayerSnapshot =
        ctx.pathLayers.find((p) => p.id === ctx.layer.id) ?? null;

      // Set up the overlay-canvas drag preview for text layers (skipped when
      // a selection mask is active — that goes through the pixel-copy path).
      if (
        textLayerSnapshot &&
        ctx.overlayCanvas &&
        !activeScope().selection.mask
      ) {
        drawTextEditOverlay(ctx.overlayCanvas, textLayerSnapshot);
        hiddenTextLayer = ctx.layer;
        ctx.layer.visible = false;
      }

      const selMask = activeScope().selection.mask;
      if (selMask) {
        // Selection move: pixel-copy approach (selection moves pixels, offset unchanged)
        originalPixels = ctx.layer.data.slice();
        originalMask = selMask.slice();
        originalOffsetX = 0;
        originalOffsetY = 0;
        offsetFollowers = [];
        cachedVisibleBounds = null;
      } else {
        // Whole-layer move (and parametric paths): set up followers.
        originalPixels = null;
        originalMask = null;
        originalOffsetX = ctx.layer.offsetX;
        originalOffsetY = ctx.layer.offsetY;
        if (textLayerSnapshot) {
          textLayerOrigX = textLayerSnapshot.x;
          textLayerOrigY = textLayerSnapshot.y;
        }

        // Roots = active layer + extra-selected layers. The active layer
        // is excluded from offsetFollowers when ctx.layer is parametric
        // because the parametric path drives ctx.layer's GpuLayer offset
        // directly during drag and bakes the result on pointer-up.
        const rootIds = [
          ctx.layer.id,
          ...ctx.selectedLayerIds.filter((id) => id !== ctx.layer.id),
        ];
        const isActiveParametric =
          textLayerSnapshot !== null ||
          shapeLayerSnapshot !== null ||
          frameLayerSnapshot !== null ||
          pathLayerSnapshot !== null;
        const exclude = isActiveParametric ? [ctx.layer.id] : [];
        const followers = collectFollowers(rootIds, ctx, exclude);
        offsetFollowers = followers.offsetFollowers;

        // Visible-bounds union across every offset-follower for snap-to-guide.
        // Mask followers are full-canvas and don't contribute a meaningful
        // visual bound. Parametric active layers are included when present
        // (their GpuLayer holds the rasterised content).
        const boundsLayers: GpuLayer[] = offsetFollowers
          .filter((f) => !("type" in f.ls && f.ls.type === "mask"))
          .map((f) => f.gl);
        if (isActiveParametric) boundsLayers.push(ctx.layer);

        // The single-layer fast path (layer-local bounds + snapOrigX = the
        // active layer's offset) is only valid when the lone follower IS
        // the active layer. When it's a *child* of the active layer (e.g.
        // a group with one pixel layer), the active layer's offset is a
        // placeholder unrelated to the child's actual position — fall
        // through to canvas-space union which references each follower's
        // own offset.
        if (boundsLayers.length === 0) {
          cachedVisibleBounds = getVisibleBounds(
            ctx.layer.data,
            ctx.layer.layerWidth,
            ctx.layer.layerHeight,
            ctx.layer.format,
          );
          boundsAreCanvasSpace = false;
        } else if (
          boundsLayers.length === 1 &&
          !isActiveParametric &&
          boundsLayers[0] === ctx.layer
        ) {
          cachedVisibleBounds = getVisibleBounds(
            boundsLayers[0].data,
            boundsLayers[0].layerWidth,
            boundsLayers[0].layerHeight,
            boundsLayers[0].format,
          );
          boundsAreCanvasSpace = false;
        } else {
          let uMinX = Infinity,
            uMinY = Infinity,
            uMaxX = -Infinity,
            uMaxY = -Infinity;
          for (const gl of boundsLayers) {
            const b = getVisibleBounds(
              gl.data,
              gl.layerWidth,
              gl.layerHeight,
              gl.format,
            );
            uMinX = Math.min(uMinX, b.minX + gl.offsetX);
            uMinY = Math.min(uMinY, b.minY + gl.offsetY);
            uMaxX = Math.max(uMaxX, b.maxX + gl.offsetX);
            uMaxY = Math.max(uMaxY, b.maxY + gl.offsetY);
          }
          cachedVisibleBounds = {
            minX: uMinX,
            minY: uMinY,
            maxX: uMaxX,
            maxY: uMaxY,
          };
          boundsAreCanvasSpace = true;
        }
      }
      moveDisplay.set(
        ctx.layer.offsetX,
        ctx.layer.offsetY,
        ctx.layer.layerWidth,
        ctx.layer.layerHeight,
      );
    },

    onPointerMove({ x, y }: ToolPointerPos, ctx: ToolContext) {
      if (!isDown) return;
      const dx = Math.round(x) - startX;
      const dy = Math.round(y) - startY;
      if (dx === lastDx && dy === lastDy) return;
      lastDx = dx;
      lastDy = dy;

      if (originalPixels) {
        applySelectionMove(dx, dy, ctx);
      } else {
        // Whole-layer / parametric move. Compute snapped delta once and
        // apply it to: the active layer (via parametric path or offset
        // shift), every offset-follower, and every mask-follower.
        ctx.renderer.setPreviewMode(true);
        const bounds = cachedVisibleBounds ?? {
          minX: 0,
          minY: 0,
          maxX: ctx.layer.layerWidth,
          maxY: ctx.layer.layerHeight,
        };
        const snapOrigX = boundsAreCanvasSpace ? 0 : originalOffsetX;
        const snapOrigY = boundsAreCanvasSpace ? 0 : originalOffsetY;
        const [sdx, sdy] = snapDelta(
          snapOrigX,
          snapOrigY,
          dx,
          dy,
          bounds,
          ctx.guides,
          ctx.zoom,
        );

        if (textLayerSnapshot && ctx.overlayCanvas) {
          // Active text: GpuLayer is hidden — repaint the overlay at the
          // dragged position via Canvas2D. No GPU work, no cache busts.
          drawTextEditOverlay(ctx.overlayCanvas, {
            ...textLayerSnapshot,
            x: textLayerOrigX + sdx,
            y: textLayerOrigY + sdy,
          });
        } else if (textLayerSnapshot || shapeLayerSnapshot || pathLayerSnapshot) {
          // Active shape / path: shift via GpuLayer offset; final rasterise
          // happens on pointer-up.
          ctx.layer.offsetX = sdx;
          ctx.layer.offsetY = sdy;
        } else if (frameLayerSnapshot) {
          // Active frame: live-preview by re-rasterising at the new centre
          // (so the bounding-box overlay stays in lock-step).
          ctx.previewFrameLayer({
            ...frameLayerSnapshot,
            cx: frameLayerSnapshot.cx + sdx,
            cy: frameLayerSnapshot.cy + sdy,
          });
        } else {
          // Plain whole-layer move: ctx.layer is in offsetFollowers and
          // gets shifted by the loop below.
        }

        // Apply (sdx, sdy) to every offset follower (including ctx.layer
        // for the non-parametric path).
        for (const f of offsetFollowers) {
          f.gl.offsetX = f.origX + sdx;
          f.gl.offsetY = f.origY + sdy;
        }

        ctx.render(ctx.layers);
      }
      moveDisplay.set(
        ctx.layer.offsetX,
        ctx.layer.offsetY,
        ctx.layer.layerWidth,
        ctx.layer.layerHeight,
      );
    },

    onPointerUp({ x, y }: ToolPointerPos, ctx: ToolContext) {
      if (!isDown) return;
      isDown = false;
      const dx = Math.round(x) - startX;
      const dy = Math.round(y) - startY;

      if (originalPixels) {
        if (dx !== lastDx || dy !== lastDy) applySelectionMove(dx, dy, ctx);
        if (originalMask && (dx !== 0 || dy !== 0))
          activeScope().selection.translateMask(dx, dy);
        originalPixels = null;
        originalMask = null;
      } else {
        const finalDx = dx !== lastDx || dy !== lastDy ? dx : lastDx;
        const finalDy = dx !== lastDx || dy !== lastDy ? dy : lastDy;
        const bounds = cachedVisibleBounds ?? {
          minX: 0,
          minY: 0,
          maxX: ctx.layer.layerWidth,
          maxY: ctx.layer.layerHeight,
        };
        const snapOrigX = boundsAreCanvasSpace ? 0 : originalOffsetX;
        const snapOrigY = boundsAreCanvasSpace ? 0 : originalOffsetY;
        const [sdx, sdy] = snapDelta(
          snapOrigX,
          snapOrigY,
          finalDx,
          finalDy,
          bounds,
          ctx.guides,
          ctx.zoom,
        );

        ctx.renderer.setPreviewMode(false);

        // Restore the hidden text-layer visibility and clear the overlay
        // before the commit re-rasterises and re-renders, so the GpuLayer
        // shows at its new position without a one-frame flicker.
        if (hiddenTextLayer) {
          hiddenTextLayer.visible = true;
          hiddenTextLayer = null;
        }
        if (ctx.overlayCanvas) {
          const oc2d = ctx.overlayCanvas.getContext("2d");
          oc2d?.clearRect(
            0,
            0,
            ctx.overlayCanvas.width,
            ctx.overlayCanvas.height,
          );
        }

        // Active layer commit — parametric paths bake the offset into the
        // layer's parametric x/y/cx/cy and reset GpuLayer offset to 0.
        if (textLayerSnapshot) {
          ctx.layer.offsetX = 0;
          ctx.layer.offsetY = 0;
          ctx.previewTextAt(
            textLayerSnapshot,
            textLayerOrigX + sdx,
            textLayerOrigY + sdy,
          );
          ctx.updateTextLayer({
            ...textLayerSnapshot,
            x: textLayerOrigX + sdx,
            y: textLayerOrigY + sdy,
          });
          textLayerSnapshot = null;
        } else if (shapeLayerSnapshot) {
          const moved = translateShapeLayer(shapeLayerSnapshot, sdx, sdy);
          ctx.layer.offsetX = 0;
          ctx.layer.offsetY = 0;
          ctx.previewShapeLayer(moved);
          ctx.updateShapeLayer(moved);
          shapeLayerSnapshot = null;
        } else if (frameLayerSnapshot) {
          const moved: FrameLayerState = {
            ...frameLayerSnapshot,
            cx: frameLayerSnapshot.cx + sdx,
            cy: frameLayerSnapshot.cy + sdy,
          };
          ctx.previewFrameLayer(moved);
          ctx.updateFrameLayer(moved);
          frameLayerSnapshot = null;
        } else if (pathLayerSnapshot) {
          const moved: PathLayerState = {
            ...pathLayerSnapshot,
            nodes: translatePathNodes(pathLayerSnapshot.nodes, sdx, sdy),
            fillGradient: pathLayerSnapshot.fillGradient
              ? translateGradient(pathLayerSnapshot.fillGradient, sdx, sdy)
              : pathLayerSnapshot.fillGradient,
          };
          ctx.layer.offsetX = 0;
          ctx.layer.offsetY = 0;
          ctx.previewPathLayer(moved);
          ctx.updatePathLayer(moved);
          pathLayerSnapshot = null;
        }

        // Followers — every descendant + extra-selected layer (and the
        // active layer itself for the non-parametric path). Parametric
        // followers (text/shape/frame inside a group) need their
        // parametric coordinates baked, otherwise the next re-rasterise
        // (e.g. on text edit) places them back at the original position.
        for (const f of offsetFollowers) {
          f.gl.offsetX = f.origX + sdx;
          f.gl.offsetY = f.origY + sdy;
          if ("type" in f.ls && f.ls.type === "text") {
            const text = ctx.textLayers.find((t) => t.id === f.ls.id);
            if (text) {
              const moved: TextLayerState = {
                ...text,
                x: text.x + sdx,
                y: text.y + sdy,
              };
              f.gl.offsetX = 0;
              f.gl.offsetY = 0;
              ctx.previewTextAt(moved, moved.x, moved.y);
              ctx.updateTextLayer(moved);
            }
          } else if ("type" in f.ls && f.ls.type === "shape") {
            const shape = ctx.shapeLayers.find((s) => s.id === f.ls.id);
            if (shape) {
              const moved = translateShapeLayer(shape, sdx, sdy);
              f.gl.offsetX = 0;
              f.gl.offsetY = 0;
              ctx.previewShapeLayer(moved);
              ctx.updateShapeLayer(moved);
            }
          } else if ("type" in f.ls && f.ls.type === "frame") {
            const frame = ctx.frameLayers.find((fr) => fr.id === f.ls.id);
            if (frame) {
              const moved: FrameLayerState = {
                ...frame,
                cx: frame.cx + sdx,
                cy: frame.cy + sdy,
              };
              ctx.previewFrameLayer(moved);
              ctx.updateFrameLayer(moved);
            }
          } else if ("type" in f.ls && f.ls.type === "path") {
            const path = ctx.pathLayers.find((p) => p.id === f.ls.id);
            if (path) {
              const moved: PathLayerState = {
                ...path,
                nodes: translatePathNodes(path.nodes, sdx, sdy),
                fillGradient: path.fillGradient
                  ? translateGradient(path.fillGradient, sdx, sdy)
                  : path.fillGradient,
              };
              f.gl.offsetX = 0;
              f.gl.offsetY = 0;
              ctx.previewPathLayer(moved);
              ctx.updatePathLayer(moved);
            }
          } else if ("type" in f.ls && f.ls.type === "linked") {
            // Linked layers are canvas-sized; centerX/Y is baked into the
            // buffer at rasterise time. The drag preview leaves the old
            // buffer in place and just shifts the GpuLayer offset — keep it
            // shifted here. `useGpuLayerSync` resets the offset to 0 only
            // AFTER the new buffer (rasterised at the updated centre) is
            // ready, which avoids the one-frame snap-back to the old centre.
            const moved: LinkedLayerState = {
              ...f.ls,
              centerX: f.ls.centerX + sdx,
              centerY: f.ls.centerY + sdy,
            };
            ctx.updateLinkedLayer(moved);
          }
        }
        offsetFollowers = [];
        boundsAreCanvasSpace = false;
        ctx.render(ctx.layers);
      }
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function MoveOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [pos, setPos] = useState({
    x: moveDisplay.x,
    y: moveDisplay.y,
    w: moveDisplay.w,
    h: moveDisplay.h,
  });
  const [snapToGuide, setSnapToGuide] = useState(moveOptions.snapToGuide);
  const [snapPoint, setSnapPoint] = useState<SnapPoint>(moveOptions.snapPoint);

  useEffect(() => {
    const sync = (): void =>
      setPos({
        x: moveDisplay.x,
        y: moveDisplay.y,
        w: moveDisplay.w,
        h: moveDisplay.h,
      });
    moveDisplay.subscribe(sync);
    return () => moveDisplay.unsubscribe(sync);
  }, []);

  const fmt = (v: number | null): string => (v !== null ? String(v) : "—");

  return (
    <>
      <label className={styles.optLabel}>X:</label>
      <span className={styles.optText}>{fmt(pos.x)}</span>
      <label className={styles.optLabel}>Y:</label>
      <span className={styles.optText}>{fmt(pos.y)}</span>
      <span className={styles.optSep} />
      <label className={styles.optLabel}>W:</label>
      <span className={styles.optText}>{fmt(pos.w)}</span>
      <label className={styles.optLabel}>H:</label>
      <span className={styles.optText}>{fmt(pos.h)}</span>
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={snapToGuide}
          onChange={(e) => {
            moveOptions.snapToGuide = e.target.checked;
            setSnapToGuide(e.target.checked);
          }}
        />
        Snap to Guide
      </label>
      {snapToGuide && (
        <select
          className={styles.optSelect}
          value={snapPoint}
          onChange={(e) => {
            const v = e.target.value as SnapPoint;
            moveOptions.snapPoint = v;
            setSnapPoint(v);
          }}
        >
          <option value="upper-left">Upper Left</option>
          <option value="upper-right">Upper Right</option>
          <option value="lower-left">Lower Left</option>
          <option value="lower-right">Lower Right</option>
          <option value="center">Center</option>
          <option value="vertical-middle">Vertical Middle</option>
          <option value="horizontal-middle">Horizontal Middle</option>
        </select>
      )}
    </>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

class MoveTool implements ITool {
  readonly id = "move";
  readonly label = "Move";
  readonly shortcut = "V";
  readonly icon = <SvgIcon src={moveIconSvg} />;
  readonly placement = { group: ToolGroup.Move, row: 0, column: 0 } as const;
  readonly modifiesPixels = true;
  readonly worksOnAllLayers = true;
  createHandler(): ToolHandler {
    return createMoveHandler();
  }
  readonly Options = MoveOptions;
}

export const moveTool: ITool = new MoveTool();
