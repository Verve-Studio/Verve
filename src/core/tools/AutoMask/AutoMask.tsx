import React, { useEffect, useState } from "react";
import type {
  ToolHandler,
  ToolOptionsStyles,
  ToolPointerPos,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import autoMaskIconSvg from "./auto-mask.svg?raw";

// ─── Module-level runner ──────────────────────────────────────────────────────
//
// Both the toolbar pointer handler and the "Detect Subject" button in the
// options bar call this. `useAutoMask` (hooked up once in App.tsx) installs
// the actual runner — the runner needs renderer-side dispatch + the canvas
// handle, neither of which is reachable from inside a tool handler.

export interface AutoMaskRunner {
  run(): Promise<void>;
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
// A single click anywhere on the canvas triggers detection on the active
// layer. ISNet is a one-shot salient-object detector, so the click position
// itself doesn't matter — we just want a clear "go" gesture.

function createAutoMaskHandler(): ToolHandler {
  return {
    onPointerDown(_pos: ToolPointerPos) {
      if (autoMaskRunner.isRunning()) return;
      if (autoMaskStatus.model !== "ready") return;
      void autoMaskRunner.run();
    },
    onPointerMove() {},
    onPointerUp() {},
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
        title="Run the model on the active layer and add the result as a layer mask"
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
