import React, { useState } from "react";
import { selectionStore } from "../core/store/selectionStore";
import type { SelectionMode } from "../core/store/selectionStore";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import type {
  ToolDefinition,
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "./types";

// ─── Shared options ────────────────────────────────────────────────────────────────

const lassoOptions = { feather: 0, antiAlias: true };

// ─── Handler ──────────────────────────────────────────────────────────────────

function createLassoHandler(): ToolHandler {
  let points: { x: number; y: number }[] = [];
  let mode: SelectionMode = "set";

  return {
    onPointerDown(
      { x, y, shiftKey, altKey }: ToolPointerPos,
      _ctx: ToolContext,
    ) {
      points = [{ x, y }];
      mode = altKey ? "subtract" : shiftKey ? "add" : "set";
      selectionStore.setPending({ type: "path", points: [...points] });
    },

    onPointerMove({ x, y }: ToolPointerPos, _ctx: ToolContext) {
      const last = points[points.length - 1];
      // Subsample: only record if moved at least 2px to keep array small
      if (Math.abs(x - last.x) < 2 && Math.abs(y - last.y) < 2) return;
      points.push({ x, y });
      selectionStore.setPending({ type: "path", points: [...points] });
    },

    onPointerUp({ x, y }: ToolPointerPos, _ctx: ToolContext) {
      points.push({ x, y });
      // feather=0 + antiAlias → 1px Gaussian for sub-pixel smoothing
      const effectiveFeather =
        lassoOptions.feather > 0
          ? lassoOptions.feather
          : lassoOptions.antiAlias
            ? 1
            : 0;
      selectionStore.setPolygon(points, mode, effectiveFeather);
      points = [];
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function LassoOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [feather, setFeather] = useState(lassoOptions.feather);
  const [antiAlias, setAntiAlias] = useState(lassoOptions.antiAlias);
  return (
    <>
      <label className={styles.optLabel}>Feather:</label>
      <SliderInput
        value={feather}
        min={0}
        max={100}
        inputWidth={38}
        suffix="px"
        onChange={(v) => {
          lassoOptions.feather = v;
          setFeather(v);
        }}
      />
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={antiAlias}
          onChange={(e) => {
            lassoOptions.antiAlias = e.target.checked;
            setAntiAlias(e.target.checked);
          }}
        />
        Anti-alias
      </label>
    </>
  );
}

export const lassoTool: ToolDefinition = {
  createHandler: createLassoHandler,
  Options: LassoOptions,
};
