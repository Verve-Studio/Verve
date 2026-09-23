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
import smudgeIconSvg from "./smudge.svg?raw";
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

export const smudgeOptions = {
  size: 50,
  /** 0..100 — drag intensity. Higher = pixels travel further along the stroke
   *  before fading. Maps directly to per-pixel offset along the motion vector. */
  strength: 50,
  /** 0..100 — fully-strong inner core, % of brush radius. */
  hardness: 50,
  /** Pen pressure modulates effective strength. */
  pressureStrength: true,
};

// ─── Bilinear sampling from a packed bbox snapshot ────────────────────────────

/** Sample (sx, sy) bilinearly from a (bw × bh) packed RGBA buffer. The buffer
 *  represents the layer-local rect with top-left corner at (minLx, minLy). */
function sampleSnapshot(
  buf: Uint8Array | Float32Array,
  bw: number,
  bh: number,
  minLx: number,
  minLy: number,
  sx: number,
  sy: number,
  out: Float64Array,
): void {
  const x = sx - minLx;
  const y = sy - minLy;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  out[0] = out[1] = out[2] = out[3] = 0;
  // Bilinear, alpha-weighted (premultiplied): transparent texels add no
  // colour, only (lack of) coverage. Out-of-bounds texels count as
  // transparent.
  for (let k = 0; k < 4; k++) {
    const px = x0 + (k & 1);
    const py = y0 + (k >> 1);
    if (px < 0 || py < 0 || px >= bw || py >= bh) continue;
    const wt = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy);
    const i = (py * bw + px) * 4;
    const aw = buf[i + 3] * wt;
    out[0] += buf[i] * aw;
    out[1] += buf[i + 1] * aw;
    out[2] += buf[i + 2] * aw;
    out[3] += aw;
  }
  if (out[3] > 0) {
    out[0] /= out[3];
    out[1] /= out[3];
    out[2] /= out[3];
  }
}

// ─── Stamp ────────────────────────────────────────────────────────────────────

