import React, { useState } from "react";
import { eraseQuadBezier, eraseThickLine } from "./eraseStroke";
import { bresenham } from "../_shared/primitives";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import eraserIconSvg from "./eraser.svg?raw";
import { stampIndexedShape } from "@/utils/indexedColorUtils";

// ─── Module-level options ────────────────────────────────────

export const eraserOptions = {
  size: 20,
  strength: 100,
  softness: 0,
  smoothing: 50, // 0 = raw coords, 100 = maximum stabilizer (mirrors brush)
  antiAlias: true,
  alphaMode: false,
};

// Same EMA mapping the brush uses — keeps stroke feel consistent.
function smoothingToAlpha(s: number): number {
  return Math.max(0.05, 1 - (s / 100) * 0.92);
}

type Point = { x: number; y: number };

// ─── Handler ─────────────────────────────────────────────────────────────────

function createEraserHandler(): ToolHandler {
  // Midpoint B-spline state — mirrors brush.tsx for consistent stroke feel.
  let lastRendered: Point | null = null; // endpoint of the last drawn arc
  let lastCtrl: Point | null = null; // last stabilised pointer (B-spline ctrl pt)
  let touched: Map<number, number> | null = null;
  let stabX = 0,
    stabY = 0;

  /**
   * Erase one quadratic Bézier arc from p0 → p1 attracted toward cp.
   * cp == p0 == p1 collapses to a single dot (initial tap).
   * cp == p1 collapses to a straight segment (degenerate quadratic).
   */
  function paint(
    p0x: number,
    p0y: number,
    cpx: number,
    cpy: number,
    p1x: number,
    p1y: number,
    ctx: ToolContext,
  ): void {
    const {
      renderer,
      layer,
      layers,
      secondaryColor,
      selectionMask,
      render,
      growLayerToFit,
    } = ctx;
    const secR = Math.round(Math.min(secondaryColor.r, 1) * 255);
    const secG = Math.round(Math.min(secondaryColor.g, 1) * 255);
    const secB = Math.round(Math.min(secondaryColor.b, 1) * 255);
    const radius = eraserOptions.size / 2;
    const padR = Math.ceil(radius) + 2;

    // Skip entirely off-canvas arcs (matches brush rationale).
    if (!ctx.tiledMode) {
      const minX = Math.min(p0x, cpx, p1x) - padR;
      const minY = Math.min(p0y, cpy, p1y) - padR;
      const maxX = Math.max(p0x, cpx, p1x) + padR;
      const maxY = Math.max(p0y, cpy, p1y) + padR;
      if (
        maxX < 0 ||
        maxY < 0 ||
        minX >= renderer.pixelWidth ||
        minY >= renderer.pixelHeight
      )
        return;
    }

    growLayerToFit(Math.round(p0x), Math.round(p0y), padR);
    growLayerToFit(Math.round(cpx), Math.round(cpy), padR);
    growLayerToFit(Math.round(p1x), Math.round(p1y), padR);

    const sel = selectionMask
      ? { mask: selectionMask, width: renderer.pixelWidth }
      : undefined;
    const tiledW = ctx.tiledMode ? renderer.pixelWidth : undefined;
    const tiledH = ctx.tiledMode ? renderer.pixelHeight : undefined;

    // Indexed8 layers: keep simple straight Bresenham stamping — the indexed
    // pipeline doesn't have a Bézier walker.
    if (layer.format === "indexed8") {
      const indexedTouched = new Map<number, true>();
      const x0r = Math.round(p0x),
        y0r = Math.round(p0y);
      const x1r = Math.round(p1x),
        y1r = Math.round(p1y);
      bresenham(x0r, y0r, x1r, y1r, (px, py) => {
        stampIndexedShape(
          layer,
          px,
          py,
          255,
          eraserOptions.size,
          "round",
          indexedTouched,
          sel,
          tiledW,
          tiledH,
        );
      });
      renderer.flushLayer(layer, ctx.swatches);
      render(layers);
      return;
    }

    // Degenerate (single dot or straight segment): bypass the Bézier walker.
    if (cpx === p1x && cpy === p1y) {
      eraseThickLine(
        renderer,
        layer,
        p0x,
        p0y,
        p1x,
        p1y,
        eraserOptions.size,
        secR,
        secG,
        secB,
        eraserOptions.strength,
        eraserOptions.alphaMode,
        eraserOptions.antiAlias,
        eraserOptions.softness,
        touched ?? undefined,
        sel,
        tiledW,
        tiledH,
      );
    } else {
      eraseQuadBezier(
        renderer,
        layer,
        p0x,
        p0y,
        cpx,
        cpy,
        p1x,
        p1y,
        eraserOptions.size,
        secR,
        secG,
        secB,
        eraserOptions.strength,
        eraserOptions.alphaMode,
        eraserOptions.antiAlias,
        eraserOptions.softness,
        touched ?? undefined,
        sel,
        tiledW,
        tiledH,
      );
    }

    // Bounded GPU upload over the arc bounding box (was full-layer DMA before).
    if (!ctx.tiledMode) {
      const lx = Math.max(
        0,
        Math.floor(Math.min(p0x, cpx, p1x) - layer.offsetX) - padR,
      );
      const ly = Math.max(
        0,
        Math.floor(Math.min(p0y, cpy, p1y) - layer.offsetY) - padR,
      );
      const rx = Math.min(
        layer.layerWidth,
        Math.ceil(Math.max(p0x, cpx, p1x) - layer.offsetX) + padR + 1,
      );
      const ry = Math.min(
        layer.layerHeight,
        Math.ceil(Math.max(p0y, cpy, p1y) - layer.offsetY) + padR + 1,
      );
      if (layer.dirtyRect === null) {
        layer.dirtyRect = { lx, ly, rx, ry };
      } else {
        layer.dirtyRect.lx = Math.min(layer.dirtyRect.lx, lx);
        layer.dirtyRect.ly = Math.min(layer.dirtyRect.ly, ly);
        layer.dirtyRect.rx = Math.max(layer.dirtyRect.rx, rx);
        layer.dirtyRect.ry = Math.max(layer.dirtyRect.ry, ry);
      }
    } else {
      layer.dirtyRect = null;
    }

    renderer.flushLayer(layer);
    render(layers);
  }

  return {
    onPointerDown({ x, y }: ToolPointerPos, ctx: ToolContext) {
      ctx.renderer.strokeStart();
      touched = new Map();
      stabX = x;
      stabY = y;
      lastRendered = { x, y };
      lastCtrl = { x, y };
      // Initial dot.
      paint(x, y, x, y, x, y, ctx);
    },

    onPointerMove({ x, y }: ToolPointerPos, ctx: ToolContext) {
      if (!lastRendered || !lastCtrl) return;

      // EMA spatial stabilizer.
      const alpha = smoothingToAlpha(eraserOptions.smoothing);
      stabX = stabX * (1 - alpha) + x * alpha;
      stabY = stabY * (1 - alpha) + y * alpha;

      const spacing = Math.max(1, eraserOptions.size * 0.2);

      // Midpoint B-spline: tip = mid(lastCtrl, stab); lastCtrl is the
      // quadratic Bézier control point. Identical structure to brush.
      const tipX = (lastCtrl.x + stabX) * 0.5;
      const tipY = (lastCtrl.y + stabY) * 0.5;

      if (Math.hypot(tipX - lastRendered.x, tipY - lastRendered.y) >= spacing) {
        paint(
          lastRendered.x,
          lastRendered.y,
          lastCtrl.x,
          lastCtrl.y,
          tipX,
          tipY,
          ctx,
        );
        lastRendered = { x: tipX, y: tipY };
      }

      lastCtrl = { x: stabX, y: stabY };
    },

    onPointerUp(_pos: ToolPointerPos, ctx: ToolContext) {
      // Close the deferred tail so the stroke ends exactly where the
      // pointer lifted, not at the last committed midpoint.
      if (
        lastRendered &&
        lastCtrl &&
        Math.hypot(lastCtrl.x - lastRendered.x, lastCtrl.y - lastRendered.y) >=
          1
      ) {
        paint(
          lastRendered.x,
          lastRendered.y,
          lastCtrl.x,
          lastCtrl.y,
          lastCtrl.x,
          lastCtrl.y,
          ctx,
        );
      }
      lastRendered = null;
      lastCtrl = null;
      touched = null;
      ctx.renderer.strokeEnd();
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function EraserOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [size, setSize] = useState(eraserOptions.size);
  const [strength, setStrength] = useState(eraserOptions.strength);
  const [softness, setSoftness] = useState(eraserOptions.softness);
  const [smoothing, setSmoothing] = useState(eraserOptions.smoothing);
  const [antiAlias, setAA] = useState(eraserOptions.antiAlias);
  const [alphaMode, setAlpha] = useState(eraserOptions.alphaMode);

  const handleSize = (v: number): void => {
    eraserOptions.size = v;
    setSize(v);
  };
  const handleStrength = (v: number): void => {
    eraserOptions.strength = v;
    setStrength(v);
  };
  const handleSoftness = (v: number): void => {
    eraserOptions.softness = v;
    setSoftness(v);
  };
  const handleSmoothing = (v: number): void => {
    eraserOptions.smoothing = v;
    setSmoothing(v);
  };
  const handleAA = (v: boolean): void => {
    eraserOptions.antiAlias = v;
    setAA(v);
  };
  const handleAlpha = (v: boolean): void => {
    eraserOptions.alphaMode = v;
    setAlpha(v);
  };

  return (
    <>
      <label className={styles.optLabel}>Size:</label>
      <SliderInput
        value={size}
        min={1}
        max={200}
        inputWidth={42}
        onChange={handleSize}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Softness:</label>
      <SliderInput
        value={softness}
        min={0}
        max={100}
        suffix="%"
        inputWidth={42}
        onChange={handleSoftness}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Strength:</label>
      <SliderInput
        value={strength}
        min={0}
        max={100}
        suffix="%"
        inputWidth={42}
        onChange={handleStrength}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Smoothing:</label>
      <SliderInput
        value={smoothing}
        min={0}
        max={100}
        suffix="%"
        inputWidth={42}
        onChange={handleSmoothing}
      />
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={antiAlias}
          onChange={(e) => handleAA(e.target.checked)}
        />
        Anti-alias
      </label>
      <span className={styles.optSep} />
      <label
        className={styles.optCheckLabel}
        title="When checked, erases alpha (transparency). When unchecked, replaces RGB with background color."
      >
        <input
          type="checkbox"
          checked={alphaMode}
          onChange={(e) => handleAlpha(e.target.checked)}
        />
        Erase alpha
      </label>
    </>
  );
}

class EraserTool implements ITool {
  readonly id = "eraser";
  readonly label = "Eraser";
  readonly shortcut = "E";
  readonly icon = <SvgIcon src={eraserIconSvg} />;
  readonly placement = {
    group: ToolGroup.Painting,
    row: 1,
    column: 0,
  } as const;
  readonly modifiesPixels = true;
  readonly pixelOnly = true;
  createHandler(): ToolHandler {
    return createEraserHandler();
  }
  readonly Options = EraserOptions;
}

export const eraserTool: ITool = new EraserTool();
