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
import liquifyIconSvg from "./liquify.svg?raw";

// ─── Module-level options ─────────────────────────────────────────────────────

export type LiquifyMode = "push" | "twirl-cw" | "twirl-ccw" | "pinch" | "bloat";

export const liquifyOptions = {
  /** Brush diameter in canvas pixels. */
  size: 100,
  /** 0..100 — multiplier on the per-frame displacement applied inside the brush. */
  strength: 50,
  /** 0..100 — radius of the fully-strong inner core as a fraction of the brush
   *  radius. 100 = hard edge (constant strength inside, zero outside).
   *  0 = soft cosine falloff from center to edge. */
  hardness: 50,
  /** Mode of distortion. */
  mode: "push" as LiquifyMode,
  /** Pressure modulates effective brush size. */
  pressureSize: false,
  /** Pressure modulates effective brush strength. */
  pressureStrength: false,
  /** Used by twirl/pinch/bloat — how fast the rotation/contraction proceeds
   *  per-frame relative to the brush radius. */
  rate: 50,
};

// ─── Falloff helpers ──────────────────────────────────────────────────────────

/**
 * Brush falloff from center (t=0) to edge (t=1).
 *   hardness 0   → cosine ramp from 1 at center to 0 at edge
 *   hardness 100 → step (1 inside, 0 outside)
 * In between: a flat-top "core" of radius hardness/100 with a cosine ramp on
 * the outside edge.
 */
function falloff(t: number, hardness01: number): number {
  if (t >= 1) return 0;
  if (t <= hardness01) return 1;
  const u = (t - hardness01) / (1 - hardness01);
  return 0.5 + 0.5 * Math.cos(Math.PI * u);
}

// ─── Bilinear sampling ────────────────────────────────────────────────────────

interface SourceLayer {
  data: Uint8Array | Float32Array;
  width: number;
  height: number;
  format: "rgba8" | "rgba32f" | "indexed8";
}

/** Sample the source layer at sub-pixel (sx, sy). Out-of-bounds returns 0000.
 *  rgba8/rgba32f use bilinear; indexed8 uses nearest-neighbour because palette
 *  indices can't be linearly interpolated. */
function sampleSource(
  src: SourceLayer,
  sx: number,
  sy: number,
  out: Float64Array,
): void {
  const { width: W, height: H, data, format } = src;

  if (format === "indexed8") {
    const ix = Math.round(sx);
    const iy = Math.round(sy);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) {
      out[0] = 255;
      return;
    }
    out[0] = (data as Uint8Array)[iy * W + ix];
    return;
  }

  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const fx = sx - x0;
  const fy = sy - y0;
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  const fetch = (x: number, y: number, ch: number): number => {
    if (x < 0 || y < 0 || x >= W || y >= H) return 0;
    const i = (y * W + x) * 4 + ch;
    return data[i];
  };

  for (let ch = 0; ch < 4; ch++) {
    out[ch] =
      fetch(x0, y0, ch) * w00 +
      fetch(x1, y0, ch) * w10 +
      fetch(x0, y1, ch) * w01 +
      fetch(x1, y1, ch) * w11;
  }
}

