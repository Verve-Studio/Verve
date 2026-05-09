import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ShapeLayerState, ShapeType, RGBAColor } from "@/types";
import { useAppContext } from "@/core/store/AppContext";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import { ColorSwatch } from "@/ux/widgets/ColorSwatch/ColorSwatch";
import swatchStyles from "@/ux/widgets/ColorSwatch/ColorSwatch.module.scss";
import { IndexedPaletteColorPicker } from "@/ux/widgets/IndexedPaletteColorPicker/IndexedPaletteColorPicker";
import { buildShapePath, rgbaToStr } from "../../ux/main/Canvas/shapeRasterizer";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool, ToolButtonRenderProps } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import shapeIconSvg from "./shape.svg?raw";
import { resizeCursorForHandle } from "../_shared/resizeCursor";

// ─── Module-level defaults for new shapes ────────────────────────────────────

export const shapeOptions = {
  shapeType: "rectangle" as ShapeType,
  strokeWidth: 2,
  cornerRadius: 0,
  antiAlias: true,
  useStroke: true,
  useFill: false,
  /** null = defer to primary color at draw time */
  strokeColor: null as RGBAColor | null,
  /** null = defer to secondary color at draw time */
  fillColor: null as RGBAColor | null,
  /** Palette-index reference for indexed8 picks. undefined = freeform colour. */
  strokeIndex: undefined as number | undefined,
  fillIndex: undefined as number | undefined,
};

// ─── Color conversion helpers ─────────────────────────────────────────────────

function rgbaToHex(c: RGBAColor): string {
  return (
    "#" +
    [c.r, c.g, c.b]
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("")
  );
}

function hexToRgba(hex: string, a = 255): RGBAColor {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
    a,
  };
}

/** Convert float primary/secondary color [0,1] to shape-space [0,255]. */
function floatToShape(c: RGBAColor): RGBAColor {
  return {
    r: Math.round(Math.min(c.r, 1) * 255),
    g: Math.round(Math.min(c.g, 1) * 255),
    b: Math.round(Math.min(c.b, 1) * 255),
    a: Math.round(c.a * 255),
  };
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function rotatePoint(
  px: number,
  py: number,
  angleRad: number,
): [number, number] {
  const cos = Math.cos(angleRad),
    sin = Math.sin(angleRad);
  return [px * cos - py * sin, px * sin + py * cos];
}

function worldToLocal(
  wx: number,
  wy: number,
  cx: number,
  cy: number,
  angleRad: number,
): [number, number] {
  const dx = wx - cx,
    dy = wy - cy;
  return rotatePoint(dx, dy, -angleRad);
}

/**
 * Returns the 9 handle world positions for a non-line shape.
 * Indices 0-7: corners and edge mid-points of the bounding box.
 * Index 8: rotation handle (20 canvas-px above top edge mid-point).
 */
const ROTATION_OFFSET = 20;

export function getHandleWorldPositions(
  ls: ShapeLayerState,
): [number, number][] {
  const rad = (ls.rotation * Math.PI) / 180;
  const { cx, cy, w, h } = ls;
  const hw = w / 2,
    hh = h / 2;

  const locals: [number, number][] = [
    [-hw, -hh],
    [0, -hh],
    [hw, -hh], // 0 TL, 1 TC, 2 TR
    [-hw, 0],
    [hw, 0], // 3 ML,       4 MR
    [-hw, hh],
    [0, hh],
    [hw, hh], // 5 BL, 6 BC, 7 BR
    [0, -hh - ROTATION_OFFSET], // 8 rotation
  ];

  return locals.map(([lx, ly]) => {
    const [rx, ry] = rotatePoint(lx, ly, rad);
    return [cx + rx, cy + ry];
  });
}

function hitTestHandles(
  ls: ShapeLayerState,
  x: number,
  y: number,
  zoom: number,
): number | null {
  const dpr = window.devicePixelRatio;
  // Handle radius in canvas pixels — keeps a consistent ~5 CSS-px target
  const r = Math.max(4, (5 * dpr) / zoom) + 2;

  const handles =
    ls.shapeType === "line"
      ? ([
          [ls.x1, ls.y1],
          [ls.x2, ls.y2],
        ] as [number, number][])
      : getHandleWorldPositions(ls);

  for (let i = 0; i < handles.length; i++) {
    const [hx, hy] = handles[i];
    if ((x - hx) ** 2 + (y - hy) ** 2 <= r * r) return i;
  }
  return null;
}

function hitTestShapeInterior(
  ls: ShapeLayerState,
  x: number,
  y: number,
): boolean {
  if (ls.shapeType === "line") {
    const { x1, y1, x2, y2, strokeWidth } = ls;
    const len2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    if (len2 < 1) return false;
    const t = Math.max(
      0,
      Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / len2),
    );
    const d2 =
      (x - (x1 + t * (x2 - x1))) ** 2 + (y - (y1 + t * (y2 - y1))) ** 2;
    return d2 <= Math.max(6, strokeWidth / 2 + 4) ** 2;
  }
  const [lx, ly] = worldToLocal(
    x,
    y,
    ls.cx,
    ls.cy,
    (ls.rotation * Math.PI) / 180,
  );
  return Math.abs(lx) <= ls.w / 2 + 4 && Math.abs(ly) <= ls.h / 2 + 4;
}

