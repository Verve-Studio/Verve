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
  forEachBrushPixel,
  forEachStamp,
  markBrushDirty,
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
  const data = layer.data as Uint8Array & Float32Array;

  // Per-pass: read from `src` (live data), write a blurred copy to `dst`,
  // swap. Final pass blends with the original snapshot using `weight`.
  let src: Float32Array | Uint8Array;
  if (isFloat) {
    src = new Float32Array(bw * bh * 4);
  } else {
    src = new Uint8Array(bw * bh * 4);
  }
  // Fill src from layer
  for (let y = 0; y < bh; y++) {
    const sy = minLy + y;
    for (let x = 0; x < bw; x++) {
      const sx = minLx + x;
      const li = (sy * W + sx) * 4;
      const di = (y * bw + x) * 4;
      src[di] = data[li];
      src[di + 1] = data[li + 1];
      src[di + 2] = data[li + 2];
      src[di + 3] = data[li + 3];
    }
  }
  // Original copy for final blend.
  const original = isFloat
    ? new Float32Array(src as Float32Array)
    : new Uint8Array(src as Uint8Array);

  let buf: Float32Array | Uint8Array = isFloat
    ? new Float32Array(bw * bh * 4)
    : new Uint8Array(bw * bh * 4);

  for (let pass = 0; pass < passes; pass++) {
    const s = src as Uint8Array | Float32Array;
    const d = buf as Uint8Array | Float32Array;
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
            r += s[i];
            g += s[i + 1];
            b += s[i + 2];
            a += s[i + 3];
            n++;
          }
        }
        const di = (y * bw + x) * 4;
        d[di] = r / n;
        d[di + 1] = g / n;
        d[di + 2] = b / n;
        d[di + 3] = a / n;
      }
    }
    // ping-pong
    const tmp = src;
    src = buf;
    buf = tmp;
  }

  // `src` now holds the blurred footprint. Mix with `original` per-pixel
  // weight and write back to layer.
  forEachBrushPixel(
    W,
    H,
    { cxL, cyL, radius, hardness01, strength01 },
    (lx, ly, w) => {
      const bx = lx - minLx;
      const by = ly - minLy;
      const bi = (by * bw + bx) * 4;
      const li = (ly * W + lx) * 4;
      const inv = 1 - w;
      if (isFloat) {
        const arr = data as Float32Array;
        arr[li] = original[bi] * inv + src[bi] * w;
        arr[li + 1] = original[bi + 1] * inv + src[bi + 1] * w;
        arr[li + 2] = original[bi + 2] * inv + src[bi + 2] * w;
        arr[li + 3] = original[bi + 3] * inv + src[bi + 3] * w;
      } else {
        const arr = data as Uint8Array;
        arr[li] = Math.round(original[bi] * inv + src[bi] * w);
        arr[li + 1] = Math.round(original[bi + 1] * inv + src[bi + 1] * w);
        arr[li + 2] = Math.round(original[bi + 2] * inv + src[bi + 2] * w);
        arr[li + 3] = Math.round(original[bi + 3] * inv + src[bi + 3] * w);
      }
    },
  );

  markBrushDirty(layer, cxL, cyL, radius);
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
      blurStamp(ctx, pos.x, pos.y, pos.pressure);
      ctx.renderer.flushLayer(ctx.layer);
      ctx.render();
    },
    onPointerMove(pos: ToolPointerPos, ctx: ToolContext): void {
      if (!isDown) return;
      const radius = Math.max(1, blurOptions.size / 2);
      forEachStamp(prevX, prevY, pos.x, pos.y, radius * 0.25, (cx, cy) => {
        blurStamp(ctx, cx, cy, pos.pressure);
      });
      prevX = pos.x;
      prevY = pos.y;
      ctx.renderer.flushLayer(ctx.layer);
      ctx.render();
    },
    onPointerUp(_pos: ToolPointerPos, _ctx: ToolContext): void {
      isDown = false;
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
