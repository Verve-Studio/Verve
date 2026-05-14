/**
 * Linked-layer transform tool.
 *
 * Models the same edit pattern as Frame/Shape: when this tool is active and a
 * LinkedLayerState is the active layer, an overlay draws the rotated bounding
 * box with 8 scale handles + a rotation knob above the top edge. Drags update
 * `centerX/Y`, `scaleX/Y`, or `rotation` on the layer state — the rasteriser
 * bakes those into the pixel buffer at the next sync tick. The source file on
 * disk is never touched.
 *
 * Activation: not on the toolbar. The pick tool routes here on double-click
 * of a linked layer (see `Pick.tsx#editToolFor`).
 */
import React from "react";
import type { LinkedLayerState } from "@/types";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { resizeCursorForHandle } from "../_shared/resizeCursor";

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function rotatePoint(
  px: number,
  py: number,
  angleRad: number,
): [number, number] {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return [px * cos - py * sin, px * sin + py * cos];
}

function worldToLocal(
  wx: number,
  wy: number,
  cx: number,
  cy: number,
  angleRad: number,
): [number, number] {
  const dx = wx - cx;
  const dy = wy - cy;
  return rotatePoint(dx, dy, -angleRad);
}

/** Half-extents of the transformed bounding box (along the layer's local X/Y
 *  axes, before rotation). Includes sign so flipped scales mirror the box. */
function halfSize(ls: LinkedLayerState): { hw: number; hh: number } {
  return {
    hw: (ls.source.sourceWidth * ls.scaleX) / 2,
    hh: (ls.source.sourceHeight * ls.scaleY) / 2,
  };
}

const ROTATION_OFFSET = 24;

function getHandleWorldPositions(ls: LinkedLayerState): [number, number][] {
  const rad = (ls.rotation * Math.PI) / 180;
  const { hw, hh } = halfSize(ls);
  // The rotation knob sits above the top edge in *unscaled* local space so
  // negative scales don't flip it inside the box.
  const rotateOffsetLocalY = hh < 0 ? hh - ROTATION_OFFSET : -Math.abs(hh) - ROTATION_OFFSET;
  const locals: [number, number][] = [
    [-hw, -hh], // 0 TL
    [0, -hh],   // 1 TC
    [hw, -hh],  // 2 TR
    [-hw, 0],   // 3 ML
    [hw, 0],    // 4 MR
    [-hw, hh],  // 5 BL
    [0, hh],    // 6 BC
    [hw, hh],   // 7 BR
    [0, rotateOffsetLocalY], // 8 rotation
  ];
  return locals.map(([lx, ly]) => {
    const [rx, ry] = rotatePoint(lx, ly, rad);
    return [ls.centerX + rx, ls.centerY + ry];
  });
}

function hitTestHandles(
  ls: LinkedLayerState,
  x: number,
  y: number,
  zoom: number,
): number | null {
  const dpr = window.devicePixelRatio;
  const r = Math.max(4, (5 * dpr) / zoom) + 2;
  const handles = getHandleWorldPositions(ls);
  for (let i = 0; i < handles.length; i++) {
    const [hx, hy] = handles[i];
    if ((x - hx) ** 2 + (y - hy) ** 2 <= r * r) return i;
  }
  return null;
}

function hitTestInterior(
  ls: LinkedLayerState,
  x: number,
  y: number,
): boolean {
  const [lx, ly] = worldToLocal(
    x,
    y,
    ls.centerX,
    ls.centerY,
    (ls.rotation * Math.PI) / 180,
  );
  const { hw, hh } = halfSize(ls);
  return Math.abs(lx) <= Math.abs(hw) + 4 && Math.abs(ly) <= Math.abs(hh) + 4;
}

// Index of the corner/edge handle opposite to each handle on the bounding box.
const OPPOSITE: number[] = [7, 6, 5, 4, 3, 2, 1, 0];

