import React, { useState } from "react";
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
import blurIconSvg from "./blur.svg?raw";
import {
  brushSelection,
  copyLayerRect,
  flushStamps,
  forEachBrushPixel,
  forEachStamp,
  markBrushDirty,
  scratchBuffer,
} from "../_shared/localBrush";

// ─── Module-level options ─────────────────────────────────────────────────────

export const blurOptions = {
  /** Brush diameter in canvas pixels. */
  size: 50,
  /** 0..100 — per-stamp mix weight. 100 = each stamp fully replaces the pixel
   *  with the local 3×3 average; lower values blur more gently. */
  strength: 50,
  /** 0..100 — radius of the fully-strong inner core, % of brush radius. */
  hardness: 50,
  /** 0..3 — number of additional 3×3 box-blur passes per stamp. Higher gives
   *  a stronger blur per dab but is slower. */
  passes: 1,
  /** Pen pressure modulates effective strength. */
  pressureStrength: true,
};

// ─── Stamp ────────────────────────────────────────────────────────────────────

function blurStamp(
  ctx: ToolContext,
  cx: number,
  cy: number,
  pressure: number,
): void {
  const layer = ctx.layer;
  const W = layer.layerWidth;
  const H = layer.layerHeight;

  // Indexed8 has no meaningful "blur" (palette indices can't average) — bail.
  if (layer.format === "indexed8") return;

  const opts = blurOptions;
  const strength01 =
    (opts.pressureStrength ? opts.strength * Math.max(0.05, pressure) : opts.strength) / 100;
  const hardness01 = Math.max(0, Math.min(1, opts.hardness / 100));
  const radius = Math.max(1, opts.size / 2);

  const cxL = cx - layer.offsetX;
  const cyL = cy - layer.offsetY;

  // Snapshot the brush bounding-box so the 3×3 sample reads from pre-stamp
  // pixels (otherwise the loop's own writes pollute neighbour samples).
  const minLx = Math.max(0, Math.floor(cxL - radius) - 1);
  const maxLx = Math.min(W - 1, Math.ceil(cxL + radius) + 1);
  const minLy = Math.max(0, Math.floor(cyL - radius) - 1);
  const maxLy = Math.min(H - 1, Math.ceil(cyL + radius) + 1);
  if (minLx > maxLx || minLy > maxLy) return;
  const bw = maxLx - minLx + 1;
  const bh = maxLy - minLy + 1;
  const passes = Math.max(1, Math.min(3, opts.passes | 0));
  const isFloat = layer.format === "rgba32f";
  const data = layer.data;

  const n4 = bw * bh * 4;
  const original = scratchBuffer(0, isFloat, n4);
  copyLayerRect(data, W, minLx, minLy, bw, bh, original);
  let src = scratchBuffer(1, isFloat, n4);
  src.set(original);
  let buf = scratchBuffer(2, isFloat, n4);

  // 3×3 box blur, `passes` times. Colours are averaged weighted by alpha
  // (premultiplied); a straight-alpha average pulls in the (usually black)
  // colour of transparent neighbours and leaves dark fringes at edges.
  for (let pass = 0; pass < passes; pass++) {
    const s = src;
    const d = buf;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let r = 0,
          g = 0,
          b = 0,
          a = 0,
          n = 0;
        const x0 = Math.max(0, x - 1);
        const x1 = Math.min(bw - 1, x + 1);
        const y0 = Math.max(0, y - 1);
        const y1 = Math.min(bh - 1, y + 1);
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const i = (yy * bw + xx) * 4;
            const al = s[i + 3];
            r += s[i] * al;
            g += s[i + 1] * al;
            b += s[i + 2] * al;
            a += al;
            n++;
          }
        }
        const di = (y * bw + x) * 4;
        if (a > 0) {
          d[di] = r / a;
          d[di + 1] = g / a;
          d[di + 2] = b / a;
        } else {
          d[di] = s[di];
          d[di + 1] = s[di + 1];
          d[di + 2] = s[di + 2];
        }
        d[di + 3] = a / n;
      }
    }
    // ping-pong
    const tmp = src;
    src = buf;
    buf = tmp;
  }

  // `src` now holds the blurred footprint. Mix with `original` per-pixel
  // weight (premultiplied) and write back to the layer.
  forEachBrushPixel(
    W,
    H,
    { cxL, cyL, radius, hardness01, strength01, selection: brushSelection(ctx) },
    (lx, ly, w) => {
      const bi = ((ly - minLy) * bw + (lx - minLx)) * 4;
      const li = (ly * W + lx) * 4;
      writeMix(data, li, original, src, bi, w, isFloat);
    },
  );

  markBrushDirty(ctx.renderer, layer, cxL, cyL, radius);
}

