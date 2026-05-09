import React, { useState } from "react";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import type {
  ToolDefinition,
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "./types";
import {
  forEachBrushPixel,
  forEachStamp,
  markBrushDirty,
} from "./algorithm/localBrush";

// ─── Module-level options ─────────────────────────────────────────────────────

export const sharpenOptions = {
  size: 50,
  /** 0..100 — per-stamp amount of high-pass added back. Defaults intentionally
   *  low: each stamp adds a tiny amount of edge contrast, so a slow drag
   *  builds up gradually without immediately blowing out. */
  strength: 15,
  /** 0..100 — radius of the fully-strong inner core, % of brush radius. */
  hardness: 50,
  /** When true, limit the high-pass response near already-saturated pixels so
   *  bright/dark areas don't blow out into halos. Mirrors PS "Protect Detail". */
  protectDetail: true,
  /** Pen pressure modulates effective strength. */
  pressureStrength: true,
};

// ─── Stamp ────────────────────────────────────────────────────────────────────

function sharpenStamp(
  ctx: ToolContext,
  cx: number,
  cy: number,
  pressure: number,
): void {
  const layer = ctx.layer;
  const W = layer.layerWidth;
  const H = layer.layerHeight;
  if (layer.format === "indexed8") return;

  const opts = sharpenOptions;
  const strength01 =
    (opts.pressureStrength ? opts.strength * Math.max(0.05, pressure) : opts.strength) / 100;
  const hardness01 = Math.max(0, Math.min(1, opts.hardness / 100));
  const radius = Math.max(1, opts.size / 2);

  const cxL = cx - layer.offsetX;
  const cyL = cy - layer.offsetY;

  const minLx = Math.max(0, Math.floor(cxL - radius) - 1);
  const maxLx = Math.min(W - 1, Math.ceil(cxL + radius) + 1);
  const minLy = Math.max(0, Math.floor(cyL - radius) - 1);
  const maxLy = Math.min(H - 1, Math.ceil(cyL + radius) + 1);
  if (minLx > maxLx || minLy > maxLy) return;
  const bw = maxLx - minLx + 1;
  const bh = maxLy - minLy + 1;
  const isFloat = layer.format === "rgba32f";
  const data = layer.data as Uint8Array & Float32Array;

  // Snapshot footprint (so 3×3 reads aren't polluted by writes within this
  // stamp). Use this as the "original" for the unsharp-mask formula.
  const original = isFloat
    ? new Float32Array(bw * bh * 4)
    : new Uint8Array(bw * bh * 4);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const li = ((minLy + y) * W + (minLx + x)) * 4;
      const di = (y * bw + x) * 4;
      original[di] = data[li];
      original[di + 1] = data[li + 1];
      original[di + 2] = data[li + 2];
      original[di + 3] = data[li + 3];
    }
  }

  const max = isFloat ? 1 : 255;
  const half = max / 2;

  forEachBrushPixel(
    W,
    H,
    { cxL, cyL, radius, hardness01, strength01 },
    (lx, ly, w) => {
      const bx = lx - minLx;
      const by = ly - minLy;
      // 3×3 average around (bx, by) from the snapshot.
      const x0 = Math.max(0, bx - 1);
      const x1 = Math.min(bw - 1, bx + 1);
      const y0 = Math.max(0, by - 1);
      const y1 = Math.min(bh - 1, by + 1);
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const i = (yy * bw + xx) * 4;
          r += original[i];
          g += original[i + 1];
          b += original[i + 2];
          a += original[i + 3];
          n++;
        }
      }
      r /= n;
      g /= n;
      b /= n;
      a /= n;

      const oi = (by * bw + bx) * 4;
      let dR = original[oi] - r;
      let dG = original[oi + 1] - g;
      let dB = original[oi + 2] - b;

      if (opts.protectDetail) {
        // Reduce response for pixels already near 0 or near max — softens
        // halos around hard edges. Triangle window centered at half-luma.
        const luma =
          0.299 * original[oi] +
          0.587 * original[oi + 1] +
          0.114 * original[oi + 2];
        const protect = 1 - Math.abs(luma - half) / half; // 1 at mid, 0 at extremes
        const k = 0.4 + 0.6 * Math.max(0, protect); // never below 40%
        dR *= k;
        dG *= k;
        dB *= k;
      }

      // Unsharp mask: result = original + amount * (original - blurred).
      // `w` already includes brush falloff and global strength.
      const li = (ly * W + lx) * 4;
      if (isFloat) {
        const arr = data as Float32Array;
        arr[li] = Math.max(0, Math.min(max, original[oi] + dR * w));
        arr[li + 1] = Math.max(0, Math.min(max, original[oi + 1] + dG * w));
        arr[li + 2] = Math.max(0, Math.min(max, original[oi + 2] + dB * w));
        arr[li + 3] = original[oi + 3];
      } else {
        const arr = data as Uint8Array;
        arr[li] = Math.max(0, Math.min(max, Math.round(original[oi] + dR * w)));
        arr[li + 1] = Math.max(
          0,
          Math.min(max, Math.round(original[oi + 1] + dG * w)),
        );
        arr[li + 2] = Math.max(
          0,
          Math.min(max, Math.round(original[oi + 2] + dB * w)),
        );
        arr[li + 3] = original[oi + 3];
      }
    },
  );

  markBrushDirty(layer, cxL, cyL, radius);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function createSharpenHandler(): ToolHandler {
  let prevX = 0;
  let prevY = 0;
  let isDown = false;

  return {
    onPointerDown(pos: ToolPointerPos, ctx: ToolContext): void {
      isDown = true;
      prevX = pos.x;
      prevY = pos.y;
      sharpenStamp(ctx, pos.x, pos.y, pos.pressure);
      ctx.renderer.flushLayer(ctx.layer);
      ctx.render();
    },
    onPointerMove(pos: ToolPointerPos, ctx: ToolContext): void {
      if (!isDown) return;
      const radius = Math.max(1, sharpenOptions.size / 2);
      forEachStamp(prevX, prevY, pos.x, pos.y, radius * 0.25, (cx, cy) => {
        sharpenStamp(ctx, cx, cy, pos.pressure);
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

function SharpenOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [size, setSize] = useState(sharpenOptions.size);
  const [strength, setStrength] = useState(sharpenOptions.strength);
  const [hardness, setHardness] = useState(sharpenOptions.hardness);
  const [protectDetail, setProtectDetail] = useState(
    sharpenOptions.protectDetail,
  );
  const [pressureStrength, setPressureStrength] = useState(
    sharpenOptions.pressureStrength,
  );

  const setSizeOpt = (v: number): void => {
    sharpenOptions.size = v;
    setSize(v);
  };
  const setStrengthOpt = (v: number): void => {
    sharpenOptions.strength = v;
    setStrength(v);
  };
  const setHardnessOpt = (v: number): void => {
    sharpenOptions.hardness = v;
    setHardness(v);
  };
  const setProtectOpt = (v: boolean): void => {
    sharpenOptions.protectDetail = v;
    setProtectDetail(v);
  };
  const setPressureOpt = (v: boolean): void => {
    sharpenOptions.pressureStrength = v;
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
        className={styles.optCheckLabel}
        title="Limit high-pass amplification near very bright or very dark pixels to reduce halos."
      >
        <input
          type="checkbox"
          checked={protectDetail}
          onChange={(e) => setProtectOpt(e.target.checked)}
        />
        Protect Detail
      </label>
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

export const sharpenTool: ToolDefinition = {
  createHandler: createSharpenHandler,
  Options: SharpenOptions,
  modifiesPixels: true,
};
