import React, { useEffect, useState } from "react";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import { selectionStore } from "../../core/store/selectionStore";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import {
  forEachStamp,
  markBrushDirty,
} from "../_shared/localBrush";

// ─── Module-level options ─────────────────────────────────────────────────────

export const healingBrushOptions = {
  size: 50,
  /** 0..100 — radius of the fully-strong inner core, % of brush radius. */
  hardness: 80,
  /** 0..100 — per-stamp blend amount onto the destination. 100 = full
   *  replacement at the brush centre. */
  strength: 100,
  /** When ON, the source-to-destination offset is locked to the alt-click
   *  anchor across the whole stroke and across subsequent strokes. When OFF,
   *  each new pointer-down resets the offset (every new stroke samples
   *  starting fresh from the alt-click anchor). Mirrors PS "Aligned". */
  aligned: true,
  /** 0..7 — softens the patched boundary by feathering the brush mask.
   *  Higher = smoother blend (mirrors PS Diffusion). */
  diffusion: 3,
  /** Pen pressure modulates effective strength. */
  pressureStrength: true,
};

// ─── Module-level source state (alt-click anchor) ─────────────────────────────

interface HealingSource {
  /** Anchor in canvas-space pixels. Set by alt-click. */
  x: number;
  y: number;
  /** ID of the layer the alt-click landed on (used to read source pixels). */
  layerId: string;
}

interface HealingState {
  source: HealingSource | null;
  /** Source-to-destination offset locked at the start of an aligned stroke.
   *  Cleared when Aligned is OFF or when the source is re-set. */
  alignedOffset: { dx: number; dy: number } | null;
  listeners: Set<() => void>;
}

const healingState: HealingState = {
  source: null,
  alignedOffset: null,
  listeners: new Set(),
};

function notifyHealing(): void {
  for (const fn of healingState.listeners) fn();
}

function setHealingSource(x: number, y: number, layerId: string): void {
  healingState.source = { x, y, layerId };
  healingState.alignedOffset = null;
  notifyHealing();
}

// ─── Tone-match + heal stamp ──────────────────────────────────────────────────

interface SourceBuffer {
  data: Uint8Array | Float32Array;
  W: number;
  H: number;
  offsetX: number;
  offsetY: number;
  format: "rgba8" | "rgba32f" | "indexed8";
}

/**
 * Walk a circular footprint at canvas-space (dCx, dCy) on the destination
 * layer with corresponding source-canvas-space (sCx, sCy). Per-pixel weight
 * is brush falloff × strength × diffusion-smoothed alpha. Tone-matches the
 * source footprint to the destination footprint by shifting source pixels by
 * `dest_avg − source_avg` so seams disappear.
 */
