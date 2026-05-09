import React, { useState } from "react";
import { selectionStore } from "../../core/store/selectionStore";
import type { SelectionMode } from "../../core/store/selectionStore";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import lassoIconSvg from "./lasso.svg?raw";

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

class LassoTool implements ITool {
  readonly id = "lasso";
  readonly label = "Lasso";
  readonly shortcut = "L";
  readonly icon = <SvgIcon src={lassoIconSvg} />;
  readonly placement = {
    group: ToolGroup.Selection,
    row: 0,
    column: 1,
  } as const;
  readonly shortcutCycle = "polygonal-selection" as const;
  createHandler(): ToolHandler {
    return createLassoHandler();
  }
  readonly Options = LassoOptions;
}

export const lassoTool: ITool = new LassoTool();