/** Compute new centerX/Y + scaleX/Y given a handle drag. Anchored at the
 *  opposite handle; the new box spans from anchor to the pointer's local
 *  position. Mirrors Frame's `applyResize` so behaviour matches what the
 *  user expects from other parametric tools (no flipping; min size 1 px). */
function applyResize(
  ls: LinkedLayerState,
  handleIdx: number,
  worldDragX: number,
  worldDragY: number,
  shiftKey: boolean,
): LinkedLayerState {
  const rad = (ls.rotation * Math.PI) / 180;
  const { hw, hh } = halfSize(ls);
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
  const [lx, ly] = worldToLocal(
    worldDragX,
    worldDragY,
    ls.centerX,
    ls.centerY,
    rad,
  );

  let xMin: number, xMax: number, yMin: number, yMax: number;
  if (handleIdx === 1 || handleIdx === 6) {
    // Top/bottom edge — only Y changes.
    xMin = -Math.abs(hw);
    xMax = Math.abs(hw);
    yMin = Math.min(ay, ly);
    yMax = Math.max(ay, ly);
  } else if (handleIdx === 3 || handleIdx === 4) {
    // Left/right edge — only X changes.
    yMin = -Math.abs(hh);
    yMax = Math.abs(hh);
    xMin = Math.min(ax, lx);
    xMax = Math.max(ax, lx);
  } else {
    xMin = Math.min(ax, lx);
    xMax = Math.max(ax, lx);
    yMin = Math.min(ay, ly);
    yMax = Math.max(ay, ly);
  }

  let newW = Math.max(1, xMax - xMin);
  let newH = Math.max(1, yMax - yMin);

  // Shift = lock aspect ratio against the source's native ratio. Pick the
  // larger relative scale and apply it to the other axis.
  if (
    shiftKey &&
    handleIdx !== 1 &&
    handleIdx !== 6 &&
    handleIdx !== 3 &&
    handleIdx !== 4
  ) {
    const sxCand = newW / ls.source.sourceWidth;
    const syCand = newH / ls.source.sourceHeight;
    const s = Math.max(sxCand, syCand);
    newW = s * ls.source.sourceWidth;
    newH = s * ls.source.sourceHeight;
    // Adjust the dragged edge so the constrained box still anchors correctly.
    if (lx < ax) xMin = ax - newW;
    else xMax = ax + newW;
    if (ly < ay) yMin = ay - newH;
    else yMax = ay + newH;
  }

  const newLocalCx = (xMin + xMax) / 2;
  const newLocalCy = (yMin + yMax) / 2;
  const [rwx, rwy] = rotatePoint(newLocalCx, newLocalCy, rad);

  return {
    ...ls,
    centerX: ls.centerX + rwx,
    centerY: ls.centerY + rwy,
    scaleX: newW / ls.source.sourceWidth,
    scaleY: newH / ls.source.sourceHeight,
  };
}

// ─── Overlay drawing ──────────────────────────────────────────────────────────

function clearOverlay(oc: HTMLCanvasElement): void {
  const c = oc.getContext("2d");
  if (c) c.clearRect(0, 0, oc.width, oc.height);
}