/**
 * data[li] = lerp(a[ai], b[ai], w) for one RGBA pixel, mixing colours
 * weighted by alpha so a transparent side contributes no colour.
 */
function writeMix(
  data: Uint8Array | Float32Array,
  li: number,
  a: Uint8Array | Float32Array,
  b: Uint8Array | Float32Array,
  ai: number,
  w: number,
  isFloat: boolean,
): void {
  const inv = 1 - w;
  const aA = a[ai + 3] * inv;
  const bA = b[ai + 3] * w;
  const outA = aA + bA;
  let r = a[ai];
  let g = a[ai + 1];
  let bl = a[ai + 2];
  if (outA > 0) {
    r = (a[ai] * aA + b[ai] * bA) / outA;
    g = (a[ai + 1] * aA + b[ai + 1] * bA) / outA;
    bl = (a[ai + 2] * aA + b[ai + 2] * bA) / outA;
  }
  if (isFloat) {
    data[li] = r;
    data[li + 1] = g;
    data[li + 2] = bl;
    data[li + 3] = outA;
  } else {
    data[li] = Math.round(r);
    data[li + 1] = Math.round(g);
    data[li + 2] = Math.round(bl);
    data[li + 3] = Math.round(outA);
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function createBlurHandler(): ToolHandler {
  let prevX = 0;
  let prevY = 0;
  let isDown = false;

  return {
    onPointerDown(pos: ToolPointerPos, ctx: ToolContext): void {
      isDown = true;
      prevX = pos.x;
      prevY = pos.y;
      ctx.renderer.strokeStart();
      blurStamp(ctx, pos.x, pos.y, pos.pressure);
      flushStamps(ctx);
    },
    onPointerMove(pos: ToolPointerPos, ctx: ToolContext): void {
      if (!isDown) return;
      const radius = Math.max(1, blurOptions.size / 2);
      forEachStamp(prevX, prevY, pos.x, pos.y, radius * 0.25, (cx, cy) => {
        blurStamp(ctx, cx, cy, pos.pressure);
      });
      prevX = pos.x;
      prevY = pos.y;
      flushStamps(ctx);
    },
    onPointerUp(_pos: ToolPointerPos, ctx: ToolContext): void {
      if (!isDown) return;
      isDown = false;
      ctx.renderer.strokeEnd();
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function BlurOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [size, setSize] = useState(blurOptions.size);
  const [strength, setStrength] = useState(blurOptions.strength);
  const [hardness, setHardness] = useState(blurOptions.hardness);
  const [passes, setPasses] = useState(blurOptions.passes);
  const [pressureStrength, setPressureStrength] = useState(
    blurOptions.pressureStrength,
  );

  const setSizeOpt = (v: number): void => {
    blurOptions.size = v;
    setSize(v);
  };
  const setStrengthOpt = (v: number): void => {
    blurOptions.strength = v;
    setStrength(v);
  };
  const setHardnessOpt = (v: number): void => {
    blurOptions.hardness = v;
    setHardness(v);
  };
  const setPassesOpt = (v: number): void => {
    blurOptions.passes = v;
    setPasses(v);
  };
  const setPressureOpt = (v: boolean): void => {
    blurOptions.pressureStrength = v;
    setPressureStrength(v);
  };

  return (
    <>
      <label className={styles.optLabel}>Size:</label>
      <SliderInput
        value={size}
        min={1}
        max={500}
        inputWidth={48}
        onChange={setSizeOpt}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Strength:</label>
      <SliderInput
        value={strength}
        min={0}
        max={100}
        suffix="%"
        inputWidth={42}
        onChange={setStrengthOpt}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Hardness:</label>
      <SliderInput
        value={hardness}
        min={0}
        max={100}
        suffix="%"
        inputWidth={42}
        onChange={setHardnessOpt}
      />
      <span className={styles.optSep} />
      <label
        className={styles.optLabel}
        title="Number of 3×3 box-blur passes per stamp. Higher = softer per-dab blur but slower."
      >
        Passes:
      </label>
      <SliderInput
        value={passes}
        min={1}
        max={3}
        inputWidth={32}
        onChange={setPassesOpt}
      />
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={pressureStrength}
          onChange={(e) => setPressureOpt(e.target.checked)}
        />
        Pressure → strength
      </label>
    </>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

class BlurTool implements ITool {
  readonly id = "blur";
  readonly label = "Blur";
  readonly shortcut = "R";
  readonly icon = <SvgIcon src={blurIconSvg} />;
  readonly placement = {
    group: ToolGroup.LocalEffect,
    row: 0,
    column: 0,
  } as const;
  readonly modifiesPixels = true;
  readonly pixelOnly = true;
  readonly indexed8Unsupported = true;
  createHandler(): ToolHandler {
    return createBlurHandler();
  }
  readonly Options = BlurOptions;
}

export const blurTool: ITool = new BlurTool();
