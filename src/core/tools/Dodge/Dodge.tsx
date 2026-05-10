import React, { useState } from "react";
import { dodgeBurnThickLine } from "./dodgeBurn";
import type { DodgeBurnRange } from "./dodgeBurn";
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
import dodgeIconSvg from "./dodge.svg?raw";
import burnIconSvg from "./burn.svg?raw";

// ─── Module-level options ─────────────────────────────────────────────────────

export const dodgeOptions = {
  size: 25,
  exposure: 50,
  hardness: 80,
  range: "midtones" as DodgeBurnRange,
  antiAlias: true,
};

export const burnOptions = {
  size: 25,
  exposure: 50,
  hardness: 80,
  range: "midtones" as DodgeBurnRange,
  antiAlias: true,
};

// ─── Handler factory ──────────────────────────────────────────────────────────

function createDodgeBurnHandler(
  opts: typeof dodgeOptions,
  sign: 1 | -1,
): () => ToolHandler {
  return function (): ToolHandler {
    let lastPos: { x: number; y: number } | null = null;
    let touched: Map<number, number> | null = null;
    let origData: Map<
      number,
      readonly [number, number, number, number]
    > | null = null;

    function stamp(
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      ctx: ToolContext,
    ): void {
      const { renderer, layer, layers, selectionMask, render, growLayerToFit } =
        ctx;
      const radius = opts.size / 2;
      growLayerToFit(x0, y0, Math.ceil(radius));
      if (x1 !== x0 || y1 !== y0) growLayerToFit(x1, y1, Math.ceil(radius));
      const sel = selectionMask
        ? { mask: selectionMask, width: renderer.pixelWidth }
        : undefined;
      dodgeBurnThickLine(
        renderer,
        layer,
        x0,
        y0,
        x1,
        y1,
        opts.size,
        (sign * opts.exposure) / 100,
        opts.range,
        opts.hardness,
        opts.antiAlias,
        touched ?? undefined,
        sel,
        origData ?? undefined,
      );

      // Restrict the GPU upload to the just-touched region — without this
      // the whole layer texture is DMA'd on every pointer event.
      // (Tiled mode isn't supported by this tool, so no wrap edge case.)
      const padR = Math.ceil(radius) + 2;
      const lx = Math.max(
        0,
        Math.floor(Math.min(x0, x1) - layer.offsetX) - padR,
      );
      const ly = Math.max(
        0,
        Math.floor(Math.min(y0, y1) - layer.offsetY) - padR,
      );
      const rx = Math.min(
        layer.layerWidth,
        Math.ceil(Math.max(x0, x1) - layer.offsetX) + padR + 1,
      );
      const ry = Math.min(
        layer.layerHeight,
        Math.ceil(Math.max(y0, y1) - layer.offsetY) + padR + 1,
      );
      renderer.markDirtyRect(layer, lx, ly, rx, ry);

      renderer.flushLayer(layer);
      render(layers);
    }

    return {
      onPointerDown({ x, y }: ToolPointerPos, ctx: ToolContext) {
        ctx.renderer.strokeStart();
        touched = new Map();
        origData = new Map();
        lastPos = null;
        stamp(x, y, x, y, ctx);
        lastPos = { x, y };
      },

      onPointerMove({ x, y }: ToolPointerPos, ctx: ToolContext) {
        if (!lastPos) return;
        stamp(lastPos.x, lastPos.y, x, y, ctx);
        lastPos = { x, y };
      },

      onPointerUp(_pos: ToolPointerPos, ctx: ToolContext) {
        lastPos = null;
        touched = null;
        origData = null;
        ctx.renderer.strokeEnd();
      },
    };
  };
}

// ─── Shared options UI ────────────────────────────────────────────────────────

function DodgeBurnOptions({
  opts,
  styles,
}: {
  opts: typeof dodgeOptions;
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [size, setSize] = useState(opts.size);
  const [exposure, setExposure] = useState(opts.exposure);
  const [hardness, setHardness] = useState(opts.hardness);
  const [range, setRange] = useState<DodgeBurnRange>(opts.range);
  const [antiAlias, setAA] = useState(opts.antiAlias);

  const handleSize = (v: number): void => {
    opts.size = v;
    setSize(v);
  };
  const handleExposure = (v: number): void => {
    opts.exposure = v;
    setExposure(v);
  };
  const handleHardness = (v: number): void => {
    opts.hardness = v;
    setHardness(v);
  };
  const handleRange = (v: DodgeBurnRange): void => {
    opts.range = v;
    setRange(v);
  };
  const handleAA = (v: boolean): void => {
    opts.antiAlias = v;
    setAA(v);
  };

  return (
    <>
      <label className={styles.optLabel}>Size:</label>
      <SliderInput
        value={size}
        min={1}
        max={200}
        inputWidth={42}
        onChange={handleSize}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Hardness:</label>
      <SliderInput
        value={hardness}
        min={0}
        max={100}
        suffix="%"
        inputWidth={42}
        onChange={handleHardness}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Exposure:</label>
      <SliderInput
        value={exposure}
        min={1}
        max={100}
        suffix="%"
        inputWidth={42}
        onChange={handleExposure}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Range:</label>
      <select
        className={styles.optSelect}
        value={range}
        onChange={(e) => handleRange(e.target.value as DodgeBurnRange)}
      >
        <option value="shadows">Shadows</option>
        <option value="midtones">Midtones</option>
        <option value="highlights">Highlights</option>
      </select>
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={antiAlias}
          onChange={(e) => handleAA(e.target.checked)}
        />
        Anti-alias
      </label>
    </>
  );
}

// ─── Tool exports ─────────────────────────────────────────────────────────────

class DodgeTool implements ITool {
  readonly id = "dodge";
  readonly label = "Dodge";
  readonly shortcut = "O";
  readonly icon = <SvgIcon src={dodgeIconSvg} />;
  readonly placement = { group: ToolGroup.Tonal, row: 0, column: 0 } as const;
  readonly modifiesPixels = true;
  readonly pixelOnly = true;
  readonly indexed8Unsupported = true;
  private readonly handlerFactory = createDodgeBurnHandler(dodgeOptions, 1);
  createHandler(): ToolHandler {
    return this.handlerFactory();
  }
  readonly Options = ({ styles }: { styles: ToolOptionsStyles }) => (
    <DodgeBurnOptions opts={dodgeOptions} styles={styles} />
  );
}

class BurnTool implements ITool {
  readonly id = "burn";
  readonly label = "Burn";
  readonly shortcut = "O";
  readonly icon = <SvgIcon src={burnIconSvg} />;
  readonly placement = { group: ToolGroup.Tonal, row: 0, column: 1 } as const;
  readonly modifiesPixels = true;
  readonly pixelOnly = true;
  readonly indexed8Unsupported = true;
  private readonly handlerFactory = createDodgeBurnHandler(burnOptions, -1);
  createHandler(): ToolHandler {
    return this.handlerFactory();
  }
  readonly Options = ({ styles }: { styles: ToolOptionsStyles }) => (
    <DodgeBurnOptions opts={burnOptions} styles={styles} />
  );
}

export const dodgeTool: ITool = new DodgeTool();
export const burnTool: ITool = new BurnTool();