function drawHandles(
  oc: HTMLCanvasElement,
  ls: LinkedLayerState,
  zoom: number,
): void {
  const c = oc.getContext("2d");
  if (!c) return;
  c.clearRect(0, 0, oc.width, oc.height);

  const dpr = window.devicePixelRatio;
  const handleR = Math.max(3.5, (5 * dpr) / zoom);
  const rad = (ls.rotation * Math.PI) / 180;
  const { hw, hh } = halfSize(ls);
  const handles = getHandleWorldPositions(ls);

  // Bounding rectangle.
  c.save();
  c.translate(ls.centerX, ls.centerY);
  c.rotate(rad);
  c.strokeStyle = "rgba(0,120,255,0.85)";
  c.lineWidth = Math.max(0.5, dpr / zoom);
  c.setLineDash([Math.max(2, (4 * dpr) / zoom), Math.max(2, (3 * dpr) / zoom)]);
  c.beginPath();
  c.rect(-Math.abs(hw), -Math.abs(hh), Math.abs(hw) * 2, Math.abs(hh) * 2);
  c.stroke();
  c.setLineDash([]);
  c.restore();

  // Connector line to the rotation handle.
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

  // 8 scale handles + rotation knob.
  for (let i = 0; i < handles.length; i++) {
    const [hx, hy] = handles[i];
    c.save();
    if (i === 8) {
      c.beginPath();
      c.arc(hx, hy, handleR, 0, Math.PI * 2);
      c.fillStyle = "#ffffff";
      c.fill();
      c.strokeStyle = "#0078ff";
      c.lineWidth = Math.max(0.8, (1.5 * dpr) / zoom);
      c.stroke();
      c.beginPath();
      c.arc(hx, hy, handleR * 0.55, Math.PI * 0.2, Math.PI * 1.8);
      c.strokeStyle = "#0078ff";
      c.lineWidth = Math.max(0.5, dpr / zoom);
      c.stroke();
    } else {
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

// ─── Drag state ───────────────────────────────────────────────────────────────

type Mode =
  | { t: "idle" }
  | {
      t: "move";
      id: string;
      gx: number;
      gy: number;
      ocx: number;
      ocy: number;
      last: LinkedLayerState;
    }
  | {
      t: "resize";
      id: string;
      hi: number;
      last: LinkedLayerState;
      origin: LinkedLayerState;
    }
  | {
      t: "rotate";
      id: string;
      ga: number;
      or: number;
      last: LinkedLayerState;
    };

// ─── Handler ──────────────────────────────────────────────────────────────────

function getActive(ctx: ToolContext): LinkedLayerState | null {
  // The active GpuLayer is `ctx.layer`; find the corresponding linked
  // layer-state by matching ids back through `layerStates`.
  for (const l of ctx.layerStates) {
    if ("type" in l && l.type === "linked") {
      const gl = ctx.getGpuLayer(l.id);
      if (gl && gl === ctx.layer) return l as LinkedLayerState;
    }
  }
  return null;
}

function createLinkedHandler(): ToolHandler {
  let mode: Mode = { t: "idle" };
  let editLayer: { visible: boolean } | null = null;

  function modeLinked(ctx: ToolContext): LinkedLayerState | null {
    const m = mode;
    if (m.t === "idle") return null;
    const ls = ctx.layerStates.find((l) => l.id === m.id);
    return ls && "type" in ls && ls.type === "linked"
      ? (ls as LinkedLayerState)
      : null;
  }

  return {
    onActivate(ctx: ToolContext): void {
      const active = getActive(ctx);
      if (active && ctx.overlayCanvas) {
        drawHandles(ctx.overlayCanvas, active, ctx.zoom);
      } else if (ctx.overlayCanvas) {
        clearOverlay(ctx.overlayCanvas);
      }
    },

    onPointerDown({ x, y }: ToolPointerPos, ctx: ToolContext): void {
      const active = getActive(ctx);
      if (!active) return;

      const hi = hitTestHandles(active, x, y, ctx.zoom);
      if (hi !== null) {
        if (hi === 8) {
          const ga =
            (Math.atan2(y - active.centerY, x - active.centerX) * 180) /
            Math.PI;
          mode = {
            t: "rotate",
            id: active.id,
            ga,
            or: active.rotation,
            last: active,
          };
        } else {
          mode = {
            t: "resize",
            id: active.id,
            hi,
            last: active,
            origin: active,
          };
        }
      } else if (hitTestInterior(active, x, y)) {
        mode = {
          t: "move",
          id: active.id,
          gx: x,
          gy: y,
          ocx: active.centerX,
          ocy: active.centerY,
          last: active,
        };
      } else {
        return;
      }

      if (ctx.layer && ctx.overlayCanvas) {
        drawHandles(ctx.overlayCanvas, active, ctx.zoom);
        editLayer = ctx.layer;
        ctx.renderer.setPreviewMode(true);
        ctx.render();
      }
    },

    onPointerMove(
      { x, y, shiftKey }: ToolPointerPos,
      ctx: ToolContext,
    ): void {
      const cur = modeLinked(ctx);
      if (!cur) return;

      let updated: LinkedLayerState | null = null;

      if (mode.t === "move") {
        const dx = x - mode.gx;
        const dy = y - mode.gy;
        updated = {
          ...cur,
          centerX: mode.ocx + dx,
          centerY: mode.ocy + dy,
        };
        mode = { ...mode, last: updated };
      } else if (mode.t === "resize") {
        updated = applyResize(mode.origin, mode.hi, x, y, !!shiftKey);
        mode = { ...mode, last: updated };
      } else if (mode.t === "rotate") {
        const ga =
          (Math.atan2(y - cur.centerY, x - cur.centerX) * 180) / Math.PI;
        const rot = mode.or + (ga - mode.ga);
        updated = { ...cur, rotation: rot };
        mode = { ...mode, last: updated };
      }

      if (updated) {
        // Dispatch UPDATE_LINKED_LAYER each move; the sync hook re-rasterises
        // through the bitmap cache, so this stays smooth even on a long drag.
        ctx.updateLinkedLayer(updated);
        if (ctx.overlayCanvas) drawHandles(ctx.overlayCanvas, updated, ctx.zoom);
      }
    },

    onPointerUp(_pos: ToolPointerPos, ctx: ToolContext): void {
      const final = (mode as { last?: LinkedLayerState }).last ?? null;
      if (final && mode.t !== "idle") {
        editLayer = null;
        ctx.renderer.setPreviewMode(false);
        ctx.updateLinkedLayer(final);
        ctx.commitStroke(
          mode.t === "rotate"
            ? "Rotate linked layer"
            : mode.t === "resize"
              ? "Scale linked layer"
              : "Move linked layer",
        );
        if (ctx.overlayCanvas) drawHandles(ctx.overlayCanvas, final, ctx.zoom);
      } else if (editLayer) {
        editLayer = null;
        ctx.renderer.setPreviewMode(false);
        ctx.render();
      }
      mode = { t: "idle" };
    },

    onHover(pos: ToolPointerPos, ctx: ToolContext): void {
      if (mode.t !== "idle") return;
      const active = getActive(ctx);
      if (ctx.overlayCanvas) {
        if (active) drawHandles(ctx.overlayCanvas, active, ctx.zoom);
        else clearOverlay(ctx.overlayCanvas);
      }
      let cursor = "";
      if (active) {
        const hi = hitTestHandles(active, pos.x, pos.y, ctx.zoom);
        if (hi !== null) {
          if (hi === 8) cursor = "grab";
          else cursor = resizeCursorForHandle(hi, active.rotation) ?? "";
        } else if (hitTestInterior(active, pos.x, pos.y)) {
          cursor = "move";
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

// ─── Options bar ──────────────────────────────────────────────────────────────

function LinkedOptions(): React.JSX.Element {
  return <span style={{ opacity: 0.7 }}>Drag handles to scale, top knob to rotate.</span>;
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

class LinkedTool implements ITool {
  readonly id = "linked";
  readonly label = "Linked Layer Transform";
  readonly shortcut = "";
  readonly icon: React.ReactElement = <></>;
  readonly placement = null;
  // Treat as parametric editor — paint-tool gating doesn't apply.
  readonly modifiesPixels = false;
  readonly worksOnAllLayers = true;
  createHandler(): ToolHandler {
    return createLinkedHandler();
  }
  readonly Options = LinkedOptions;
}

export const linkedTool: ITool = new LinkedTool();
