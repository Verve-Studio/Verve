import React, { useState } from "react";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";

import type { SelectionMode } from "@/core/store/selectionStore";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import polygonSelectIconSvg from "./polygon-select.svg?raw";
import { activeScope } from "@/core/store/scope";

// ─── Module-level options ──────────────────────────────────────────────────────

export const polygonalSelectionOptions = {
  mode: "set" as SelectionMode,
  feather: 0,
  antiAlias: true,
};

// ─── Snap helper ──────────────────────────────────────────────────────────────

const SNAP_RADIUS_PX = 12;

function isNearOrigin(x: number, y: number, zoom: number): boolean {
  const store = activeScope().polygonalSelection;
  if (store.vertices.length < 3) return false;
  const { x: ox, y: oy } = store.vertices[0];
  const dpr = window.devicePixelRatio;
  const dx = ((x - ox) * zoom) / dpr;
  const dy = ((y - oy) * zoom) / dpr;
  return dx * dx + dy * dy < SNAP_RADIUS_PX * SNAP_RADIUS_PX;
}

// ─── Handler factory ──────────────────────────────────────────────────────────

function createPolygonalSelectionHandler(): ToolHandler {
  let lastClickTime = 0;

  return {
    onPointerDown({ x, y, shiftKey, altKey, timeStamp }: ToolPointerPos) {
      const now = timeStamp;
      const isDoubleClick = now - lastClickTime < 300;
      lastClickTime = now;
      const store = activeScope().polygonalSelection;

      if (!store.isActive) {
        const mode: SelectionMode =
          shiftKey && altKey
            ? "intersect"
            : altKey
              ? "subtract"
              : shiftKey
                ? "add"
                : polygonalSelectionOptions.mode;
        store.start({ x, y }, mode);
        return;
      }

      if (isDoubleClick) {
        store.commit(
          polygonalSelectionOptions.feather,
          polygonalSelectionOptions.antiAlias,
        );
        return;
      }

      if (store.nearClose) {
        store.commit(
          polygonalSelectionOptions.feather,
          polygonalSelectionOptions.antiAlias,
        );
        return;
      }

      store.addVertex({ x, y });
    },

    onPointerMove({ x, y }: ToolPointerPos, ctx: ToolContext) {
      if (!activeScope().polygonalSelection.isActive) return;
      activeScope().polygonalSelection.setCursor({ x, y }, isNearOrigin(x, y, ctx.zoom));
    },

    onHover({ x, y }: ToolPointerPos, ctx: ToolContext) {
      if (!activeScope().polygonalSelection.isActive) return;
      activeScope().polygonalSelection.setCursor({ x, y }, isNearOrigin(x, y, ctx.zoom));
    },

    onLeave() {
      // Do not cancel — polygon persists across hover leave.
    },

    onPointerUp() {
      /* click-based tool; nothing to finalize per-up */
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
  // intersect
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

function PolygonalSelectionOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [mode, setMode] = useState(polygonalSelectionOptions.mode);
  const [feather, setFeather] = useState(polygonalSelectionOptions.feather);
  const [antiAlias, setAntiAlias] = useState(
    polygonalSelectionOptions.antiAlias,
  );

  const setM = (m: SelectionMode): void => {
    polygonalSelectionOptions.mode = m;
    setMode(m);
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
      <label className={styles.optLabel}>Feather:</label>
      <SliderInput
        value={feather}
        min={0}
        max={100}
        inputWidth={38}
        suffix="px"
        onChange={(v) => {
          polygonalSelectionOptions.feather = v;
          setFeather(v);
        }}
      />
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={antiAlias}
          onChange={(e) => {
            polygonalSelectionOptions.antiAlias = e.target.checked;
            setAntiAlias(e.target.checked);
          }}
        />
        Anti-alias
      </label>
    </>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

class PolygonalSelectionTool implements ITool {
  readonly id = "polygonal-selection";
  readonly label = "Polygonal Lasso";
  readonly shortcut = "L";
  readonly icon = <SvgIcon src={polygonSelectIconSvg} />;
  readonly placement = {
    group: ToolGroup.Selection,
    row: 1,
    column: 0,
  } as const;
  readonly shortcutCycle = "lasso" as const;
  createHandler(): ToolHandler {
    return createPolygonalSelectionHandler();
  }
  readonly Options = PolygonalSelectionOptions;
}

export const polygonalSelectionTool: ITool = new PolygonalSelectionTool();
