import React, { useEffect, useState } from "react";
import type {
  ToolContext,
  ToolHandler,
  ToolOptionsStyles,
  ToolPointerPos,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import { activeScope } from "@/core/store/scope";
import objectRemovalIconSvg from "./object-removal.svg?raw";

// ─── Module-level options + runner ────────────────────────────────────────────

export const objectRemovalOptions = {
  /** Brush diameter in canvas pixels. Read both by the tool handler (for
   *  mask stamping) and by `useBrushCursor` (for the CSS-circle cursor). */
  size: 40,
};

export interface ObjectRemovalRunner {
  apply(): Promise<void>;
  isRunning(): boolean;
}

export const objectRemovalRunner: ObjectRemovalRunner = {
  apply: async () => {
    /* set by useObjectRemoval */
  },
  isRunning: () => false,
};

export type ObjectRemovalModelStatus =
  | "checking"
  | "ready"
  | "missing"
  | "error";

export const objectRemovalStatus: {
  model: ObjectRemovalModelStatus;
  searchedPaths: string[];
  subscribers: Set<() => void>;
} = {
  model: "checking",
  searchedPaths: [],
  subscribers: new Set(),
};

export function notifyObjectRemovalStatusChange(): void {
  objectRemovalStatus.subscribers.forEach((cb) => cb());
}

// ─── Handler ─────────────────────────────────────────────────────────────────
//
// On each pointer sample the handler stamps a circle into the per-document
// `inpaintMask` store. Strokes accumulate until the user clicks the Apply
// button in the options bar (or hits Enter); the overlay renderer draws the
// mask in translucent red while it's pending.

function createObjectRemovalHandler(): ToolHandler {
  let lastX = 0;
  let lastY = 0;
  let dragging = false;
  return {
    onPointerDown({ x, y }: ToolPointerPos, ctx: ToolContext) {
      const store = activeScope().inpaintMask;
      store.ensureSize(ctx.renderer.pixelWidth, ctx.renderer.pixelHeight);
      const r = objectRemovalOptions.size / 2;
      store.stampCircle(x, y, r);
      lastX = x;
      lastY = y;
      dragging = true;
    },
    onPointerMove({ x, y }: ToolPointerPos) {
      if (!dragging) return;
      const store = activeScope().inpaintMask;
      const r = objectRemovalOptions.size / 2;
      store.stampLine(lastX, lastY, x, y, r);
      lastX = x;
      lastY = y;
    },
    onPointerUp() {
      dragging = false;
    },
    onLeave() {
      dragging = false;
    },
  };
}

// ─── Options bar ─────────────────────────────────────────────────────────────

function ObjectRemovalOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [modelStatus, setModelStatus] = useState(objectRemovalStatus.model);
  const [searchedPaths, setSearchedPaths] = useState(
    objectRemovalStatus.searchedPaths,
  );
  const [running, setRunning] = useState(objectRemovalRunner.isRunning());
  const [size, setSize] = useState(objectRemovalOptions.size);
  const [hasMask, setHasMask] = useState(
    activeScope().inpaintMask.hasMaskedPixels(),
  );

  useEffect(() => {
    const sync = (): void => {
      setModelStatus(objectRemovalStatus.model);
      setSearchedPaths(objectRemovalStatus.searchedPaths);
      setRunning(objectRemovalRunner.isRunning());
    };
    objectRemovalStatus.subscribers.add(sync);
    const interval = window.setInterval(sync, 120);

    const syncMask = (): void => {
      setHasMask(activeScope().inpaintMask.hasMaskedPixels());
    };
    activeScope().inpaintMask.subscribe(syncMask);
    return () => {
      objectRemovalStatus.subscribers.delete(sync);
      window.clearInterval(interval);
      activeScope().inpaintMask.unsubscribe(syncMask);
    };
  }, []);

  const disabled =
    running || modelStatus !== "ready" || !hasMask;

  const handleSize = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const n = parseInt(e.target.value, 10);
    if (!isNaN(n)) {
      const clamped = Math.max(2, Math.min(400, n));
      objectRemovalOptions.size = clamped;
      setSize(clamped);
    }
  };

  return (
    <>
      <label className={styles.optLabel}>Size</label>
      <input
        type="number"
        className={styles.optInput}
        min={2}
        max={400}
        step={1}
        value={size}
        onChange={handleSize}
      />
      <span className={styles.optSep} />
      <button
        className={styles.optBtn}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          void objectRemovalRunner.apply();
        }}
        title="Inpaint the painted region using the LaMa model"
      >
        {running ? "Removing…" : "Apply"}
      </button>
      <button
        className={styles.optBtn}
        disabled={running || !hasMask}
        onClick={() => {
          activeScope().inpaintMask.clear();
        }}
        title="Clear the painted mask without removing anything"
      >
        Clear
      </button>
      <span className={styles.optSep} />
      <span className={styles.optLabel}>
        {modelStatus === "ready" && "Model ready"}
        {modelStatus === "checking" && "Checking model…"}
        {modelStatus === "missing" && (
          <>
            Model missing — place <code>lama_fp32.onnx</code> in{" "}
            <code>{searchedPaths[0] ?? "…/models/lama/"}</code>
          </>
        )}
        {modelStatus === "error" && "Model load failed"}
      </span>
    </>
  );
}

// ─── Tool ────────────────────────────────────────────────────────────────────

class ObjectRemovalTool implements ITool {
  readonly id = "object-removal" as const;
  readonly label = "Object Removal";
  readonly shortcut = "";
  readonly icon = <SvgIcon src={objectRemovalIconSvg} />;
  readonly placement = {
    group: ToolGroup.Retouching,
    row: 1,
    column: 1,
  } as const;
  // Writes into the active layer's pixels (via inpaint) — same locked-layer
  // semantics as a brush. `modifiesPixels` triggers Canvas's locked guard;
  // we set `skipAutoHistory` because the apply step captures its own entry.
  readonly modifiesPixels = true;
  readonly skipAutoHistory = true;
  readonly pixelOnly = true;
  readonly indexed8Unsupported = true;
  createHandler(): ToolHandler {
    return createObjectRemovalHandler();
  }
  readonly Options = ObjectRemovalOptions;
}

export const objectRemovalTool: ITool = new ObjectRemovalTool();
