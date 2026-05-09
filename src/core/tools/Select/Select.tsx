import React, { useState } from "react";

import type { SelectionMode } from "@/core/store/selectionStore";
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
import marqueeRectIconSvg from "./marquee-rect.svg?raw";
import { activeScope } from "@/core/store/scope";

// ─── Shared options ───────────────────────────────────────────────────────────

const selectOptions = {
  feather: 0,
  style: "normal" as "normal" | "fixed-ratio" | "fixed-size",
  fixedW: 100,
  fixedH: 75,
  ratioW: 4,
  ratioH: 3,
};

// ─── Helper: constrain end point to the active style ─────────────────────────

function constrainEnd(
  startX: number,
  startY: number,
  rawX: number,
  rawY: number,
): { x2: number; y2: number } {
  const dx = rawX - startX;
  const dy = rawY - startY;

  if (selectOptions.style === "fixed-size") {
    // Snap to exactly fixed W×H in the drag direction
    const signX = dx >= 0 ? 1 : -1;
    const signY = dy >= 0 ? 1 : -1;
    return {
      x2: startX + signX * selectOptions.fixedW,
      y2: startY + signY * selectOptions.fixedH,
    };
  }

  if (selectOptions.style === "fixed-ratio") {
    const rw = selectOptions.ratioW || 1;
    const rh = selectOptions.ratioH || 1;
    // Pick the dominant axis and scale the other to match the ratio
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const signX = dx >= 0 ? 1 : -1;
    const signY = dy >= 0 ? 1 : -1;
    if (absDx / rw >= absDy / rh) {
      // Width leads
      const w = absDx;
      const h = (w / rw) * rh;
      return { x2: startX + signX * w, y2: startY + signY * h };
    } else {
      // Height leads
      const h = absDy;
      const w = (h / rh) * rw;
      return { x2: startX + signX * w, y2: startY + signY * h };
    }
  }

  // normal — unconstrained
  return { x2: rawX, y2: rawY };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function createSelectHandler(): ToolHandler {
  let startX = 0;
  let startY = 0;
  let mode: SelectionMode = "set";

  return {
    onPointerDown(
      { x, y, shiftKey, altKey }: ToolPointerPos,
      _ctx: ToolContext,
    ) {
      startX = x;
      startY = y;
      mode = altKey ? "subtract" : shiftKey ? "add" : "set";
      // Apply constraint immediately so fixed-size shows the correct shape on click, not a dot
      const { x2, y2 } = constrainEnd(x, y, x, y);
      activeScope().selection.setPending({ type: "rect", x1: x, y1: y, x2, y2 });
    },

    onPointerMove({ x, y }: ToolPointerPos, _ctx: ToolContext) {
      const { x2, y2 } = constrainEnd(startX, startY, x, y);
      activeScope().selection.setPending({
        type: "rect",
        x1: startX,
        y1: startY,
        x2,
        y2,
      });
    },

    onPointerUp({ x, y }: ToolPointerPos, _ctx: ToolContext) {
      const { x2, y2 } = constrainEnd(startX, startY, x, y);
      activeScope().selection.setRect(
        startX,
        startY,
        x2,
        y2,
        mode,
        selectOptions.feather,
      );
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function SelectOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [feather, setFeather] = useState(selectOptions.feather);
  const [style, setStyle] = useState(selectOptions.style);
  const [fixedW, setFixedW] = useState(selectOptions.fixedW); // px
  const [fixedH, setFixedH] = useState(selectOptions.fixedH); // px
  const [ratioW, setRatioW] = useState(selectOptions.ratioW); // ratio numerator
  const [ratioH, setRatioH] = useState(selectOptions.ratioH); // ratio denominator

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
          selectOptions.feather = v;
          setFeather(v);
        }}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Style:</label>
      <select
        className={styles.optSelect}
        value={style}
        onChange={(e) => {
          selectOptions.style = e.target.value as typeof selectOptions.style;
          setStyle(selectOptions.style);
        }}
      >
        <option value="normal">Normal</option>
        <option value="fixed-ratio">Fixed Ratio</option>
        <option value="fixed-size">Fixed Size</option>
      </select>

      {style === "fixed-size" && (
        <>
          <span className={styles.optSep} />
          <label className={styles.optLabel}>W:</label>
          <SliderInput
            value={fixedW}
            min={1}
            max={4096}
            inputWidth={46}
            suffix="px"
            onChange={(v) => {
              selectOptions.fixedW = v;
              setFixedW(v);
            }}
          />
          <span className={styles.optText}>×</span>
          <SliderInput
            value={fixedH}
            min={1}
            max={4096}
            inputWidth={46}
            suffix="px"
            onChange={(v) => {
              selectOptions.fixedH = v;
              setFixedH(v);
            }}
          />
        </>
      )}

      {style === "fixed-ratio" && (
        <>
          <span className={styles.optSep} />
          <label className={styles.optLabel}>Ratio:</label>
          <SliderInput
            value={ratioW}
            min={1}
            max={999}
            inputWidth={38}
            onChange={(v) => {
              selectOptions.ratioW = v;
              setRatioW(v);
            }}
          />
          <span className={styles.optText}>:</span>
          <SliderInput
            value={ratioH}
            min={1}
            max={999}
            inputWidth={38}
            onChange={(v) => {
              selectOptions.ratioH = v;
              setRatioH(v);
            }}
          />
        </>
      )}
    </>
  );
}

class SelectTool implements ITool {
  readonly id = "select";
  readonly label = "Marquee";
  readonly shortcut = "M";
  readonly icon = <SvgIcon src={marqueeRectIconSvg} />;
  readonly placement = {
    group: ToolGroup.Selection,
    row: 0,
    column: 0,
  } as const;
  createHandler(): ToolHandler {
    return createSelectHandler();
  }
  readonly Options = SelectOptions;
}

export const selectTool: ITool = new SelectTool();
