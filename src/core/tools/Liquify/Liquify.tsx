import React, { useState } from "react";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import liquifyIconSvg from "./liquify.svg?raw";
import {
  brushSelection,
  selectionWeight,
} from "../_shared/localBrush";

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

type LiquifyFormat = "rgba8" | "rgba32f" | "indexed8";

/** Side of the square tiles the per-stroke state is split into. */
const TILE = 64;

/**
 * Per-stroke liquify state, allocated lazily in 64×64 tiles.
 *
 * Every stamp resamples touched pixels from the pre-stroke image, using an
 * accumulated displacement field. This used to copy the whole layer and
 * allocate a full-size Float32 displacement map on every pointer-down
 * (~200 MB at 4K rgba32f; ~550 MB for the displacement map alone on an A1
 * rgba8 layer).
 *
 * Now a tile of the pre-stroke image is captured just before the brush
 * first writes into it. Tiles that were never written still hold their
 * original pixels in the live layer, so reads from them go to the layer —
 * the result is identical to sampling a full snapshot. Displacement tiles
 * exist only where the brush has been.
 */
class LiquifyStroke {
  readonly width: number;
  readonly height: number;
  readonly format: LiquifyFormat;
  private readonly channels: number;
  private readonly tilesX: number;
  private readonly snapTiles: (Uint8Array | Float32Array | null)[];
  private readonly dispTiles: (Float32Array | null)[];

  constructor(private readonly layer: GpuLayer) {
    this.width = layer.layerWidth;
    this.height = layer.layerHeight;
    this.format = layer.format;
    this.channels = layer.format === "indexed8" ? 1 : 4;
    this.tilesX = Math.ceil(this.width / TILE);
    const count = this.tilesX * Math.ceil(this.height / TILE);
    this.snapTiles = new Array(count).fill(null);
    this.dispTiles = new Array(count).fill(null);
  }

  /** Capture snapshot tiles (and create displacement tiles) covering the
   *  layer-local rect before it is written. Inclusive bounds. */
  prepare(minLx: number, minLy: number, maxLx: number, maxLy: number): void {
    const C = this.channels;
    const data = this.layer.data;
    for (let ty = minLy >> 6; ty <= maxLy >> 6; ty++) {
      for (let tx = minLx >> 6; tx <= maxLx >> 6; tx++) {
        const t = ty * this.tilesX + tx;
        if (!this.dispTiles[t]) this.dispTiles[t] = new Float32Array(TILE * TILE * 2);
        if (this.snapTiles[t]) continue;
        const tile =
          this.format === "rgba32f"
            ? new Float32Array(TILE * TILE * C)
            : new Uint8Array(TILE * TILE * C);
        const x0 = tx * TILE;
        const rowLen = Math.min(TILE, this.width - x0) * C;
        for (let y = 0; y < TILE; y++) {
          const ly = ty * TILE + y;
          if (ly >= this.height) break;
          const from = (ly * this.width + x0) * C;
          tile.set(data.subarray(from, from + rowLen), y * TILE * C);
        }
        this.snapTiles[t] = tile;
      }
    }
  }

  /** Displacement tile + offset for a prepared pixel. */
  dispAt(lx: number, ly: number): { tile: Float32Array; i: number } {
    const tile = this.dispTiles[(ly >> 6) * this.tilesX + (lx >> 6)]!;
    return { tile, i: (((ly & 63) << 6) + (lx & 63)) * 2 };
  }

  /** Pre-stroke value of channel `ch` at integer (x, y); 0 outside. */
  private src(x: number, y: number, ch: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    const tile = this.snapTiles[(y >> 6) * this.tilesX + (x >> 6)];
    if (tile) return tile[(((y & 63) << 6) + (x & 63)) * this.channels + ch];
    return this.layer.data[(y * this.width + x) * this.channels + ch];
  }

  /** Sample the pre-stroke image at sub-pixel (sx, sy). rgba8/rgba32f are
   *  bilinear; indexed8 is nearest-neighbour (palette indices can't be
   *  interpolated) with 255 (transparent) outside. */
  sample(sx: number, sy: number, out: Float64Array): void {
    if (this.format === "indexed8") {
      const ix = Math.round(sx);
      const iy = Math.round(sy);
      out[0] =
        ix < 0 || iy < 0 || ix >= this.width || iy >= this.height
          ? 255
          : this.src(ix, iy, 0);
      return;
    }
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const fx = sx - x0;
    const fy = sy - y0;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    for (let ch = 0; ch < 4; ch++) {
      out[ch] =
        this.src(x0, y0, ch) * w00 +
        this.src(x0 + 1, y0, ch) * w10 +
        this.src(x0, y0 + 1, ch) * w01 +
        this.src(x0 + 1, y0 + 1, ch) * w11;
    }
  }
}

function writeDest(
  dst: Uint8Array | Float32Array,
  format: LiquifyFormat,
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
  let stroke: LiquifyStroke | null = null;
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
  ): boolean {
    const layer = ctx.layer;
    if (!stroke) return false;
    const strokeW = stroke.width;
    const strokeH = stroke.height;
    const strokeFormat = stroke.format;
    if (layer.layerWidth !== strokeW || layer.layerHeight !== strokeH) return false;

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
    if (minLx > maxLx || minLy > maxLy) return false;

    stroke.prepare(minLx, minLy, maxLx, maxLy);
    const sample = new Float64Array(4);
    const selection = brushSelection(ctx);
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
        let f = falloff(t, hardness01) * strength01;
        if (selection) f *= selectionWeight(selection, lx, ly);
        if (f <= 0) continue;

        const { tile: dispMap, i: idx2 } = stroke.dispAt(lx, ly);

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
        stroke.sample(sx, sy, sample);
        writeDest(dst, strokeFormat, strokeW, lx, ly, sample);
      }
    }

    // Mark the brush footprint dirty.
    ctx.renderer.markDirtyRect(layer, minLx, minLy, maxLx + 1, maxLy + 1);
    return true;
  }

  return {
    onPointerDown(pos: ToolPointerPos, ctx: ToolContext): void {
      stroke = new LiquifyStroke(ctx.layer);
      ctx.renderer.strokeStart();
      prevX = pos.x;
      prevY = pos.y;
      isDown = true;
      // First tap: still apply with zero motion so twirl/pinch/bloat react.
      if (applyAt(ctx, pos.x, pos.y, 0, 0, pos.pressure)) {
        ctx.renderer.flushLayer(ctx.layer, ctx.swatches);
        ctx.render();
      }
    },
    onPointerMove(pos: ToolPointerPos, ctx: ToolContext): void {
      if (!isDown) return;
      const dx = pos.x - prevX;
      const dy = pos.y - prevY;
      const wrote = applyAt(ctx, pos.x, pos.y, dx, dy, pos.pressure);
      prevX = pos.x;
      prevY = pos.y;
      // Brush entirely outside the layer: nothing to upload. (Flushing with
      // no dirty rect would upload the whole layer on every move.)
      if (wrote) {
        ctx.renderer.flushLayer(ctx.layer, ctx.swatches);
        ctx.render();
      }
    },
    onPointerUp(_pos: ToolPointerPos, ctx: ToolContext): void {
      if (!isDown) return;
      isDown = false;
      stroke = null;
      ctx.renderer.strokeEnd();
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