// ─── Resize a shape by dragging handle `handleIdx` to world position ──────────

// Opposite handle index for each of the 8 resize handles
const OPPOSITE: number[] = [7, 6, 5, 4, 3, 2, 1, 0];

function applyResize(
  ls: ShapeLayerState,
  handleIdx: number,
  worldDragX: number,
  worldDragY: number,
): ShapeLayerState {
  const rad = (ls.rotation * Math.PI) / 180;
  const hw = ls.w / 2,
    hh = ls.h / 2;

  // All 8 handle local positions
  const LOCAL: [number, number][] = [
    [-hw, -hh],
    [0, -hh],
    [hw, -hh],
    [-hw, 0],
    [hw, 0],
    [-hw, hh],
    [0, hh],
    [hw, hh],
  ];

  const [ax, ay] = LOCAL[OPPOSITE[handleIdx]];

  // Drag point in old local space (centred at ls.cx/cy, unrotated)
  const [lx, ly] = worldToLocal(worldDragX, worldDragY, ls.cx, ls.cy, rad);

  let xMin: number, xMax: number, yMin: number, yMax: number;

  if (handleIdx === 1 || handleIdx === 6) {
    // TC / BC — preserve full width, scale height only
    xMin = -hw;
    xMax = hw;
    yMin = Math.min(ay, ly);
    yMax = Math.max(ay, ly);
  } else if (handleIdx === 3 || handleIdx === 4) {
    // ML / MR — preserve full height, scale width only
    yMin = -hh;
    yMax = hh;
    xMin = Math.min(ax, lx);
    xMax = Math.max(ax, lx);
  } else {
    // Corner — both axes
    xMin = Math.min(ax, lx);
    xMax = Math.max(ax, lx);
    yMin = Math.min(ay, ly);
    yMax = Math.max(ay, ly);
  }

  const newW = Math.max(1, xMax - xMin);
  const newH = Math.max(1, yMax - yMin);

  // New local centre → back to world space
  const newLocalCx = (xMin + xMax) / 2;
  const newLocalCy = (yMin + yMax) / 2;
  const [rwx, rwy] = rotatePoint(newLocalCx, newLocalCy, rad);

  return { ...ls, cx: ls.cx + rwx, cy: ls.cy + rwy, w: newW, h: newH };
}

// ─── Overlay drawing ──────────────────────────────────────────────────────────

function clearOverlay(oc: HTMLCanvasElement): void {
  const c = oc.getContext("2d");
  if (c) c.clearRect(0, 0, oc.width, oc.height);
}

/** Inner handles chrome — no clearRect so it can compose on top of other drawings. */
function _drawHandlesBody(
  c: CanvasRenderingContext2D,
  ls: ShapeLayerState,
  zoom: number,
): void {
  const dpr = window.devicePixelRatio;
  const handleR = Math.max(3.5, (5 * dpr) / zoom); // canvas px radius

  if (ls.shapeType === "line") {
    // Draw the line itself as a highlight, then endpoint handles
    c.save();
    c.strokeStyle = "rgba(0,120,255,0.6)";
    c.lineWidth = Math.max(1, ls.strokeWidth + 2);
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(ls.x1, ls.y1);
    c.lineTo(ls.x2, ls.y2);
    c.stroke();

    for (const [hx, hy] of [
      [ls.x1, ls.y1],
      [ls.x2, ls.y2],
    ]) {
      c.beginPath();
      c.arc(hx, hy, handleR, 0, Math.PI * 2);
      c.fillStyle = "#ffffff";
      c.fill();
      c.lineWidth = Math.max(0.5, dpr / zoom);
      c.strokeStyle = "#0078ff";
      c.stroke();
    }
    c.restore();
    return;
  }

  const rad = (ls.rotation * Math.PI) / 180;
  const handles = getHandleWorldPositions(ls);
  const hw = ls.w / 2,
    hh = ls.h / 2;

  // Dashed bounding box
  c.save();
  c.translate(ls.cx, ls.cy);
  c.rotate(rad);
  c.strokeStyle = "rgba(0,120,255,0.85)";
  c.lineWidth = Math.max(0.5, dpr / zoom);
  c.setLineDash([Math.max(2, (4 * dpr) / zoom), Math.max(2, (3 * dpr) / zoom)]);
  c.strokeRect(-hw, -hh, ls.w, ls.h);
  c.setLineDash([]);
  c.restore();

  // Line from bounding box top-centre to rotation handle
  const [tcx, tcy] = handles[1];
  const [rhx, rhy] = handles[8];
  c.save();
  c.strokeStyle = "rgba(0,120,255,0.6)";
  c.lineWidth = Math.max(0.5, dpr / zoom);
  c.beginPath();
  c.moveTo(tcx, tcy);
  c.lineTo(rhx, rhy);
  c.stroke();
  c.restore();

  // Draw the 8 resize handles (squares) and rotation handle (circle)
  for (let i = 0; i < handles.length; i++) {
    const [hx, hy] = handles[i];
    c.save();
    if (i === 8) {
      // Rotation circle
      c.beginPath();
      c.arc(hx, hy, handleR, 0, Math.PI * 2);
      c.fillStyle = "#ffffff";
      c.fill();
      c.strokeStyle = "#0078ff";
      c.lineWidth = Math.max(0.8, (1.5 * dpr) / zoom);
      c.stroke();
      // Small rotation icon inside
      c.beginPath();
      c.arc(hx, hy, handleR * 0.55, Math.PI * 0.2, Math.PI * 1.8);
      c.strokeStyle = "#0078ff";
      c.lineWidth = Math.max(0.5, dpr / zoom);
      c.stroke();
    } else {
      // Square resize handle
      const s = handleR * 1.4;
      c.translate(hx, hy);
      c.rotate(rad);
      c.fillStyle = "#ffffff";
      c.fillRect(-s / 2, -s / 2, s, s);
      c.strokeStyle = "#0078ff";
      c.lineWidth = Math.max(0.8, (1.5 * dpr) / zoom);
      c.strokeRect(-s / 2, -s / 2, s, s);
    }
    c.restore();
  }
}

