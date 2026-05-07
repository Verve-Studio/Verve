import React, { useState } from "react";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import { selectionStore } from "../core/store/selectionStore";
import type { SelectionMode } from "../core/store/selectionStore";
import type {
  ToolDefinition,
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "./types";
import { expandIndicesToRgba } from "@/utils/indexedColorUtils";
import { useAppContext } from "@/core/store/AppContext";

// ─── Shared options ───────────────────────────────────────────────────────────

export const wandOptions = {
  tolerance: 32,
  contiguous: true,
  feather: 0,
  dilation: 0,
  antiAlias: false,
};

// ─── Handler ──────────────────────────────────────────────────────────────────

function createMagicWandHandler(): ToolHandler {
  return {
    onPointerDown(
      { x, y, shiftKey, altKey }: ToolPointerPos,
      ctx: ToolContext,
    ) {
      const mode: SelectionMode = altKey
        ? "subtract"
        : shiftKey
          ? "add"
          : "set";

      // Build a canvas-sized RGBA buffer containing only the active layer's
      // pixels placed at the layer's offset. floodFillSelect indexes with
      // canvas-space coordinates, so the buffer must be canvas-sized.
      const { width: cw, height: ch } = selectionStore;
      const canvasData = new Uint8Array(cw * ch * 4);
      const layer = ctx.layer;
      const lw = layer.layerWidth;
      const lh = layer.layerHeight;
      const ox = layer.offsetX;
      const oy = layer.offsetY;

      if (ctx.layer.format === "indexed8") {
        const expandedLayer = expandIndicesToRgba(
          layer.data as Uint8Array,
          ctx.swatches,
        );
        for (let ly2 = 0; ly2 < lh; ly2++) {
          const cy2 = oy + ly2;
          if (cy2 < 0 || cy2 >= ch) continue;
          for (let lx2 = 0; lx2 < lw; lx2++) {
            const cx2 = ox + lx2;
            if (cx2 < 0 || cx2 >= cw) continue;
            const si = (ly2 * lw + lx2) * 4;
            const di = (cy2 * cw + cx2) * 4;
            canvasData[di] = expandedLayer[si];
            canvasData[di + 1] = expandedLayer[si + 1];
            canvasData[di + 2] = expandedLayer[si + 2];
            canvasData[di + 3] = expandedLayer[si + 3];
          }
        }
        selectionStore.floodFillSelect(
          x,
          y,
          canvasData,
          0,
          wandOptions.contiguous,
          mode,
          wandOptions.feather,
          wandOptions.dilation,
          wandOptions.antiAlias,
        );
        return;
      }

      const src = layer.data;
      for (let ly = 0; ly < lh; ly++) {
        const cy = oy + ly;
        if (cy < 0 || cy >= ch) continue;
        for (let lx = 0; lx < lw; lx++) {
          const cx = ox + lx;
          if (cx < 0 || cx >= cw) continue;
          const si = (ly * lw + lx) * 4;
          const di = (cy * cw + cx) * 4;
          canvasData[di] = src[si];
          canvasData[di + 1] = src[si + 1];
          canvasData[di + 2] = src[si + 2];
          canvasData[di + 3] = src[si + 3];
        }
      }
      selectionStore.floodFillSelect(
        x,
        y,
        canvasData,
        wandOptions.tolerance,
        wandOptions.contiguous,
        mode,
        wandOptions.feather,
        wandOptions.dilation,
        wandOptions.antiAlias,
      );
    },

    onPointerMove() {},
    onPointerUp() {},
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function MagicWandOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const { state } = useAppContext();
  const isIndexed = state.pixelFormat === "indexed8";
  const [tolerance, setTolerance] = useState(wandOptions.tolerance);
  const [contiguous, setContiguous] = useState(wandOptions.contiguous);
  const [feather, setFeather] = useState(wandOptions.feather);
  const [dilation, setDilation] = useState(wandOptions.dilation);
  const [antiAlias, setAntiAlias] = useState(wandOptions.antiAlias);

  return (
    <>
      <label
        className={styles.optLabel}
        style={isIndexed ? { opacity: 0.4 } : undefined}
      >
        Tolerance:
      </label>
      <SliderInput
        value={isIndexed ? 0 : tolerance}
        min={0}
        max={255}
        inputWidth={42}
        disabled={isIndexed}
        onChange={(v) => {
          wandOptions.tolerance = v;
          setTolerance(v);
        }}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Feather:</label>
      <SliderInput
        value={feather}
        min={0}
        max={100}
        inputWidth={38}
        suffix="px"
        onChange={(v) => {
          wandOptions.feather = v;
          setFeather(v);
        }}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Expand:</label>
      <SliderInput
        value={dilation}
        min={0}
        max={50}
        inputWidth={38}
        suffix="px"
        onChange={(v) => {
          wandOptions.dilation = v;
          setDilation(v);
        }}
      />
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={contiguous}
          onChange={(e) => {
            wandOptions.contiguous = e.target.checked;
            setContiguous(e.target.checked);
          }}
        />
        Contiguous
      </label>
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={antiAlias}
          onChange={(e) => {
            wandOptions.antiAlias = e.target.checked;
            setAntiAlias(e.target.checked);
          }}
        />
        Anti-alias
      </label>
    </>
  );
}

export const magicWandTool: ToolDefinition = {
  createHandler: createMagicWandHandler,
  Options: MagicWandOptions,
};
