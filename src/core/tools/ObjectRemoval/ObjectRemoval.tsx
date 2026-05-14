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
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import { activeScope } from "@/core/store/scope";
import objectRemovalIconSvg from "./object-removal.svg?raw";

// ─── Module-level options + runner ────────────────────────────────────────────

export const objectRemovalOptions = {
  /** Brush diameter in canvas pixels. Read both by the tool handler (for
   *  mask stamping) and by `useBrushCursor` (for the CSS-circle cursor). */
  size: 40,
  /** When true, Apply deposits the inpainted region on a new layer above
   *  the active layer (transparent outside the painted mask). When false,
   *  Apply overwrites the active layer's pixels in place. Default is true
   *  because non-destructive retouching is the more recoverable workflow
   *  — the original is preserved underneath. */
  outputToNewLayer: true,
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
  const [outputToNewLayer, setOutputToNewLayer] = useState(
    objectRemovalOptions.outputToNewLayer,
  );
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

  return (
    <>
      <label className={styles.optLabel}>Size:</label>
      <SliderInput
        value={size}
        min={1}
        max={1000}
        inputWidth={52}
        onChange={(v) => {
          objectRemovalOptions.size = v;
          setSize(v);
        }}
      />
      <span className={styles.optSep} />
      <label
        className={styles.optCheckLabel}
        title="Deposit the inpainted region on a new layer above the active layer (transparent outside the painted mask). When unchecked, overwrites the active layer's pixels in place."
      >
        <input
          type="checkbox"
          checked={outputToNewLayer}
          onChange={(e) => {
            objectRemovalOptions.outputToNewLayer = e.target.checked;
            setOutputToNewLayer(e.target.checked);
          }}
        />
        Output to new layer
      </label>
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
        {modelStatus === "ready" && ""}
        {modelStatus === "checking" && "Loading…"}
        {modelStatus === "missing" && (
          <>
            Required components not available.-=
          </>
        )}
        {modelStatus === "error" && "Could not load object removal tool"}
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