function writeDest(
  dst: Uint8Array | Float32Array,
  format: "rgba8" | "rgba32f" | "indexed8",
  W: number,
  lx: number,
  ly: number,
  sample: Float64Array,
): void {
  if (format === "indexed8") {
    (dst as Uint8Array)[ly * W + lx] = sample[0] | 0;
    return;
  }
  const i = (ly * W + lx) * 4;
  if (format === "rgba32f") {
    (dst as Float32Array)[i] = sample[0];
    (dst as Float32Array)[i + 1] = sample[1];
    (dst as Float32Array)[i + 2] = sample[2];
    (dst as Float32Array)[i + 3] = sample[3];
  } else {
    (dst as Uint8Array)[i] = Math.max(0, Math.min(255, Math.round(sample[0])));
    (dst as Uint8Array)[i + 1] = Math.max(
      0,
      Math.min(255, Math.round(sample[1])),
    );
    (dst as Uint8Array)[i + 2] = Math.max(
      0,
      Math.min(255, Math.round(sample[2])),
    );
    (dst as Uint8Array)[i + 3] = Math.max(
      0,
      Math.min(255, Math.round(sample[3])),
    );
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function createLiquifyHandler(): ToolHandler {
  // Per-stroke state. Every push/twirl/etc. accumulates into `dispMap` (the
  // displacement field) and resamples touched pixels from `snapshot` (the
  // pre-stroke layer image). Sampling from an unchanging snapshot avoids the
  // sample-write aliasing artefacts you get when warping live pixels.
  let snapshot: Uint8Array | Float32Array | null = null;
  let dispMap: Float32Array | null = null; // 2 floats per pixel: dx, dy
  let strokeW = 0;
  let strokeH = 0;
  let strokeFormat: "rgba8" | "rgba32f" | "indexed8" = "rgba8";
  let prevX = 0;
  let prevY = 0;
  let isDown = false;

  function applyAt(
    ctx: ToolContext,
    cx: number, // canvas-space brush center
    cy: number,
    motionX: number, // canvas-space motion vector since previous sample
    motionY: number,
    pressure: number,
  ): void {
    const layer = ctx.layer;
    if (!snapshot || !dispMap) return;
    if (layer.layerWidth !== strokeW || layer.layerHeight !== strokeH) return;

    const opts = liquifyOptions;
    const size = opts.pressureSize
      ? opts.size * Math.max(0.05, pressure)
      : opts.size;
    const strength01 = (opts.pressureStrength
      ? opts.strength * Math.max(0.05, pressure)
      : opts.strength) / 100;
    const hardness01 = Math.max(0, Math.min(1, opts.hardness / 100));
    const radius = Math.max(1, size / 2);
    const r2 = radius * radius;

    // Convert brush center to layer-local.
    const cxL = cx - layer.offsetX;
    const cyL = cy - layer.offsetY;

    const minLx = Math.max(0, Math.floor(cxL - radius));
    const maxLx = Math.min(strokeW - 1, Math.ceil(cxL + radius));
    const minLy = Math.max(0, Math.floor(cyL - radius));
    const maxLy = Math.min(strokeH - 1, Math.ceil(cyL + radius));
    if (minLx > maxLx || minLy > maxLy) return;

    const src: SourceLayer = {
      data: snapshot,
      width: strokeW,
      height: strokeH,
      format: strokeFormat,
    };
    const sample = new Float64Array(4);
    const dst = layer.data;

    // Per-mode angular/radial field (in addition to the linear push).
    const mode = opts.mode;
    // Twirl angular speed per frame, scaled by rate. Positive = CW (in
    // screen-y-down coords).
    const twirlSign = mode === "twirl-cw" ? 1 : mode === "twirl-ccw" ? -1 : 0;
    const radialSign = mode === "pinch" ? 1 : mode === "bloat" ? -1 : 0;
    const rate01 = opts.rate / 100;

    for (let ly = minLy; ly <= maxLy; ly++) {
      const dy = ly - cyL;
      for (let lx = minLx; lx <= maxLx; lx++) {
        const dx = lx - cxL;
        const dist2 = dx * dx + dy * dy;
        if (dist2 > r2) continue;
        const dist = Math.sqrt(dist2);
        const t = dist / radius;
        const f = falloff(t, hardness01) * strength01;
        if (f <= 0) continue;

        const idx2 = (ly * strokeW + lx) * 2;

        if (mode === "push") {
          // Forward warp: pixels travel with the brush. Sampling at
          //   sx = lx - dispMap[lx,ly]
          // means a positive dispMap.x makes the destination pull from the
          // LEFT, which visually shows pixels translated to the RIGHT — i.e.
          // the same direction as the brush motion.
          dispMap[idx2] += motionX * f;
          dispMap[idx2 + 1] += motionY * f;
        } else if (twirlSign !== 0 && dist > 0.0001) {
          // Tangential displacement around brush center. dispMap stores
          // FORWARD motion (where each pixel travels), so we compute the
          // pixel's rotated forward position and accumulate (forward - p).
          // angle > 0 with the rotation matrix [c -s; s c] is CW in screen
          // coords (+Y down).
          const angle = twirlSign * f * rate01 * 0.4; // rad per-frame
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const fwdDx = dx * cos - dy * sin;
          const fwdDy = dx * sin + dy * cos;
          dispMap[idx2] += fwdDx - dx;
          dispMap[idx2 + 1] += fwdDy - dy;
        } else if (radialSign !== 0 && dist > 0.0001) {
          // Radial: pinch pulls toward center, bloat pushes outward.
          const k = radialSign * f * rate01 * 0.15; // fraction of vector per-frame
          dispMap[idx2] += -dx * k;
          dispMap[idx2 + 1] += -dy * k;
        }

        // Resample from the snapshot using the accumulated displacement.
        const sx = lx - dispMap[idx2];
        const sy = ly - dispMap[idx2 + 1];
        sampleSource(src, sx, sy, sample);
        writeDest(dst, strokeFormat, strokeW, lx, ly, sample);
      }
    }

    // Mark the brush footprint dirty.
    ctx.renderer.markDirtyRect(layer, minLx, minLy, maxLx + 1, maxLy + 1);
  }

  return {
    onPointerDown(pos: ToolPointerPos, ctx: ToolContext): void {
      const layer = ctx.layer;
      strokeW = layer.layerWidth;
      strokeH = layer.layerHeight;
      strokeFormat = layer.format;
      // Snapshot: copy the pre-stroke pixels so warping is always against an
      // unchanging source.
      snapshot =
        layer.format === "rgba32f"
          ? new Float32Array(layer.data as Float32Array)
          : new Uint8Array(layer.data as Uint8Array);
      dispMap = new Float32Array(2 * strokeW * strokeH);
      prevX = pos.x;
      prevY = pos.y;
      isDown = true;
      // First tap: still apply with zero motion so twirl/pinch/bloat react.
      applyAt(ctx, pos.x, pos.y, 0, 0, pos.pressure);
      ctx.renderer.flushLayer(ctx.layer);
      ctx.render();
    },
    onPointerMove(pos: ToolPointerPos, ctx: ToolContext): void {
      if (!isDown) return;
      const dx = pos.x - prevX;
      const dy = pos.y - prevY;
      applyAt(ctx, pos.x, pos.y, dx, dy, pos.pressure);
      prevX = pos.x;
      prevY = pos.y;
      ctx.renderer.flushLayer(ctx.layer);
      ctx.render();
    },
    onPointerUp(_pos: ToolPointerPos, _ctx: ToolContext): void {
      isDown = false;
      snapshot = null;
      dispMap = null;
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

const MODE_LABELS: Record<LiquifyMode, string> = {
  push: "Push",
  "twirl-cw": "Twirl CW",
  "twirl-ccw": "Twirl CCW",
  pinch: "Pinch",
  bloat: "Bloat",
};

function LiquifyOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [size, setSize] = useState(liquifyOptions.size);
  const [strength, setStrength] = useState(liquifyOptions.strength);
  const [hardness, setHardness] = useState(liquifyOptions.hardness);
  const [mode, setMode] = useState<LiquifyMode>(liquifyOptions.mode);
  const [rate, setRate] = useState(liquifyOptions.rate);
  const [pressureSize, setPressureSize] = useState(liquifyOptions.pressureSize);
  const [pressureStrength, setPressureStrength] = useState(
    liquifyOptions.pressureStrength,
  );

  const setSizeOpt = (v: number): void => {
    liquifyOptions.size = v;
    setSize(v);
  };
  const setStrengthOpt = (v: number): void => {
    liquifyOptions.strength = v;
    setStrength(v);
  };
  const setHardnessOpt = (v: number): void => {
    liquifyOptions.hardness = v;
    setHardness(v);
  };
  const setModeOpt = (v: LiquifyMode): void => {
    liquifyOptions.mode = v;
    setMode(v);
  };
  const setRateOpt = (v: number): void => {
    liquifyOptions.rate = v;
    setRate(v);
  };
  const setPressureSizeOpt = (v: boolean): void => {
    liquifyOptions.pressureSize = v;
    setPressureSize(v);
  };
  const setPressureStrengthOpt = (v: boolean): void => {
    liquifyOptions.pressureStrength = v;
    setPressureStrength(v);
  };

  const isAngular = mode === "twirl-cw" || mode === "twirl-ccw";
  const isRadial = mode === "pinch" || mode === "bloat";

  return (
    <>
      <label className={styles.optLabel}>Mode:</label>
      <select
        className={styles.optSelect}
        value={mode}
        onChange={(e) => setModeOpt(e.target.value as LiquifyMode)}
      >
        {(Object.keys(MODE_LABELS) as LiquifyMode[]).map((k) => (
          <option key={k} value={k}>
            {MODE_LABELS[k]}
          </option>
        ))}
      </select>
      <span className={styles.optSep} />
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
      {(isAngular || isRadial) && (
        <>
          <span className={styles.optSep} />
          <label className={styles.optLabel}>Rate:</label>
          <SliderInput
            value={rate}
            min={1}
            max={100}
            suffix="%"
            inputWidth={42}
            onChange={setRateOpt}
          />
        </>
      )}
      <span className={styles.optSep} />
      <label
        className={styles.optCheckLabel}
        title="Pen pressure modulates effective brush size."
      >
        <input
          type="checkbox"
          checked={pressureSize}
          onChange={(e) => setPressureSizeOpt(e.target.checked)}
        />
        Pressure → size
      </label>
      <span className={styles.optSep} />
      <label
        className={styles.optCheckLabel}
        title="Pen pressure modulates effective strength."
      >
        <input
          type="checkbox"
          checked={pressureStrength}
          onChange={(e) => setPressureStrengthOpt(e.target.checked)}
        />
        Pressure → strength
      </label>
    </>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

class LiquifyTool implements ITool {
  readonly id = "liquify";
  readonly label = "Liquify";
  readonly shortcut = "Q";
  readonly icon = <SvgIcon src={liquifyIconSvg} />;
  readonly placement = {
    group: ToolGroup.Distortion,
    row: 0,
    column: 0,
  } as const;
  readonly modifiesPixels = true;
  readonly pixelOnly = true;
  readonly indexed8Unsupported = true;
  createHandler(): ToolHandler {
    return createLiquifyHandler();
  }
  readonly Options = LiquifyOptions;
}

export const liquifyTool: ITool = new LiquifyTool();