/** Draw shape outline + bounding box handles on the tool overlay canvas. */
function drawHandles(
  oc: HTMLCanvasElement,
  ls: ShapeLayerState,
  zoom: number,
): void {
  const c = oc.getContext("2d");
  if (!c) return;
  c.clearRect(0, 0, oc.width, oc.height);
  _drawHandlesBody(c, ls, zoom);
}

/**
 * Draw the shape's real fill+stroke appearance plus selection handles.
 * Used during live edits (move/resize/rotate/endpoint) so GPU rasterization
 * is skipped entirely — every drag frame is pure Canvas2D on the overlay.
 */
function drawShapeEditOverlay(
  oc: HTMLCanvasElement,
  ls: ShapeLayerState,
  zoom: number,
): void {
  const c = oc.getContext("2d");
  if (!c) return;
  c.clearRect(0, 0, oc.width, oc.height);

  // Draw the shape's actual appearance
  c.save();
  if (ls.shapeType === "line") {
    if (ls.strokeColor && ls.strokeWidth > 0) {
      c.strokeStyle = rgbaToStr(ls.strokeColor);
      c.lineWidth = ls.strokeWidth;
      c.lineCap = "round";
      c.beginPath();
      c.moveTo(ls.x1, ls.y1);
      c.lineTo(ls.x2, ls.y2);
      c.stroke();
    }
  } else {
    c.translate(ls.cx, ls.cy);
    c.rotate((ls.rotation * Math.PI) / 180);
    buildShapePath(c, ls);
    if (ls.fillColor) {
      c.fillStyle = rgbaToStr(ls.fillColor);
      c.fill();
    }
    if (ls.strokeColor && ls.strokeWidth > 0) {
      c.strokeStyle = rgbaToStr(ls.strokeColor);
      c.lineWidth = ls.strokeWidth;
      c.stroke();
    }
  }
  c.restore();

  // Draw handles chrome on top
  _drawHandlesBody(c, ls, zoom);
}

/** Draw a dashed preview of the shape being drawn on the overlay canvas. */
function drawCreationPreview(oc: HTMLCanvasElement, ls: ShapeLayerState): void {
  const c = oc.getContext("2d");
  if (!c) return;
  c.clearRect(0, 0, oc.width, oc.height);
  c.save();
  c.strokeStyle = ls.strokeColor
    ? rgbaToStr(ls.strokeColor)
    : "rgba(0,120,255,0.85)";
  c.lineWidth = Math.max(1, ls.strokeWidth);
  c.setLineDash([4, 3]);

  if (ls.shapeType === "line") {
    c.beginPath();
    c.moveTo(ls.x1, ls.y1);
    c.lineTo(ls.x2, ls.y2);
    c.stroke();
  } else {
    c.translate(ls.cx, ls.cy);
    c.rotate((ls.rotation * Math.PI) / 180);
    buildShapePath(c, ls);
    if (ls.fillColor) {
      c.fillStyle = rgbaToStr(ls.fillColor);
      c.fill();
    }
    c.stroke();
  }
  c.restore();
}

// ─── Shape name formatter ─────────────────────────────────────────────────────

function shapeName(t: ShapeType): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ─── Drawing-mode state (per handler instance) ────────────────────────────────

type DrawMode =
  | { t: "idle"; id: string }
  | { t: "draw"; id: string; sx: number; sy: number }
  | {
      t: "move";
      id: string;
      gx: number;
      gy: number;
      ocx: number;
      ocy: number;
      ox1: number;
      oy1: number;
      ox2: number;
      oy2: number;
      last: ShapeLayerState;
    }
  | { t: "resize"; id: string; hi: number; last: ShapeLayerState }
  | { t: "rotate"; id: string; ga: number; or: number; last: ShapeLayerState }
  | { t: "endpoint"; id: string; ep: 0 | 1; last: ShapeLayerState };

