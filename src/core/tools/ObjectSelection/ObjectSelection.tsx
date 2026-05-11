
import type { SelectionMode } from "@/core/store/selectionStore";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import React, { useEffect, useState } from "react";
import type {
  ToolHandler,
  ToolOptionsStyles,
  ToolPointerPos,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import objectSelectIconSvg from "./object-select.svg?raw";
import { activeScope } from "@/core/store/scope";

// ─── Module-level options ──────────────────────────────────────────────────────

export const objectSelectionOptions = {
  mode: "set" as SelectionMode,
  feather: 0,
  antiAlias: true,
  promptMode: "rect" as "rect" | "point",
  refineMode: "hair" as "hair" | "object",
};

// ─── Module-level callbacks (set by useObjectSelection) ───────────────────────

export const objectSelectionCallbacks = {
  commit: (_mode: SelectionMode) => {
    /* set by hook */
  },
  cancel: () => {
    /* set by hook */
  },
  downloadModel: () => {
    /* not used — models are bundled */
  },
  runSubject: () => {
    /* set by hook */
  },
  refineEdge: () => {
    /* set by hook */
  },
  downloadMattingModel: () => {
    /* set by hook */
  },
};

// ─── Handler factory ──────────────────────────────────────────────────────────

function createObjectSelectionHandler(): ToolHandler {
  return {
    onPointerDown({ x, y, altKey }: ToolPointerPos) {
      if (activeScope().objectSelection.modelStatus !== "ready") return;
      if (objectSelectionOptions.promptMode === "rect") {
        activeScope().objectSelection.setDragRect(x, y, x, y);
      } else {
        activeScope().objectSelection.addPoint({ x, y, positive: !altKey });
      }
    },

    onPointerMove({ x, y }: ToolPointerPos) {
      if (!activeScope().objectSelection.isDragging) return;
      const r = activeScope().objectSelection.dragRect!;
      activeScope().objectSelection.setDragRect(r.x1, r.y1, x, y);
    },

    onPointerUp({ x, y }: ToolPointerPos) {
      if (!activeScope().objectSelection.isDragging) return;
      const r = activeScope().objectSelection.dragRect!;
      if (Math.abs(x - r.x1) < 8 || Math.abs(y - r.y1) < 8) {
        activeScope().objectSelection.dragRect = null;
        activeScope().objectSelection.endDrag();
        return;
      }
      // Clamp final position to drag end
      activeScope().objectSelection.dragRect = { x1: r.x1, y1: r.y1, x2: x, y2: y };
      activeScope().objectSelection.endDrag();
      // useObjectSelection is subscribed and will trigger inference
    },

    onLeave() {
      // Keep drag state — don't cancel on leave
    },
  };
}

// ─── Mode helpers ─────────────────────────────────────────────────────────────

function modeLabel(m: SelectionMode): string {
  if (m === "set") return "New Selection";
  if (m === "add") return "Add to Selection";
  if (m === "subtract") return "Subtract from Selection";
  return "Intersect with Selection";
}

function modeIcon(m: SelectionMode): React.JSX.Element {
  if (m === "set") {
    return (
      <svg
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      >
        <rect x="1" y="1" width="12" height="12" strokeDasharray="2.5 1.5" />
      </svg>
    );
  }
  if (m === "add") {
    return (
      <svg
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      >
        <rect x="1" y="4" width="9" height="9" strokeDasharray="2.5 1.5" />
        <rect x="4" y="1" width="9" height="9" strokeDasharray="2.5 1.5" />
        <line
          x1="11"
          y1="1"
          x2="11"
          y2="4"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <line
          x1="10"
          y1="2.5"
          x2="12"
          y2="2.5"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
    );
  }
  if (m === "subtract") {
    return (
      <svg
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      >
        <rect x="1" y="4" width="9" height="9" strokeDasharray="2.5 1.5" />
        <rect x="4" y="1" width="9" height="9" strokeDasharray="2.5 1.5" />
        <line
          x1="10"
          y1="2.5"
          x2="12"
          y2="2.5"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    >
      <rect x="1" y="4" width="9" height="9" strokeDasharray="2.5 1.5" />
      <rect x="4" y="1" width="9" height="9" strokeDasharray="2.5 1.5" />
    </svg>
  );
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function ObjectSelectionOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [modelStatus, setModelStatus] = useState(
    activeScope().objectSelection.modelStatus,
  );
  const [inferenceStatus, setInferenceStatus] = useState(
    activeScope().objectSelection.inferenceStatus,
  );
  const [mode, setMode] = useState(objectSelectionOptions.mode);
  const [promptMode, setPromptMode] = useState(
    objectSelectionOptions.promptMode,
  );
  const [feather, setFeather] = useState(objectSelectionOptions.feather);
  const [antiAlias, setAntiAlias] = useState(objectSelectionOptions.antiAlias);
  const [refineMode, setRefineMode] = useState(
    objectSelectionOptions.refineMode,
  );
  const [hasPendingMask, setHasPendingMask] = useState(
    activeScope().objectSelection.pendingMask !== null,
  );
  const [mattingStatus, setMattingStatus] = useState(
    activeScope().objectSelection.mattingModelStatus,
  );
  const [refineStatus, setRefineStatus] = useState(
    activeScope().objectSelection.refineStatus,
  );
  const [mattingProgress, setMattingProgress] = useState(
    activeScope().objectSelection.mattingDownloadProgress,
  );

  useEffect(() => {
    const update = (): void => {
      setModelStatus(activeScope().objectSelection.modelStatus);
      setInferenceStatus(activeScope().objectSelection.inferenceStatus);
      setHasPendingMask(activeScope().objectSelection.pendingMask !== null);
      setMattingStatus(activeScope().objectSelection.mattingModelStatus);
      setRefineStatus(activeScope().objectSelection.refineStatus);
      setMattingProgress(activeScope().objectSelection.mattingDownloadProgress);
    };
    activeScope().objectSelection.subscribe(update);
    return () => activeScope().objectSelection.unsubscribe(update);
  }, []);

  // ── Model not downloaded ────────────────────────────────────────────────────

  if (modelStatus === "unknown" || modelStatus === "checking") {
    return <span className={styles.optText}>Checking model…</span>;
  }

  if (modelStatus === "error") {
    return (
      <span className={styles.optText}>
        EfficientSAM model not found. Place encoder.onnx and decoder.onnx in
        resources/models/efficientsam/.
      </span>
    );
  }

  // ── Model ready ─────────────────────────────────────────────────────────────

  const setM = (m: SelectionMode): void => {
    objectSelectionOptions.mode = m;
    setMode(m);
  };

  const setP = (p: "rect" | "point"): void => {
    objectSelectionOptions.promptMode = p;
    activeScope().objectSelection.promptMode = p;
    setPromptMode(p);
  };

  return (
    <>
      <label className={styles.optLabel}>Mode:</label>
      {(["set", "add", "subtract", "intersect"] as const).map((m) => (
        <button
          key={m}
          className={`${styles.optModeBtn} ${mode === m ? styles.optModeBtnActive : ""}`}
          title={modeLabel(m)}
          onClick={() => setM(m)}
        >
          {modeIcon(m)}
        </button>
      ))}
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Prompt:</label>
      <button
        className={`${styles.optBtn} ${promptMode === "rect" ? styles.optModeBtnActive : ""}`}
        onClick={() => setP("rect")}
        title="Rectangle prompt"
      >
        Rect
      </button>
      <button
        className={`${styles.optBtn} ${promptMode === "point" ? styles.optModeBtnActive : ""}`}
        onClick={() => setP("point")}
        title="Point prompt (Alt+click for negative)"
      >
        Point
      </button>
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Feather:</label>
      <SliderInput
        value={feather}
        min={0}
        max={100}
        inputWidth={38}
        suffix="px"
        onChange={(v) => {
          objectSelectionOptions.feather = v;
          setFeather(v);
        }}
      />
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={antiAlias}
          onChange={(e) => {
            objectSelectionOptions.antiAlias = e.target.checked;
            setAntiAlias(e.target.checked);
          }}
        />
        Anti-alias
      </label>
      <span className={styles.optSep} />
      <button
        className={styles.optBtn}
        onClick={() => objectSelectionCallbacks.runSubject()}
        disabled={inferenceStatus === "running"}
        title="Auto-detect and select the main subject"
      >
        Subject
      </button>
      <span className={styles.optSep} />
      {mattingStatus === "ready" ? (
        <>
          <select
            className={styles.optSelect}
            value={refineMode}
            onChange={(e) => {
              objectSelectionOptions.refineMode = e.target.value as
                | "hair"
                | "object";
              setRefineMode(e.target.value as "hair" | "object");
            }}
            title="Refine Edge algorithm"
          >
            <option value="hair">Hair / Fur</option>
            <option value="object">Object / Hard Edge</option>
          </select>
          <button
            className={styles.optBtn}
            onClick={() => objectSelectionCallbacks.refineEdge()}
            disabled={refineStatus === "running"}
            title="Alpha matting refinement of the current selection edges"
          >
            {refineStatus === "running" ? "Refining…" : "Refine Edge"}
          </button>
        </>
      ) : mattingStatus === "downloading" ? (
        <span className={styles.optText}>
          Downloading Refine Edge model
          {mattingProgress && mattingProgress.total > 0
            ? ` ${Math.round(mattingProgress.progress * 100)}%`
            : "…"}
        </span>
      ) : mattingStatus === "error" || mattingStatus === "unknown" ? (
        <button
          className={styles.optBtn}
          onClick={() => objectSelectionCallbacks.downloadMattingModel()}
          title="Download RVM matting model (~14 MB) for Refine Edge"
        >
          Get Refine Edge (~14 MB)
        </button>
      ) : null}
      {inferenceStatus === "running" && (
        <span className={styles.optText}>Analyzing…</span>
      )}
      {hasPendingMask && (
        <>
          <span className={styles.optSep} />
          <button
            className={styles.optBtn}
            onClick={() =>
              objectSelectionCallbacks.commit(objectSelectionOptions.mode)
            }
            title="Commit selection (Enter)"
          >
            ✓ Commit
          </button>
          <button
            className={styles.optBtn}
            onClick={() => objectSelectionCallbacks.cancel()}
            title="Cancel selection (Escape)"
          >
            ✗
          </button>
        </>
      )}
    </>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

class ObjectSelectionTool implements ITool {
  readonly id = "object-selection";
  readonly label = "Object Selection";
  readonly shortcut = "W";
  readonly icon = <SvgIcon src={objectSelectIconSvg} />;
  readonly placement = {
    group: ToolGroup.Selection,
    row: 2,
    column: 1,
  } as const;
  readonly shortcutCycle = "magic-wand" as const;
  createHandler(): ToolHandler {
    return createObjectSelectionHandler();
  }
  readonly Options = ObjectSelectionOptions;
}

export const objectSelectionTool: ITool = new ObjectSelectionTool();
