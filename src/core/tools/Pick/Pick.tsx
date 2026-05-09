import React from "react";
import type { ShapeLayerState, TextLayerState, Tool } from "@/types";
import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { useAppContext } from "@/core/store/AppContext";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import pickIconSvg from "./pick.svg?raw";
import { getTextBounds } from "../Text/Text";

// ─── Pixel-accurate alpha sampling ────────────────────────────────────────────

/** Alpha threshold (0..255) for treating a pixel as opaque. Slightly above 0 so
 *  near-zero anti-aliased edges don't catch picks (which would feel jittery). */
const ALPHA_HIT_THRESHOLD = 8;

/**
 * Returns true if the GPU layer has a non-transparent pixel at canvas-space
 * (x, y). Format-aware: rgba8 / rgba32f sample the alpha channel; indexed8
 * uses the 255-sentinel for transparency.
 *
 * Container layers (group / composite) are never present in ctx.layers, so we
 * never hit those — clicks naturally drill into their children.
 */
function isOpaqueAt(gl: GpuLayer, x: number, y: number): boolean {
  const lx = Math.floor(x - gl.offsetX);
  const ly = Math.floor(y - gl.offsetY);
  if (lx < 0 || ly < 0 || lx >= gl.layerWidth || ly >= gl.layerHeight)
    return false;
  const idx = ly * gl.layerWidth + lx;

  if (gl.format === "indexed8") {
    return (gl.data as Uint8Array)[idx] !== 255;
  }
  if (gl.format === "rgba32f") {
    const a = (gl.data as Float32Array)[idx * 4 + 3];
    return a > ALPHA_HIT_THRESHOLD / 255;
  }
  // rgba8
  const a = (gl.data as Uint8Array)[idx * 4 + 3];
  return a > ALPHA_HIT_THRESHOLD;
}

// ─── Pick logic ───────────────────────────────────────────────────────────────

function isInsideTextBounds(
  ls: TextLayerState,
  x: number,
  y: number,
): boolean {
  const b = getTextBounds(ls);
  return x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h;
}

function isInsideShapeBounds(
  ls: ShapeLayerState,
  x: number,
  y: number,
): boolean {
  if (ls.shapeType === "line") {
    // Lines have no rotated AABB — fall back to a thick capsule around the
    // segment so picking a stroked line is generous regardless of stroke width.
    const { x1, y1, x2, y2, strokeWidth } = ls;
    const len2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    if (len2 < 1) return false;
    const t = Math.max(
      0,
      Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / len2),
    );
    const d2 =
      (x - (x1 + t * (x2 - x1))) ** 2 + (y - (y1 + t * (y2 - y1))) ** 2;
    return d2 <= Math.max(8, strokeWidth / 2 + 4) ** 2;
  }
  // Rotated AABB around (cx, cy) with width/height (w, h). Inverse-rotate the
  // point into the shape's local frame and check against the half-extents.
  const rad = (ls.rotation * Math.PI) / 180;
  const dx = x - ls.cx;
  const dy = y - ls.cy;
  const cos = Math.cos(-rad);
  const sin = Math.sin(-rad);
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  return Math.abs(lx) <= ls.w / 2 + 4 && Math.abs(ly) <= ls.h / 2 + 4;
}

