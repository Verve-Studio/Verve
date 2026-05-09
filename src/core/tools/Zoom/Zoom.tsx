import React, { useEffect, useState } from "react";
import { useAppContext } from "@/core/store/AppContext";
import { viewportCommands } from "@/core/store/viewportCommands";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";

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

class ZoomTool implements ITool {
  readonly id = "zoom";
  readonly label = "Zoom";
  readonly shortcut = "Z";
  readonly icon = (
    <span style={{ display: "block", width: "100%", height: "100%" }}>
      <svg
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "100%" }}
      >
        <circle
          cx="7"
          cy="7"
          r="4.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <path
          d="M10 10 L13.5 13.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path
          d="M5 7 L9 7 M7 5 L7 9"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
  readonly placement = {
    group: ToolGroup.Navigation,
    row: 0,
    column: 1,
  } as const;
  // Operate regardless of the active layer's type — zoom doesn't touch pixels.
  readonly worksOnAllLayers = true;
  createHandler(): ToolHandler {
    return createZoomHandler();
  }
  readonly Options = ZoomOptions;
}

export const zoomTool: ITool = new ZoomTool();