function healingStamp(
  ctx: ToolContext,
  src: SourceBuffer,
  dCx: number,
  dCy: number,
  sCx: number,
  sCy: number,
  pressure: number,
): void {
  const layer = ctx.layer;
  const W = layer.layerWidth;
  const H = layer.layerHeight;
  if (layer.format === "indexed8") return;

  const opts = healingBrushOptions;
  const strength01 =
    (opts.pressureStrength ? opts.strength * Math.max(0.05, pressure) : opts.strength) / 100;
  const hardness01 = Math.max(0, Math.min(1, opts.hardness / 100));
  const radius = Math.max(1, opts.size / 2);
  const isFloat = layer.format === "rgba32f";

  // Layer-local destination centre.
  const dCxL = dCx - layer.offsetX;
  const dCyL = dCy - layer.offsetY;
  // Source bounds in the source layer's local space.
  const sCxL = sCx - src.offsetX;
  const sCyL = sCy - src.offsetY;

  const minLx = Math.max(0, Math.floor(dCxL - radius));
  const maxLx = Math.min(W - 1, Math.ceil(dCxL + radius));
  const minLy = Math.max(0, Math.floor(dCyL - radius));
  const maxLy = Math.min(H - 1, Math.ceil(dCyL + radius));
  if (minLx > maxLx || minLy > maxLy) return;
  const bw = maxLx - minLx + 1;
  const bh = maxLy - minLy + 1;

  // Build the brush-alpha mask for this stamp into a small bw×bh buffer, then
  // optionally feather (diffusion). Each pixel's blend weight is alpha × strength.
  const r2 = radius * radius;
  const alpha = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    const ly = minLy + y;
    const dy = ly - dCyL;
    for (let x = 0; x < bw; x++) {
      const lx = minLx + x;
      const dx = lx - dCxL;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const t = Math.sqrt(d2) / radius;
      let f: number;
      if (t >= 1) f = 0;
      else if (t <= hardness01) f = 1;
      else {
        const u = (t - hardness01) / Math.max(1e-6, 1 - hardness01);
        f = 0.5 + 0.5 * Math.cos(Math.PI * u);
      }
      alpha[y * bw + x] = Math.round(f * 255);
    }
  }
  // Diffusion: small box-blur of the alpha mask.
  const passes = Math.max(0, Math.min(7, opts.diffusion | 0));
  if (passes > 0) {
    let a = alpha;
    let b = new Uint8Array(bw * bh);
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const x0 = Math.max(0, x - 1);
          const x1 = Math.min(bw - 1, x + 1);
          const y0 = Math.max(0, y - 1);
          const y1 = Math.min(bh - 1, y + 1);
          let s = 0,
            n = 0;
          for (let yy = y0; yy <= y1; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
              s += a[yy * bw + xx];
              n++;
            }
          }
          b[y * bw + x] = (s / n) | 0;
        }
      }
      const tmp = a;
      a = b;
      b = tmp;
    }
    if (a !== alpha) alpha.set(a);
  }

  // Sample the source pixel for a destination layer-local (lx, ly).
  // Returns null if the corresponding source coord is out of bounds.
  const sampleSource = (
    lx: number,
    ly: number,
    out: Float64Array,
  ): boolean => {
    // Convert dest-layer-local → canvas → source-layer-local.
    const cX = lx + layer.offsetX;
    const cY = ly + layer.offsetY;
    const dx = cX - dCx;
    const dy = cY - dCy;
    const sxL = Math.round(sCxL + dx);
    const syL = Math.round(sCyL + dy);
    if (sxL < 0 || syL < 0 || sxL >= src.W || syL >= src.H) return false;
    const i = (syL * src.W + sxL) * 4;
    out[0] = src.data[i];
    out[1] = src.data[i + 1];
    out[2] = src.data[i + 2];
    out[3] = src.data[i + 3];
    return true;
  };

  // ── First pass: compute tone shift = dest_avg − source_avg (alpha-weighted)
  const data = layer.data as Uint8Array & Float32Array;
  let dSumR = 0,
    dSumG = 0,
    dSumB = 0,
    sSumR = 0,
    sSumG = 0,
    sSumB = 0;
  let weightSum = 0;
  const tmp = new Float64Array(4);
  for (let y = 0; y < bh; y++) {
    const ly = minLy + y;
    for (let x = 0; x < bw; x++) {
      const lx = minLx + x;
      const a = alpha[y * bw + x];
      if (a === 0) continue;
      if (!sampleSource(lx, ly, tmp)) continue;
      const di = (ly * W + lx) * 4;
      const w = a / 255;
      dSumR += data[di] * w;
      dSumG += data[di + 1] * w;
      dSumB += data[di + 2] * w;
      sSumR += tmp[0] * w;
      sSumG += tmp[1] * w;
      sSumB += tmp[2] * w;
      weightSum += w;
    }
  }
  if (weightSum < 1e-6) return;
  const tShiftR = (dSumR - sSumR) / weightSum;
  const tShiftG = (dSumG - sSumG) / weightSum;
  const tShiftB = (dSumB - sSumB) / weightSum;

  // ── Second pass: write tone-shifted source pixels with brush blend.
  const max = isFloat ? 1 : 255;
  for (let y = 0; y < bh; y++) {
    const ly = minLy + y;
    for (let x = 0; x < bw; x++) {
      const lx = minLx + x;
      const a = alpha[y * bw + x];
      if (a === 0) continue;
      if (!sampleSource(lx, ly, tmp)) continue;
      const w = (a / 255) * strength01;
      if (w <= 0) continue;
      const di = (ly * W + lx) * 4;
      const inv = 1 - w;
      const sR = tmp[0] + tShiftR;
      const sG = tmp[1] + tShiftG;
      const sB = tmp[2] + tShiftB;
      // Healing carries the destination's alpha — we're not adding new
      // transparency, just retexturing existing pixels.
      if (isFloat) {
        const arr = data as Float32Array;
        arr[di] = Math.max(0, Math.min(max, arr[di] * inv + sR * w));
        arr[di + 1] = Math.max(0, Math.min(max, arr[di + 1] * inv + sG * w));
        arr[di + 2] = Math.max(0, Math.min(max, arr[di + 2] * inv + sB * w));
      } else {
        const arr = data as Uint8Array;
        arr[di] = Math.max(0, Math.min(max, Math.round(arr[di] * inv + sR * w)));
        arr[di + 1] = Math.max(
          0,
          Math.min(max, Math.round(arr[di + 1] * inv + sG * w)),
        );
        arr[di + 2] = Math.max(
          0,
          Math.min(max, Math.round(arr[di + 2] * inv + sB * w)),
        );
      }
    }
  }

  markBrushDirty(layer, dCxL, dCyL, radius);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function createHealingBrushHandler(): ToolHandler {
  let prevX = 0;
  let prevY = 0;
  let isDown = false;
  // Source/destination offset locked for the duration of this stroke.
  let strokeOffsetDX = 0;
  let strokeOffsetDY = 0;
  // Cached source pixels at stroke-start (so we sample from a stable snapshot
  // even as the destination is being modified).
  let sourceBuffer: SourceBuffer | null = null;

  // Alt+drag — draw a freehand source-region selection. On release, the
  // selection's centroid becomes the source anchor (matching the alt-click
  // behaviour). The path is rendered as a live blue dashed outline through
  // selectionStore.pending, just like the lasso/marquee tools.
  let drawingSourceSelection = false;
  let sourcePathPoints: { x: number; y: number }[] = [];
  let sourcePathHitLayerId = "";

  return {
    onPointerDown(
      { x, y, altKey, pressure }: ToolPointerPos,
      ctx: ToolContext,
    ): void {
      if (ctx.layer.format === "indexed8") return;

      // Alt-down → either set source anchor (point) or start drawing a
      // freehand source-region selection (alt + drag). We assume drag at
      // first; a no-drag release will fall back to single-point behaviour.
      if (altKey) {
        const { layers } = ctx;
        let hitLayerId = ctx.layer.id;
        for (let i = layers.length - 1; i >= 0; i--) {
          const l = layers[i];
          if (!l.visible) continue;
          const lx = Math.round(x) - l.offsetX;
          const ly = Math.round(y) - l.offsetY;
          if (lx >= 0 && ly >= 0 && lx < l.layerWidth && ly < l.layerHeight) {
            const idx = (ly * l.layerWidth + lx) * 4;
            const alpha = l.data[idx + 3];
            // For rgba32f the threshold is 1/255 of full; for rgba8 just > 0.
            if (alpha > (l.format === "rgba32f" ? 1 / 255 : 0)) {
              hitLayerId = l.id;
              break;
            }
          }
        }
        drawingSourceSelection = true;
        sourcePathPoints = [{ x, y }];
        sourcePathHitLayerId = hitLayerId;
        // Show the live path immediately (a single point doesn't draw, but
        // setting pending lets the marching-ants overlay take over once the
        // user moves the pointer).
        selectionStore.setPending({
          type: "path",
          points: [...sourcePathPoints],
        });
        ctx.setCursor("crosshair");
        return;
      }

      if (!healingState.source) return;

      isDown = true;
      prevX = x;
      prevY = y;

      // Compute source-to-destination offset for this stroke.
      const src = healingState.source;
      if (healingBrushOptions.aligned) {
        if (!healingState.alignedOffset) {
          healingState.alignedOffset = { dx: src.x - x, dy: src.y - y };
        }
        strokeOffsetDX = healingState.alignedOffset.dx;
        strokeOffsetDY = healingState.alignedOffset.dy;
      } else {
        strokeOffsetDX = src.x - x;
        strokeOffsetDY = src.y - y;
      }

      // Snapshot the source layer's pixels so we sample from a stable buffer
      // rather than from a destination we may already be modifying.
      const sourceLayer = ctx.layers.find((l) => l.id === src.layerId);
      if (!sourceLayer || sourceLayer.format === "indexed8") {
        isDown = false;
        return;
      }
      const buf = ctx.renderer.readLayerPixels(sourceLayer);
      sourceBuffer = {
        data: buf as Uint8Array | Float32Array,
        W: sourceLayer.layerWidth,
        H: sourceLayer.layerHeight,
        offsetX: sourceLayer.offsetX,
        offsetY: sourceLayer.offsetY,
        format: sourceLayer.format,
      };

      // First stamp.
      healingStamp(
        ctx,
        sourceBuffer,
        x,
        y,
        x + strokeOffsetDX,
        y + strokeOffsetDY,
        pressure,
      );
      ctx.renderer.flushLayer(ctx.layer);
      ctx.render();
    },

    onPointerMove(
      { x, y, pressure }: ToolPointerPos,
      ctx: ToolContext,
    ): void {
      // Extend the source-selection path during alt-drag.
      if (drawingSourceSelection) {
        const last = sourcePathPoints[sourcePathPoints.length - 1];
        if (Math.abs(x - last.x) < 2 && Math.abs(y - last.y) < 2) return;
        sourcePathPoints.push({ x, y });
        selectionStore.setPending({
          type: "path",
          points: [...sourcePathPoints],
        });
        return;
      }

      if (!isDown || !sourceBuffer) return;
      const radius = Math.max(1, healingBrushOptions.size / 2);
      forEachStamp(prevX, prevY, x, y, radius * 0.25, (cx, cy) => {
        if (!sourceBuffer) return;
        healingStamp(
          ctx,
          sourceBuffer,
          cx,
          cy,
          cx + strokeOffsetDX,
          cy + strokeOffsetDY,
          pressure,
        );
      });
      prevX = x;
      prevY = y;
      ctx.renderer.flushLayer(ctx.layer);
      ctx.render();
    },

    onPointerUp(
      { x, y }: ToolPointerPos,
      _ctx: ToolContext,
    ): void {
      // Committing an alt-drag source selection: pick the centroid of the
      // drawn path as the source anchor. A single-point alt-tap (no drag)
      // also commits to a point source at the click location.
      if (drawingSourceSelection) {
        sourcePathPoints.push({ x, y });
        if (sourcePathPoints.length === 1) {
          // Plain alt-click — point source at this location.
          setHealingSource(x, y, sourcePathHitLayerId);
        } else {
          // Centroid of the drawn polygon.
          let sx = 0,
            sy = 0;
          for (const p of sourcePathPoints) {
            sx += p.x;
            sy += p.y;
          }
          sx /= sourcePathPoints.length;
          sy /= sourcePathPoints.length;
          setHealingSource(sx, sy, sourcePathHitLayerId);
        }
        selectionStore.setPending(null);
        drawingSourceSelection = false;
        sourcePathPoints = [];
        return;
      }

      isDown = false;
      sourceBuffer = null;
      // Aligned: keep alignedOffset so the next stroke continues in lock-step
      // with the original anchor. Non-aligned: clear it for explicitness.
      if (!healingBrushOptions.aligned) {
        healingState.alignedOffset = null;
      }
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function HealingBrushOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [size, setSize] = useState(healingBrushOptions.size);
  const [strength, setStrength] = useState(healingBrushOptions.strength);
  const [hardness, setHardness] = useState(healingBrushOptions.hardness);
  const [aligned, setAligned] = useState(healingBrushOptions.aligned);
  const [diffusion, setDiffusion] = useState(healingBrushOptions.diffusion);
  const [pressureStrength, setPressureStrength] = useState(
    healingBrushOptions.pressureStrength,
  );
  const [hasSource, setHasSource] = useState(healingState.source !== null);

  useEffect(() => {
    const update = (): void => setHasSource(healingState.source !== null);
    healingState.listeners.add(update);
    return () => {
      healingState.listeners.delete(update);
    };
  }, []);

  return (
    <>
      <label className={styles.optLabel}>Size:</label>
      <SliderInput
        value={size}
        min={1}
        max={500}
        inputWidth={48}
        onChange={(v) => {
          healingBrushOptions.size = v;
          setSize(v);
        }}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Hardness:</label>
      <SliderInput
        value={hardness}
        min={0}
        max={100}
        suffix="%"
        inputWidth={42}
        onChange={(v) => {
          healingBrushOptions.hardness = v;
          setHardness(v);
        }}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Strength:</label>
      <SliderInput
        value={strength}
        min={0}
        max={100}
        suffix="%"
        inputWidth={42}
        onChange={(v) => {
          healingBrushOptions.strength = v;
          setStrength(v);
        }}
      />
      <span className={styles.optSep} />
      <label
        className={styles.optLabel}
        title="Soften the boundary of each stamp so it blends into the destination."
      >
        Diffusion:
      </label>
      <SliderInput
        value={diffusion}
        min={0}
        max={7}
        inputWidth={32}
        onChange={(v) => {
          healingBrushOptions.diffusion = v;
          setDiffusion(v);
        }}
      />
      <span className={styles.optSep} />
      <label
        className={styles.optCheckLabel}
        title="When ON, the source–destination offset is locked across the whole stroke and across subsequent strokes. When OFF, each new stroke samples back from the alt-click anchor."
      >
        <input
          type="checkbox"
          checked={aligned}
          onChange={(e) => {
            healingBrushOptions.aligned = e.target.checked;
            if (!e.target.checked) healingState.alignedOffset = null;
            setAligned(e.target.checked);
          }}
        />
        Aligned
      </label>
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={pressureStrength}
          onChange={(e) => {
            healingBrushOptions.pressureStrength = e.target.checked;
            setPressureStrength(e.target.checked);
          }}
        />
        Pressure → strength
      </label>
      <span className={styles.optSep} />
      <span className={styles.optText}>
        {hasSource
          ? `Source: (${healingState.source!.x | 0}, ${
              healingState.source!.y | 0
            })`
          : "No source — Alt+click to set"}
      </span>
    </>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

class HealingBrushTool implements ITool {
  readonly id = "healing-brush";
  readonly label = "Healing Brush";
  readonly shortcut = "J";
  readonly icon = (
    <span style={{ display: "block", width: "100%", height: "100%" }}>
      <svg
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "100%" }}
      >
        <g transform="rotate(-45 8 8)">
          <rect
            x="2.2"
            y="6.2"
            width="11.6"
            height="3.6"
            rx="1.2"
            ry="1.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <rect
            x="6"
            y="6.6"
            width="4"
            height="2.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="0.8"
            opacity="0.6"
          />
          <circle cx="3.6" cy="7.4" r="0.4" fill="currentColor" />
          <circle cx="3.6" cy="8.6" r="0.4" fill="currentColor" />
          <circle cx="12.4" cy="7.4" r="0.4" fill="currentColor" />
          <circle cx="12.4" cy="8.6" r="0.4" fill="currentColor" />
        </g>
      </svg>
    </span>
  );
  readonly placement = {
    group: ToolGroup.Retouching,
    row: 0,
    column: 1,
  } as const;
  readonly modifiesPixels = true;
  readonly pixelOnly = true;
  readonly indexed8Unsupported = true;
  createHandler(): ToolHandler {
    return createHealingBrushHandler();
  }
  readonly Options = HealingBrushOptions;
}

export const healingBrushTool: ITool = new HealingBrushTool();