function pickAt(ctx: ToolContext, x: number, y: number): string | null {
  const textById = new Map(ctx.textLayers.map((t) => [t.id, t] as const));
  const shapeById = new Map(ctx.shapeLayers.map((s) => [s.id, s] as const));

  // ctx.layers is bottom-to-top in z-order — walk in reverse to drill down
  // from the topmost layer. Container layers (group/composite) never have a
  // GpuLayer entry, so they're skipped automatically; their children appear
  // in the flat list at their correct visual depth.
  for (let i = ctx.layers.length - 1; i >= 0; i--) {
    const gl = ctx.layers[i];
    if (!gl.visible) continue;

    // Text layers: hit-test the whole text bounding box rather than per-glyph
    // alpha — clicking the whitespace between letters should still pick the
    // text layer, not fall through to whatever's behind.
    const text = textById.get(gl.id);
    if (text) {
      if (isInsideTextBounds(text, x, y)) return gl.id;
      continue;
    }

    // Shape layers: same reasoning as text — a stroked-only rectangle has
    // mostly-transparent pixels inside its bounds, so per-pixel hit-tests
    // would force the user to click exactly on the border. The shape's
    // parametric AABB (rotated) is what they expect to pick.
    const shape = shapeById.get(gl.id);
    if (shape) {
      if (isInsideShapeBounds(shape, x, y)) return gl.id;
      continue;
    }

    // Pixel and frame layers: alpha-accurate hit.
    if (isOpaqueAt(gl, x, y)) return gl.id;
  }
  return null;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/** Resolve which edit tool to enter for a picked layer. */
function editToolFor(ctx: ToolContext, id: string): Tool {
  if (ctx.textLayers.some((t) => t.id === id)) return "text";
  if (ctx.shapeLayers.some((s) => s.id === id)) return "shape";
  if (ctx.frameLayers.some((f) => f.id === id)) return "frame";
  return "move";
}

/** Double-click recognition window — single-click on the same layer within
 *  this many ms (and a small pixel radius) is treated as a double-click. */
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_PX = 4;

function createPickHandler(): ToolHandler {
  let lastClickTime = 0;
  let lastClickX = 0;
  let lastClickY = 0;
  let lastClickedId: string | null = null;

  return {
    onPointerDown(pos: ToolPointerPos, ctx: ToolContext) {
      const id = pickAt(ctx, pos.x, pos.y);
      if (!id) {
        lastClickedId = null;
        return;
      }

      const dt = pos.timeStamp - lastClickTime;
      const dx = pos.x - lastClickX;
      const dy = pos.y - lastClickY;
      const isDoubleClick =
        lastClickedId === id &&
        dt < DOUBLE_CLICK_MS &&
        dx * dx + dy * dy <= DOUBLE_CLICK_PX * DOUBLE_CLICK_PX;

      if (isDoubleClick) {
        // Enter the appropriate edit mode and reset double-click state so a
        // third click doesn't compound. The newly-active tool's onActivate
        // hook (shape / frame) draws its edit overlay immediately so the
        // user lands directly in edit mode. For text, also open the inline
        // editor — that's its equivalent of "edit mode".
        const tool = editToolFor(ctx, id);
        ctx.setActiveLayer(id);
        ctx.setActiveTool(tool);
        if (tool === "text") ctx.openTextLayerEditor(id);
        lastClickTime = 0;
        lastClickedId = null;
        return;
      }

      // Single click — only update the active layer; stay on pick tool so the
      // user can click through layers in succession without bouncing tools.
      ctx.setActiveLayer(id);
      lastClickTime = pos.timeStamp;
      lastClickX = pos.x;
      lastClickY = pos.y;
      lastClickedId = id;
    },
    onPointerMove() {},
    onPointerUp() {},
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function PickOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const { state } = useAppContext();
  const activeLayer = state.activeLayerId
    ? state.layers.find((l) => l.id === state.activeLayerId)
    : null;
  const message = activeLayer
    ? `${activeLayer.name} selected`
    : "Please select an object…";
  return (
    <span className={styles.optText} style={{ fontStyle: "italic" }}>
      {message}
    </span>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

class PickTool implements ITool {
  readonly id = "pick";
  readonly label = "Pick";
  readonly shortcut = "A";
  readonly icon = <SvgIcon src={pickIconSvg} />;
  readonly placement = { group: ToolGroup.Move, row: 0, column: 1 } as const;
  // Pick doesn't write pixels — but it does need to operate on text/shape/frame
  // layers and any layer in the stack, so flag worksOnAllLayers so Canvas's
  // parametric-layer guard doesn't suppress events.
  readonly worksOnAllLayers = true;
  createHandler(): ToolHandler {
    return createPickHandler();
  }
  readonly Options = PickOptions;
}

export const pickTool: ITool = new PickTool();