// ─── Handler factory ──────────────────────────────────────────────────────────

function createShapeHandler(): ToolHandler {
  let mode: DrawMode = { t: "idle", id: "" };
  let drawPreview: ShapeLayerState | null = null; // scratch layer used only during 'draw'
  // GpuLayer hidden during a live shape edit to avoid stale-position compositing
  let editLayer: { visible: boolean } | null = null;

  function getActive(ctx: ToolContext): ShapeLayerState | null {
    return ctx.activeShapeLayer;
  }

  function modeShape(ctx: ToolContext): ShapeLayerState | null {
    if (mode.t === "idle" || mode.t === "draw") return null;
    return ctx.shapeLayers.find((s) => s.id === mode.id) ?? null;
  }

  return {
    onActivate(ctx: ToolContext): void {
      // Draw handles for the active shape immediately so the user lands in
      // edit mode (e.g. after double-clicking the shape via the pick tool).
      const active = getActive(ctx);
      if (active && ctx.overlayCanvas) {
        drawHandles(ctx.overlayCanvas, active, ctx.zoom);
      } else if (ctx.overlayCanvas) {
        const c2d = ctx.overlayCanvas.getContext("2d");
        c2d?.clearRect(
          0,
          0,
          ctx.overlayCanvas.width,
          ctx.overlayCanvas.height,
        );
      }
    },
    onPointerDown({ x, y }: ToolPointerPos, ctx: ToolContext): void {
      const active = getActive(ctx);
      if (active) {
        const hi = hitTestHandles(active, x, y, ctx.zoom);
        if (hi !== null) {
          if (active.shapeType === "line") {
            mode = {
              t: "endpoint",
              id: active.id,
              ep: hi as 0 | 1,
              last: active,
            };
          } else if (hi === 8) {
            const ga =
              (Math.atan2(y - active.cy, x - active.cx) * 180) / Math.PI;
            mode = {
              t: "rotate",
              id: active.id,
              ga,
              or: active.rotation,
              last: active,
            };
          } else {
            mode = { t: "resize", id: active.id, hi, last: active };
          }
          // Draw overlay first so the shape appears seamlessly before the GPU layer is hidden,
          // then hide the layer and re-render — eliminates the flicker frame.
          if (ctx.layer && ctx.overlayCanvas) {
            drawShapeEditOverlay(ctx.overlayCanvas, active, ctx.zoom);
            editLayer = ctx.layer;
            ctx.layer.visible = false;
            ctx.renderer.setPreviewMode(true);
            ctx.render();
          } else if (ctx.layer) {
            editLayer = ctx.layer;
            ctx.layer.visible = false;
            ctx.renderer.setPreviewMode(true);
            ctx.render();
          }
          return;
        }
        if (hitTestShapeInterior(active, x, y)) {
          mode = {
            t: "move",
            id: active.id,
            gx: x,
            gy: y,
            ocx: active.cx,
            ocy: active.cy,
            ox1: active.x1,
            oy1: active.y1,
            ox2: active.x2,
            oy2: active.y2,
            last: active,
          };
          if (ctx.layer && ctx.overlayCanvas) {
            drawShapeEditOverlay(ctx.overlayCanvas, active, ctx.zoom);
            editLayer = ctx.layer;
            ctx.layer.visible = false;
            ctx.renderer.setPreviewMode(true);
            ctx.render();
          } else if (ctx.layer) {
            editLayer = ctx.layer;
            ctx.layer.visible = false;
            ctx.renderer.setPreviewMode(true);
            ctx.render();
          }
          return;
        }
      }

      // Start drawing a new shape
      const id: string = `shape-${Date.now()}`;
      const isLine = shapeOptions.shapeType === "line";
      drawPreview = {
        id,
        name: shapeName(shapeOptions.shapeType),
        visible: true,
        opacity: 1,
        locked: false,
        blendMode: "normal",
        type: "shape",
        shapeType: shapeOptions.shapeType,
        cx: x,
        cy: y,
        w: 1,
        h: 1,
        rotation: 0,
        x1: x,
        y1: y,
        x2: x,
        y2: y,
        strokeColor: shapeOptions.useStroke
          ? (shapeOptions.strokeColor ?? floatToShape(ctx.primaryColor))
          : null,
        fillColor: shapeOptions.useFill
          ? (shapeOptions.fillColor ?? floatToShape(ctx.secondaryColor))
          : null,
        strokeIndex: shapeOptions.useStroke
          ? shapeOptions.strokeIndex
          : undefined,
        fillIndex: shapeOptions.useFill ? shapeOptions.fillIndex : undefined,
        strokeWidth: shapeOptions.strokeWidth,
        cornerRadius: shapeOptions.cornerRadius,
        // Indexed8 has no alpha blending — force AA off so shapes
        // rasterise to a single palette index per pixel.
        antiAlias:
          ctx.pixelFormat === "indexed8" ? false : shapeOptions.antiAlias,
      };
      mode = { t: "draw", id, sx: x, sy: y };
      if (!isLine && ctx.overlayCanvas)
        drawCreationPreview(ctx.overlayCanvas, drawPreview);
    },

    onPointerMove({ x, y, shiftKey }: ToolPointerPos, ctx: ToolContext): void {
      if (mode.t === "draw" && drawPreview) {
        let updated: ShapeLayerState;
        if (drawPreview.shapeType === "line") {
          updated = { ...drawPreview, x2: x, y2: y };
        } else {
          let dx = x - mode.sx,
            dy = y - mode.sy;
          if (shiftKey) {
            const s = Math.max(Math.abs(dx), Math.abs(dy));
            dx = Math.sign(dx) * s;
            dy = Math.sign(dy) * s;
          }
          const w = Math.max(1, Math.abs(dx));
          const h = Math.max(1, Math.abs(dy));
          const cx = mode.sx + dx / 2;
          const cy = mode.sy + dy / 2;
          updated = { ...drawPreview, cx, cy, w, h };
        }
        drawPreview = updated;
        if (ctx.overlayCanvas) drawCreationPreview(ctx.overlayCanvas, updated);
        return;
      }

      const shape = modeShape(ctx);
      if (!shape) return;

      let updated: ShapeLayerState | null = null;

      if (mode.t === "move") {
        const dx = x - mode.gx,
          dy = y - mode.gy;
        updated = {
          ...shape,
          cx: mode.ocx + dx,
          cy: mode.ocy + dy,
          x1: mode.ox1 + dx,
          y1: mode.oy1 + dy,
          x2: mode.ox2 + dx,
          y2: mode.oy2 + dy,
        };
        mode = { ...mode, last: updated };
      } else if (mode.t === "resize") {
        updated = applyResize(shape, mode.hi, x, y);
        mode = { ...mode, last: updated };
      } else if (mode.t === "rotate") {
        const ga = (Math.atan2(y - shape.cy, x - shape.cx) * 180) / Math.PI;
        const rot = mode.or + (ga - mode.ga);
        updated = { ...shape, rotation: rot };
        mode = { ...mode, last: updated };
      } else if (mode.t === "endpoint") {
        updated =
          mode.ep === 0
            ? { ...shape, x1: x, y1: y }
            : { ...shape, x2: x, y2: y };
        mode = { ...mode, last: updated };
      }

      if (updated) {
        // Pure Canvas2D overlay — no GPU rasterization or upload per frame
        if (ctx.overlayCanvas)
          drawShapeEditOverlay(ctx.overlayCanvas, updated, ctx.zoom);
      }
    },

    onPointerUp(_pos: ToolPointerPos, ctx: ToolContext): void {
      if (mode.t === "draw" && drawPreview) {
        if (ctx.overlayCanvas) clearOverlay(ctx.overlayCanvas);
        const ls = drawPreview;
        const hasSize =
          ls.shapeType === "line"
            ? Math.hypot(ls.x2 - ls.x1, ls.y2 - ls.y1) > 2
            : ls.w > 2 && ls.h > 2;
        if (hasSize) {
          ctx.addShapeLayer(ls);
          ctx.commitStroke(`Shape (${ls.shapeType})`);
          // Redraw handles now the shape exists in state
          if (ctx.overlayCanvas) drawHandles(ctx.overlayCanvas, ls, ctx.zoom);
        }
        drawPreview = null;
        mode = { t: "idle", id: "" };
        return;
      }

      const shape = modeShape(ctx);
      const finalState = (mode as { last?: ShapeLayerState }).last ?? shape;
      if (finalState && mode.t !== "idle") {
        // Restore GPU layer visibility and rasterize the final position once
        if (editLayer) {
          editLayer.visible = true;
          editLayer = null;
        }
        ctx.renderer.setPreviewMode(false);
        ctx.previewShapeLayer(finalState);
        ctx.updateShapeLayer(finalState);
        ctx.commitStroke(`Edit shape`);
        if (ctx.overlayCanvas)
          drawHandles(ctx.overlayCanvas, finalState, ctx.zoom);
      } else if (editLayer) {
        // Pointer-up without a valid final state (shouldn't normally happen)
        editLayer.visible = true;
        editLayer = null;
        ctx.renderer.setPreviewMode(false);
        ctx.render();
      }
      mode = { t: "idle", id: "" };
    },

    onHover(pos: ToolPointerPos, ctx: ToolContext): void {
      // Skip hover handling while in an interactive drag — onPointerMove owns
      // the overlay during move/resize/rotate/endpoint and a stale getActive()
      // here would flash the handles at the pre-drag position.
      if (mode.t !== "idle" && mode.t !== "draw") return;
      const active = getActive(ctx);
      if (ctx.overlayCanvas) {
        if (active) drawHandles(ctx.overlayCanvas, active, ctx.zoom);
        else clearOverlay(ctx.overlayCanvas);
      }
      // Direction-aware resize cursor when hovering a handle.
      let cursor = "";
      if (active && active.shapeType !== "line") {
        const hi = hitTestHandles(active, pos.x, pos.y, ctx.zoom);
        if (hi !== null) {
          if (hi === 8) cursor = "grab";
          else cursor = resizeCursorForHandle(hi, active.rotation) ?? "";
        }
      } else if (active && active.shapeType === "line") {
        // Lines have only two endpoints (handles 0 and 1) — match the angle
        // along the line for the resize cursor direction.
        const hi = hitTestHandles(active, pos.x, pos.y, ctx.zoom);
        if (hi !== null) {
          const dx = active.x2 - active.x1;
          const dy = active.y2 - active.y1;
          const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
          const a = (((angle % 180) + 180) % 180);
          if (a < 22.5 || a >= 157.5) cursor = "ew-resize";
          else if (a < 67.5) cursor = "nwse-resize";
          else if (a < 112.5) cursor = "ns-resize";
          else cursor = "nesw-resize";
        }
      }
      ctx.setCursor(cursor);
    },

    onLeave(ctx: ToolContext): void {
      if (ctx.overlayCanvas) clearOverlay(ctx.overlayCanvas);
      ctx.setCursor("");
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

const SHAPE_TYPES: { id: ShapeType; label: string }[] = [
  { id: "rectangle", label: "Rect" },
  { id: "ellipse", label: "Ellipse" },
  { id: "triangle", label: "Triangle" },
  { id: "line", label: "Line" },
  { id: "diamond", label: "Diamond" },
  { id: "star", label: "Star" },
];

function ShapeOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const { state, dispatch } = useAppContext();

  // If the active layer is a shape layer, read its values; otherwise use defaults.
  const activeShape =
    state.layers.find(
      (l): l is ShapeLayerState =>
        "type" in l && l.type === "shape" && l.id === state.activeLayerId,
    ) ?? null;

  // ── Derived values from active shape or options defaults ──────────────────
  const curType = state.activeShape;
  const curStrokeWidth = activeShape?.strokeWidth ?? shapeOptions.strokeWidth;
  const curCornerRadius =
    activeShape?.cornerRadius ?? shapeOptions.cornerRadius;
  const curAntiAlias = activeShape?.antiAlias ?? shapeOptions.antiAlias;
  const curUseStroke = activeShape
    ? activeShape.strokeColor !== null
    : shapeOptions.useStroke;
  const curUseFill = activeShape
    ? activeShape.fillColor !== null
    : shapeOptions.useFill;

  // Keep module-level defaults in sync with current state (for new shapes drawn while
  // this options bar is visible).
  // Derive current colors: active shape takes priority, then stored defaults, then app colors
  const curStrokeColor: RGBAColor =
    activeShape?.strokeColor ??
    shapeOptions.strokeColor ??
    floatToShape(state.primaryColor);
  const curFillColor: RGBAColor =
    activeShape?.fillColor ??
    shapeOptions.fillColor ??
    floatToShape(state.secondaryColor);

  shapeOptions.shapeType = curType;
  shapeOptions.strokeWidth = curStrokeWidth;
  shapeOptions.cornerRadius = curCornerRadius;
  shapeOptions.antiAlias = curAntiAlias;
  shapeOptions.useStroke = curUseStroke;
  shapeOptions.useFill = curUseFill;

  // ── Updater for existing active shape ────────────────────────────────────
  const update = useCallback(
    (patch: Partial<ShapeLayerState>) => {
      if (!activeShape) return;
      dispatch({
        type: "UPDATE_SHAPE_LAYER",
        payload: { ...activeShape, ...patch },
      });
    },
    [activeShape, dispatch],
  );

  const setStrokeWidth = useCallback(
    (v: number) => {
      shapeOptions.strokeWidth = v;
      update({ strokeWidth: v });
    },
    [update],
  );

  const setCornerRadius = useCallback(
    (v: number) => {
      shapeOptions.cornerRadius = v;
      update({ cornerRadius: v });
    },
    [update],
  );

  const toggleStroke = useCallback(() => {
    const next = !curUseStroke;
    shapeOptions.useStroke = next;
    if (activeShape) {
      const fallback =
        shapeOptions.strokeColor ?? floatToShape(state.primaryColor);
      update({
        strokeColor: next ? (activeShape.strokeColor ?? { ...fallback }) : null,
      });
    }
  }, [curUseStroke, activeShape, state.primaryColor, update]);

  const toggleFill = useCallback(() => {
    const next = !curUseFill;
    shapeOptions.useFill = next;
    if (activeShape) {
      const fallback =
        shapeOptions.fillColor ?? floatToShape(state.secondaryColor);
      update({
        fillColor: next ? (activeShape.fillColor ?? { ...fallback }) : null,
      });
    }
  }, [curUseFill, activeShape, state.secondaryColor, update]);

  const setStrokeColor = useCallback(
    (hex: string) => {
      const color = hexToRgba(hex, curStrokeColor.a);
      shapeOptions.strokeColor = color;
      if (activeShape) update({ strokeColor: color });
    },
    [curStrokeColor.a, activeShape, update],
  );

  // Freeform-colour setter (non-indexed): drop any cached palette index so
  // the rasterizer doesn't keep resolving to a stale palette entry.
  const setFreeStrokeColor = useCallback(
    (hex: string) => {
      shapeOptions.strokeIndex = undefined;
      const color = hexToRgba(hex, curStrokeColor.a);
      shapeOptions.strokeColor = color;
      if (activeShape) update({ strokeColor: color, strokeIndex: undefined });
    },
    [curStrokeColor.a, activeShape, update],
  );

  const setFillColor = useCallback(
    (hex: string) => {
      const color = hexToRgba(hex, curFillColor.a);
      shapeOptions.fillColor = color;
      if (activeShape) update({ fillColor: color });
    },
    [curFillColor.a, activeShape, update],
  );

  const setFreeFillColor = useCallback(
    (hex: string) => {
      shapeOptions.fillIndex = undefined;
      const color = hexToRgba(hex, curFillColor.a);
      shapeOptions.fillColor = color;
      if (activeShape) update({ fillColor: color, fillIndex: undefined });
    },
    [curFillColor.a, activeShape, update],
  );

  const setAntiAlias = useCallback(
    (v: boolean) => {
      shapeOptions.antiAlias = v;
      update({ antiAlias: v });
    },
    [update],
  );

  // ── Indexed8 palette picker (replaces the freeform EmbedColorPicker) ─────
  const isIndexed = state.pixelFormat === "indexed8";
  const [pickerTarget, setPickerTarget] = useState<
    null | "stroke" | "fill"
  >(null);
  const [pickerAnchor, setPickerAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const strokeBtnRef = useRef<HTMLButtonElement>(null);
  const fillBtnRef = useRef<HTMLButtonElement>(null);
  const openIndexedPicker = (
    target: "stroke" | "fill",
    el: HTMLButtonElement | null,
  ): void => {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPickerAnchor({ x: rect.left, y: rect.bottom + 4 });
    setPickerTarget(target);
  };
  const handleIndexedSelect = (idx: number, color: RGBAColor): void => {
    const hex = rgbaToHex(color);
    if (pickerTarget === "stroke") {
      shapeOptions.strokeIndex = idx;
      setStrokeColor(hex);
      if (activeShape) update({ strokeIndex: idx });
    } else if (pickerTarget === "fill") {
      shapeOptions.fillIndex = idx;
      setFillColor(hex);
      if (activeShape) update({ fillIndex: idx });
    }
    setPickerTarget(null);
  };

  return (
    <>
      {/* Shape type selector */}
      <span className={styles.optLabel}>Shape</span>
      <select
        className={styles.optSelect}
        value={curType}
        onChange={(e) => {
          const t = e.target.value as ShapeType;
          shapeOptions.shapeType = t;
          dispatch({ type: "SET_SHAPE", payload: t });
        }}
        style={{ width: 80 }}
      >
        {SHAPE_TYPES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>

      <div className={styles.optSep} />

      {/* Stroke toggle + color */}
      <label className={styles.optCheckLabel}>
        <input type="checkbox" checked={curUseStroke} onChange={toggleStroke} />
        Stroke
      </label>
      {curUseStroke &&
        (isIndexed ? (
          <button
            ref={strokeBtnRef}
            type="button"
            className={swatchStyles.swatch}
            style={{ background: rgbaToHex(curStrokeColor) }}
            title="Stroke color (palette)"
            onClick={() => openIndexedPicker("stroke", strokeBtnRef.current)}
            aria-label="Stroke color (palette)"
          />
        ) : (
          <ColorSwatch
            value={rgbaToHex(curStrokeColor)}
            title="Stroke color"
            onChange={setFreeStrokeColor}
          />
        ))}

      {/* Stroke width */}
      {curUseStroke && (
        <>
          <span className={styles.optLabel}>W</span>
          <SliderInput
            value={curStrokeWidth}
            min={1}
            max={100}
            onChange={setStrokeWidth}
            //styles={styles as unknown as import('@/components/widgets/SliderInput/SliderInput').SliderInputStyles}
          />
        </>
      )}

      <div className={styles.optSep} />

      {/* Fill toggle + color */}
      <label className={styles.optCheckLabel}>
        <input type="checkbox" checked={curUseFill} onChange={toggleFill} />
        Fill
      </label>
      {curUseFill &&
        (isIndexed ? (
          <button
            ref={fillBtnRef}
            type="button"
            className={swatchStyles.swatch}
            style={{ background: rgbaToHex(curFillColor) }}
            title="Fill color (palette)"
            onClick={() => openIndexedPicker("fill", fillBtnRef.current)}
            aria-label="Fill color (palette)"
          />
        ) : (
          <ColorSwatch
            value={rgbaToHex(curFillColor)}
            title="Fill color"
            onChange={setFreeFillColor}
          />
        ))}

      <div className={styles.optSep} />

      {/* Corner radius — rectangle only */}
      {curType === "rectangle" && (
        <>
          <span className={styles.optLabel}>Radius</span>
          <SliderInput
            value={curCornerRadius}
            min={0}
            max={200}
            onChange={setCornerRadius}
            //styles={styles as unknown as import('@/components/widgets/SliderInput/SliderInput').SliderInputStyles}
          />
          <div className={styles.optSep} />
        </>
      )}

      {/* Anti-alias — hidden in indexed8 (palette mode never anti-aliases). */}
      {!isIndexed && (
        <label className={styles.optCheckLabel}>
          <input
            type="checkbox"
            checked={!curAntiAlias}
            onChange={(e) => setAntiAlias(!e.target.checked)}
          />
          Anti-Aliasing
        </label>
      )}

      {pickerTarget !== null && pickerAnchor && (
        <IndexedPaletteColorPicker
          palette={state.swatches}
          activeIndex={state.activePaletteIndex}
          anchorPos={pickerAnchor}
          onSelect={(idx, color) => handleIndexedSelect(idx, color)}
          onClose={() => setPickerTarget(null)}
        />
      )}
    </>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

// ─── Shape picker definitions (toolbar flyout) ────────────────────────────────

interface ShapeDef {
  id: ShapeType;
  label: string;
  icon: React.JSX.Element;
}

const SHAPE_DEFS: ShapeDef[] = [
  {
    id: "rectangle",
    label: "Rectangle",
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <rect x="1.5" y="3.5" width="13" height="9" rx="0.5" />
      </svg>
    ),
  },
  {
    id: "ellipse",
    label: "Ellipse",
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <ellipse cx="8" cy="8" rx="6.5" ry="4.5" />
      </svg>
    ),
  },
  {
    id: "triangle",
    label: "Triangle",
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      >
        <polygon points="8,1.5 14.5,14.5 1.5,14.5" />
      </svg>
    ),
  },
  {
    id: "line",
    label: "Line",
    icon: (
      <svg
        viewBox="0 0 16 16"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <line x1="2.5" y1="13.5" x2="13.5" y2="2.5" />
      </svg>
    ),
  },
  {
    id: "diamond",
    label: "Diamond",
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      >
        <polygon points="8,1.5 14.5,8 8,14.5 1.5,8" />
      </svg>
    ),
  },
  {
    id: "star",
    label: "Star",
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      >
        <polygon points="8,1.5 9.47,5.98 13.23,6.3 10.38,8.77 11.23,12.45 8,10.5 4.77,12.45 5.62,8.77 2.77,6.3 6.53,5.98" />
      </svg>
    ),
  },
];

function getShapeIcon(shape: ShapeType): React.JSX.Element {
  return SHAPE_DEFS.find((s) => s.id === shape)?.icon ?? SHAPE_DEFS[0].icon;
}

/**
 * Toolbar button for the Shape tool — shows the active-shape's icon and a
 * caret that opens the per-shape picker flyout. Self-contained: closes on
 * outside click without help from the toolbar.
 */
function ShapeToolButton({
  active,
  disabled,
  styles,
  onActivate,
}: ToolButtonRenderProps): React.JSX.Element {
  const { state, dispatch } = useAppContext();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const [flyoutY, setFlyoutY] = useState(0);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        flyoutRef.current?.contains(target) ||
        buttonRef.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const toggle = (): void => {
    if (buttonRef.current) {
      setFlyoutY(buttonRef.current.getBoundingClientRect().top);
    }
    setOpen((o) => !o);
  };

  const selectShape = (shape: ShapeType): void => {
    dispatch({ type: "SET_SHAPE", payload: shape });
    onActivate();
    setOpen(false);
  };

  return (
    <>
      <div className={styles.shapeCell} ref={buttonRef}>
        <button
          className={`${styles.toolBtn} ${active ? styles.active : ""}`}
          onClick={onActivate}
          disabled={disabled}
          aria-label="Shape (U)"
          aria-pressed={active}
          title="Shape  U"
        >
          {getShapeIcon(state.activeShape)}
        </button>
        <button
          className={styles.shapeCaret}
          onClick={toggle}
          tabIndex={-1}
          aria-label="Pick shape"
          title="Choose shape"
        >
          <svg viewBox="0 0 5 3" fill="currentColor" width="5" height="3">
            <polygon points="0,0 5,0 2.5,3" />
          </svg>
        </button>
      </div>
      {open && (
        <div
          ref={flyoutRef}
          className={styles.shapeFlyout}
          style={{ top: flyoutY }}
        >
          {SHAPE_DEFS.map((shape) => (
            <button
              key={shape.id}
              className={`${styles.shapeFlyoutBtn} ${state.activeShape === shape.id ? styles.active : ""}`}
              onClick={() => selectShape(shape.id)}
              title={shape.label}
              aria-label={shape.label}
            >
              {shape.icon}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

class ShapeTool implements ITool {
  readonly id = "shape";
  readonly label = "Shape";
  readonly shortcut = "U";
  readonly icon = <SvgIcon src={shapeIconSvg} />;
  readonly placement = { group: ToolGroup.Type, row: 0, column: 1 } as const;
  readonly modifiesPixels = false;
  readonly skipAutoHistory = true;
  customRender(props: ToolButtonRenderProps): React.JSX.Element {
    return <ShapeToolButton {...props} />;
  }
  createHandler(): ToolHandler {
    return createShapeHandler();
  }
  readonly Options = ShapeOptions;
}

export const shapeTool: ITool = new ShapeTool();
