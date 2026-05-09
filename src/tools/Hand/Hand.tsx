import React, { useEffect, useState } from "react";
import { viewportCommands } from "@/core/store/viewportCommands";
import type {
  ToolDefinition,
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "./types";

// ─── Handler ──────────────────────────────────────────────────────────────────

function createHandHandler(): ToolHandler {
  // Drag state. We pan in viewport CSS pixels rather than canvas pixels so the
  // motion always feels 1-to-1 with the cursor regardless of zoom.
  let dragging = false;
  let prevCanvasX = 0;
  let prevCanvasY = 0;

  return {
    onPointerDown(pos: ToolPointerPos, ctx: ToolContext): void {
      dragging = true;
      prevCanvasX = pos.x;
      prevCanvasY = pos.y;
      ctx.setCursor("grabbing");
    },
    onPointerMove(pos: ToolPointerPos, ctx: ToolContext): void {
      if (!dragging) return;
      // Convert canvas-pixel delta to viewport CSS-pixel delta (zoom / dpr).
      const dpr = window.devicePixelRatio;
      const dxCss = ((pos.x - prevCanvasX) * ctx.zoom) / dpr;
      const dyCss = ((pos.y - prevCanvasY) * ctx.zoom) / dpr;
      // Pan opposite to the drag motion: dragging right scrolls the viewport
      // left, so the canvas appears to move with the cursor.
      ctx.panViewport(-dxCss, -dyCss);
      // Don't update prevCanvasX/Y — once we scroll, the next pointer event's
      // canvas-space coords are computed against the new scroll position, so
      // (pos.x - prevCanvasX) for the same screen displacement collapses to
      // zero. The scroll itself is the position update.
    },
    onPointerUp(_pos: ToolPointerPos, ctx: ToolContext): void {
      dragging = false;
      ctx.setCursor("grab");
    },
    onActivate(ctx: ToolContext): void {
      ctx.setCursor("grab");
    },
    onLeave(ctx: ToolContext): void {
      ctx.setCursor("");
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function HandOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [{ x, y }, setOffset] = useState({
    x: viewportCommands.scrollLeft,
    y: viewportCommands.scrollTop,
  });
  useEffect(() => {
    const sync = (): void =>
      setOffset({
        x: viewportCommands.scrollLeft,
        y: viewportCommands.scrollTop,
      });
    viewportCommands.subscribeScroll(sync);
    sync();
    return () => viewportCommands.unsubscribeScroll(sync);
  }, []);
  return (
    <>
      <label className={styles.optLabel}>Pan X:</label>
      <span className={styles.optText}>{Math.round(x)}</span>
      <label className={styles.optLabel}>Pan Y:</label>
      <span className={styles.optText}>{Math.round(y)}</span>
    </>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const handTool: ToolDefinition = {
  createHandler: createHandHandler,
  Options: HandOptions,
  // Pan/zoom never write pixels — but they need to operate on any layer
  // (including text/shape/frame), so flag worksOnAllLayers so Canvas's
  // parametric-layer guard doesn't suppress events.
  worksOnAllLayers: true,
};
