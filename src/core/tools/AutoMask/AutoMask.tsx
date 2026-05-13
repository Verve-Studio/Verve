import React, { useEffect, useState } from "react";
import type {
  ToolHandler,
  ToolOptionsStyles,
  ToolPointerPos,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import { activeScope } from "@/core/store/scope";
import autoMaskIconSvg from "./auto-mask.svg?raw";

// ─── Module-level runner ──────────────────────────────────────────────────────
//
// Both the toolbar pointer handler and the "Detect Subject" button in the
// options bar call this. `useAutoMask` (hooked up once in App.tsx) installs
// the actual runner — the runner needs renderer-side dispatch + the canvas
// handle, neither of which is reachable from inside a tool handler.

/** Region of interest passed from a drag gesture. Canvas-space pixels. */
export interface AutoMaskRoi {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AutoMaskRunner {
  run(roi?: AutoMaskRoi): Promise<void>;
  isRunning(): boolean;
}

export const autoMaskRunner: AutoMaskRunner = {
  run: async () => {
    /* set by useAutoMask */
  },
  isRunning: () => false,
};

// ─── Status surfaced by useAutoMask ──────────────────────────────────────────

export type AutoMaskModelStatus = "checking" | "ready" | "missing" | "error";

export const autoMaskStatus: {
  model: AutoMaskModelStatus;
  searchedPaths: string[];
  subscribers: Set<() => void>;
} = {
  model: "checking",
  searchedPaths: [],
  subscribers: new Set(),
};

export function notifyAutoMaskStatusChange(): void {
  autoMaskStatus.subscribers.forEach((cb) => cb());
}

// ─── Handler ─────────────────────────────────────────────────────────────────
//
// Two-mode interaction: drag a rectangle to constrain ISNet to that crop, or
// click without dragging to run on the whole layer. During drag we drive the
// document's pending selection so the user sees the same animated marching
// ants any other selection tool produces — and on release we commit the
// rectangle as a real selection so it sticks around after detection runs.

const MIN_DRAG_PX = 8;

function createAutoMaskHandler(): ToolHandler {
  let startX = 0;
  let startY = 0;
  let dragging = false;

  return {
    onPointerDown({ x, y }: ToolPointerPos) {
      if (autoMaskRunner.isRunning()) return;
      if (autoMaskStatus.model !== "ready") return;
      startX = x;
      startY = y;
      dragging = true;
      activeScope().selection.setPending({
        type: "rect",
        x1: x,
        y1: y,
        x2: x,
        y2: y,
      });
    },
    onPointerMove({ x, y }: ToolPointerPos) {
      if (!dragging) return;
      activeScope().selection.setPending({
        type: "rect",
        x1: startX,
        y1: startY,
        x2: x,
        y2: y,
      });
    },
    onPointerUp({ x, y }: ToolPointerPos) {
      if (!dragging) return;
      dragging = false;
      const dx = Math.abs(x - startX);
      const dy = Math.abs(y - startY);
      if (dx < MIN_DRAG_PX && dy < MIN_DRAG_PX) {
        // Treat as a click — full-layer detection, no committed selection.
        activeScope().selection.setPending(null);
        void autoMaskRunner.run();
        return;
      }
      const x0 = Math.min(startX, x);
      const y0 = Math.min(startY, y);
      const x1 = Math.max(startX, x);
      const y1 = Math.max(startY, y);
      // Commit the drag rectangle as a real selection. `setRect` also
      // clears the pending preview internally so the marching ants
      // continue from the committed mask without a frame of flicker.
      activeScope().selection.setRect(x0, y0, x1, y1);
      void autoMaskRunner.run({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    },
    onLeave() {
      if (dragging) {
        dragging = false;
        activeScope().selection.setPending(null);
      }
    },
  };
}

// ─── Options bar ─────────────────────────────────────────────────────────────

function AutoMaskOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [modelStatus, setModelStatus] = useState(autoMaskStatus.model);
  const [searchedPaths, setSearchedPaths] = useState(
    autoMaskStatus.searchedPaths,
  );
  const [running, setRunning] = useState(autoMaskRunner.isRunning());

  useEffect(() => {
    const sync = (): void => {
      setModelStatus(autoMaskStatus.model);
      setSearchedPaths(autoMaskStatus.searchedPaths);
      setRunning(autoMaskRunner.isRunning());
    };
    autoMaskStatus.subscribers.add(sync);
    // Light polling for the running flag — the runner toggles it directly on
    // the module-level singleton without going through the subscriber list,
    // and we don't want to leak a setter ref into the runner.
    const interval = window.setInterval(sync, 120);
    return () => {
      autoMaskStatus.subscribers.delete(sync);
      window.clearInterval(interval);
    };
  }, []);

  const disabled = running || modelStatus !== "ready";

  return (
    <>
      <button
        className={styles.optBtn}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          void autoMaskRunner.run();
        }}
        title="Run the model on the whole active layer. Drag a rectangle on the canvas to constrain detection to a region instead."
      >
        {running ? "Detecting…" : "Detect Subject"}
      </button>
      <span className={styles.optSep} />
      <span className={styles.optLabel}>
        {modelStatus === "ready" && "Model ready"}
        {modelStatus === "checking" && "Checking model…"}
        {modelStatus === "missing" && (
          <>
            Model missing — place{" "}
            <code>isnet-general-use.onnx</code> in{" "}
            <code>{searchedPaths[0] ?? "…/models/isnet/"}</code>
          </>
        )}
        {modelStatus === "error" && "Model load failed"}
      </span>
    </>
  );
}

// ─── Tool ────────────────────────────────────────────────────────────────────

class AutoMaskTool implements ITool {
  readonly id = "auto-mask" as const;
  readonly label = "Auto-Mask Subject";
  readonly shortcut = "W";
  readonly icon = <SvgIcon src={autoMaskIconSvg} />;
  readonly placement = {
    group: ToolGroup.Selection,
    row: 2,
    column: 1,
  } as const;
  readonly shortcutCycle = "magic-wand" as const;
  // Adds a mask layer rather than writing into the active layer's pixels — so
  // it doesn't fight Canvas's locked-layer guard for `modifiesPixels` tools.
  readonly worksOnAllLayers = true;
  // ISNet runs on rgba8 data; indexed8 layers would need a palette decode
  // round-trip we don't want to plumb through here.
  readonly indexed8Unsupported = true;
  createHandler(): ToolHandler {
    return createAutoMaskHandler();
  }
  readonly Options = AutoMaskOptions;
}

export const autoMaskTool: ITool = new AutoMaskTool();
