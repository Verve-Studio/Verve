import React, { useEffect, useState } from "react";
import { useAppContext } from "@/core/store/AppContext";
import { viewportCommands } from "@/core/store/viewportCommands";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import type {
  ToolDefinition,
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "./types";

// ─── Module-level options ─────────────────────────────────────────────────────

export const zoomOptions = {
  /** Multiplicative zoom factor per click. 1.25 → +25% in, ×0.8 out. */
  step: 1.25,
};

// ─── Handler ──────────────────────────────────────────────────────────────────

function createZoomHandler(): ToolHandler {
  return {
    onPointerDown(pos: ToolPointerPos, ctx: ToolContext): void {
      const factor = pos.altKey ? 1 / zoomOptions.step : zoomOptions.step;
      ctx.setZoom(ctx.zoom * factor, { canvasX: pos.x, canvasY: pos.y });
    },
    onPointerMove() {},
    onPointerUp() {},
    onActivate(ctx: ToolContext): void {
      ctx.setCursor("zoom-in");
    },
    onHover(pos: ToolPointerPos, ctx: ToolContext): void {
      ctx.setCursor(pos.altKey ? "zoom-out" : "zoom-in");
    },
    onLeave(ctx: ToolContext): void {
      ctx.setCursor("");
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function ZoomOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const { state, dispatch } = useAppContext();
  const [pct, setPct] = useState(Math.round(state.canvas.zoom * 100));
  useEffect(() => {
    setPct(Math.round(state.canvas.zoom * 100));
  }, [state.canvas.zoom]);

  const setZoom = (nextPct: number): void => {
    const z = parseFloat(
      Math.max(0.05, Math.min(32, nextPct / 100)).toFixed(4),
    );
    dispatch({ type: "SET_ZOOM", payload: z });
  };

  return (
    <>
      <label className={styles.optLabel}>Zoom:</label>
      <SliderInput
        value={pct}
        min={5}
        max={3200}
        step={1}
        suffix="%"
        inputWidth={56}
        onChange={setZoom}
      />
      <span className={styles.optSep} />
      <button className={styles.optBtn} onClick={() => setZoom(100)}>
        100%
      </button>
      <button
        className={styles.optBtn}
        onClick={() => viewportCommands.fitToWindow?.()}
      >
        Fit Screen
      </button>
      <button
        className={styles.optBtn}
        onClick={() => setZoom(state.canvas.zoom * 100 * zoomOptions.step)}
      >
        Zoom In
      </button>
      <button
        className={styles.optBtn}
        onClick={() => setZoom((state.canvas.zoom * 100) / zoomOptions.step)}
      >
        Zoom Out
      </button>
    </>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const zoomTool: ToolDefinition = {
  createHandler: createZoomHandler,
  Options: ZoomOptions,
  // Operate regardless of the active layer's type — zoom doesn't touch pixels.
  worksOnAllLayers: true,
};