function smudgeStamp(
  ctx: ToolContext,
  cx: number,
  cy: number,
  motionX: number,
  motionY: number,
  pressure: number,
): void {
  const layer = ctx.layer;
  if (layer.format === "indexed8") return;

  // Smudging an object outward extends it: grow the layer to the stamp's
  // footprint (+ drag distance) BEFORE reading its geometry / data — it used
  // to stop dead at the layer rectangle.
  ctx.growLayerToFit(
    Math.round(cx),
    Math.round(cy),
    Math.ceil(Math.max(1, smudgeOptions.size / 2) + Math.hypot(motionX, motionY)) + 2,
  );

  const opts = smudgeOptions;
  const strength01 =
    (opts.pressureStrength ? opts.strength * Math.max(0.05, pressure) : opts.strength) / 100;
  const hardness01 = Math.max(0, Math.min(1, opts.hardness / 100));
  const radius = Math.max(1, opts.size / 2);
  const isFloat = layer.format === "rgba32f";
  const data = layer.data as Uint8Array & Float32Array;
  const W = layer.layerWidth;
  const H = layer.layerHeight;

  const cxL = cx - layer.offsetX;
  const cyL = cy - layer.offsetY;

  // Snapshot a slightly-padded bounding box around the brush so the bilinear
  // sample (which reads at sub-pixel offsets potentially up to `motion *
  // strength` away) has the live pre-stamp data and isn't polluted by writes.
  const offsetMag = Math.hypot(motionX, motionY) * strength01;
  const pad = Math.ceil(offsetMag) + 2;
  const minLx = Math.max(0, Math.floor(cxL - radius) - pad);
  const maxLx = Math.min(W - 1, Math.ceil(cxL + radius) + pad);
  const minLy = Math.max(0, Math.floor(cyL - radius) - pad);
  const maxLy = Math.min(H - 1, Math.ceil(cyL + radius) + pad);
  if (minLx > maxLx || minLy > maxLy) return;
  const bw = maxLx - minLx + 1;
  const bh = maxLy - minLy + 1;

  const snapshot = scratchBuffer(0, isFloat, bw * bh * 4);
  copyLayerRect(data, W, minLx, minLy, bw, bh, snapshot);

  const max = isFloat ? 1 : 255;
  const sample = new Float64Array(4);

  forEachBrushPixel(
    W,
    H,
    { cxL, cyL, radius, hardness01, strength01, selection: brushSelection(ctx) },
    (lx, ly, w) => {
      // Sample the snapshot at the position the brush *came from*, scaled by
      // this pixel's per-stamp weight. This is what creates Photoshop's
      // directional drag — pixels under the brush travel along the stroke.
      const sx = lx - motionX * w;
      const sy = ly - motionY * w;
      sampleSnapshot(snapshot, bw, bh, minLx, minLy, sx, sy, sample);

      const sR = sample[0];
      const sG = sample[1];
      const sB = sample[2];
      const sA = sample[3];

      // Blend the dragged sample over the original at this pixel.
      const li = (ly * W + lx) * 4;
      const oi = ((ly - minLy) * bw + (lx - minLx)) * 4;
      const oR = snapshot[oi];
      const oG = snapshot[oi + 1];
      const oB = snapshot[oi + 2];
      const oA = snapshot[oi + 3];
      // Alpha-weighted mix (no dark fringes against transparency).
      const inv = 1 - w;
      const oW = oA * inv;
      const sW = sA * w;
      const outA = oW + sW;
      let r = oR;
      let g = oG;
      let b = oB;
      if (outA > 0) {
        r = (oR * oW + sR * sW) / outA;
        g = (oG * oW + sG * sW) / outA;
        b = (oB * oW + sB * sW) / outA;
      }
      if (isFloat) {
        const arr = data as Float32Array;
        arr[li] = r;
        arr[li + 1] = g;
        arr[li + 2] = b;
        arr[li + 3] = outA;
      } else {
        const arr = data as Uint8Array;
        arr[li] = Math.max(0, Math.min(max, Math.round(r)));
        arr[li + 1] = Math.max(0, Math.min(max, Math.round(g)));
        arr[li + 2] = Math.max(0, Math.min(max, Math.round(b)));
        arr[li + 3] = Math.max(0, Math.min(max, Math.round(outA)));
      }
    },
  );

  markBrushDirty(ctx.renderer, layer, cxL, cyL, radius);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function createSmudgeHandler(): ToolHandler {
  let prevX = 0;
  let prevY = 0;
  let isDown = false;

  return {
    onPointerDown(pos: ToolPointerPos, ctx: ToolContext): void {
      if (ctx.layer.format === "indexed8") return;
      isDown = true;
      ctx.renderer.strokeStart();
      prevX = pos.x;
      prevY = pos.y;
      // No motion yet — first stamp does nothing visible (matches PS).
    },
    onPointerMove(pos: ToolPointerPos, ctx: ToolContext): void {
      if (!isDown) return;
      const radius = Math.max(1, smudgeOptions.size / 2);
      const totalDx = pos.x - prevX;
      const totalDy = pos.y - prevY;
      // Iterate stamps along the segment; each stamp uses the per-stamp motion
      // (the segment length / number of stamps) so each step's offset drag is
      // proportional to that step.
      forEachStamp(prevX, prevY, pos.x, pos.y, radius * 0.25, (cx, cy) => {
        const dist = Math.hypot(totalDx, totalDy);
        const segDist = Math.max(1e-6, dist);
        const stamps = Math.max(1, Math.round(dist / (radius * 0.25)));
        const stepLen = segDist / stamps;
        const ux = totalDx / segDist;
        const uy = totalDy / segDist;
        smudgeStamp(
          ctx,
          cx,
          cy,
          ux * stepLen,
          uy * stepLen,
          pos.pressure,
        );
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

function SmudgeOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [size, setSize] = useState(smudgeOptions.size);
  const [strength, setStrength] = useState(smudgeOptions.strength);
  const [hardness, setHardness] = useState(smudgeOptions.hardness);
  const [pressureStrength, setPressureStrength] = useState(
    smudgeOptions.pressureStrength,
  );

  const setSizeOpt = (v: number): void => {
    smudgeOptions.size = v;
    setSize(v);
  };
  const setStrengthOpt = (v: number): void => {
    smudgeOptions.strength = v;
    setStrength(v);
  };
  const setHardnessOpt = (v: number): void => {
    smudgeOptions.hardness = v;
    setHardness(v);
  };
  const setPressureOpt = (v: boolean): void => {
    smudgeOptions.pressureStrength = v;
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

class SmudgeTool implements ITool {
  readonly id = "smudge";
  readonly label = "Smudge";
  readonly shortcut = "R";
  readonly icon = <SvgIcon src={smudgeIconSvg} />;
  readonly placement = {
    group: ToolGroup.LocalEffect,
    row: 1,
    column: 0,
  } as const;
  readonly modifiesPixels = true;
  readonly pixelOnly = true;
  readonly indexed8Unsupported = true;
  createHandler(): ToolHandler {
    return createSmudgeHandler();
  }
  readonly Options = SmudgeOptions;
}

export const smudgeTool: ITool = new SmudgeTool();
