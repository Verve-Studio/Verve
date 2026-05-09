import React, { useState } from "react";
import { selectionStore } from "@/core/store/selectionStore";
import type { SelectionMode } from "@/core/store/selectionStore";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import { expandIndicesToRgba } from "@/utils/indexedColorUtils";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import quickSelectIconSvg from "./quick-select.svg?raw";
import {
  forEachStamp,
  markBrushDirty as _markBrushDirty,
} from "../_shared/localBrush";
void _markBrushDirty;

// ─── Module-level options ─────────────────────────────────────────────────────

export type QuickSelectMode = "new" | "add" | "subtract";

export const quickSelectOptions = {
  /** Brush diameter in canvas pixels. Each stamp grows the selection inside
   *  this radius. */
  size: 50,
  /** 0..255 — colour tolerance against the seed. Higher = grabs more pixels
   *  per stamp. Mirrors PS Quick Select's "looser" feel. */
  tolerance: 32,
  /** Default mode — toolbar buttons toggle this. Holding Shift adds, Alt
   *  subtracts (one-shot overrides). */
  mode: "add" as QuickSelectMode,
  /** Slight Gaussian feather applied to the per-stamp footprint mask before
   *  merging — softens the selection edge so it doesn't look pixelated.
   *  Mirrors PS "Auto-Enhance" (lite). */
  autoEnhance: true,
  /** Sample colours from all visible layers flattened. */
  sampleAllLayers: false,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Map the 0..255 tolerance setting to a small per-channel-average tolerance
 *  used for flood-fill comparisons. The flood-fill compares the avg of |Δr|
 *  per channel against this threshold (matches selectionStore.floodFillSelect). */
function effectiveTolerance(tol: number): number {
  return Math.max(0, Math.min(255, tol));
}

/**
 * Build a canvas-sized RGBA buffer containing only the active layer's pixels
 * (positioned at its offset) — the same trick magicWand uses. Quick Select
 * indexes by canvas-space coords, so the buffer must be canvas-sized.
 */
function buildCanvasAlignedPixels(ctx: ToolContext): Uint8Array | null {
  const { width: cw, height: ch } = selectionStore;
  if (cw === 0 || ch === 0) return null;
  const out = new Uint8Array(cw * ch * 4);
  const layer = ctx.layer;
  const lw = layer.layerWidth;
  const lh = layer.layerHeight;
  const ox = layer.offsetX;
  const oy = layer.offsetY;
  let src: Uint8Array;
  if (layer.format === "indexed8") {
    src = expandIndicesToRgba(layer.data as Uint8Array, ctx.swatches);
  } else if (layer.format === "rgba32f") {
    // Convert float [0..1] to byte [0..255] for tolerance comparison.
    const f = layer.data as Float32Array;
    src = new Uint8Array(f.length);
    for (let i = 0; i < f.length; i++) {
      src[i] = Math.max(0, Math.min(255, Math.round(f[i] * 255)));
    }
  } else {
    src = layer.data as Uint8Array;
  }
  for (let ly = 0; ly < lh; ly++) {
    const cy = oy + ly;
    if (cy < 0 || cy >= ch) continue;
    for (let lx = 0; lx < lw; lx++) {
      const cx = ox + lx;
      if (cx < 0 || cx >= cw) continue;
      const si = (ly * lw + lx) * 4;
      const di = (cy * cw + cx) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}

/**
 * BFS flood-fill from a seed pixel (sx, sy) through pixels in `src` whose
 * per-channel-avg colour distance from the seed is ≤ `tolerance`. Output is a
 * canvas-sized Uint8Array with 255 for selected pixels (or a soft falloff at
 * the tolerance boundary when `autoEnhance` is true).
 *
 * This is the heart of Quick Select's "auto-expand along similar pixels"
 * behaviour — the brush radius is irrelevant once a seed is dropped; the
 * selection grows freely through connected matching pixels until it hits a
 * tolerance edge.
 *
 * Visited pixels are tracked in a `seen` buffer reused across stamps within a
 * stroke so subsequent stamps don't re-walk regions already explored. That
 * keeps a long stroke roughly linear-time in pixels rather than per-stamp
 * quadratic.
 */
function floodFillFromSeed(
  src: Uint8Array,
  cw: number,
  ch: number,
  sx: number,
  sy: number,
  seed: [number, number, number, number],
  tolerance: number,
  autoEnhance: boolean,
  seen: Uint8Array,
  out: Uint8Array,
): void {
  if (sx < 0 || sx >= cw || sy < 0 || sy >= ch) return;
  const [sR, sG, sB, sA] = seed;
  const stack: number[] = [];
  const startIdx = sy * cw + sx;
  if (seen[startIdx]) return;

  // Seed must itself be within tolerance of itself (always true) — start.
  const colorDelta = (i: number): number => {
    const j = i * 4;
    return (
      (Math.abs(src[j] - sR) +
        Math.abs(src[j + 1] - sG) +
        Math.abs(src[j + 2] - sB) +
        Math.abs(src[j + 3] - sA)) /
      4
    );
  };

  const AA_ZONE = 24;
  stack.push(startIdx);
  seen[startIdx] = 1;
  while (stack.length > 0) {
    const idx = stack.pop()!;
    const d = colorDelta(idx);
    let strength: number;
    if (autoEnhance) {
      if (d > tolerance + AA_ZONE) continue;
      if (d > tolerance) {
        strength = Math.round((1 - (d - tolerance) / AA_ZONE) * 255);
      } else {
        strength = 255;
      }
    } else {
      if (d > tolerance) continue;
      strength = 255;
    }
    if (strength > out[idx]) out[idx] = strength;
    if (d > tolerance) continue; // don't expand into the AA halo

    // Expand to 4-connected neighbours.
    const x = idx % cw;
    const y = (idx - x) / cw;
    if (x > 0) {
      const n = idx - 1;
      if (!seen[n]) {
        seen[n] = 1;
        stack.push(n);
      }
    }
    if (x < cw - 1) {
      const n = idx + 1;
      if (!seen[n]) {
        seen[n] = 1;
        stack.push(n);
      }
    }
    if (y > 0) {
      const n = idx - cw;
      if (!seen[n]) {
        seen[n] = 1;
        stack.push(n);
      }
    }
    if (y < ch - 1) {
      const n = idx + cw;
      if (!seen[n]) {
        seen[n] = 1;
        stack.push(n);
      }
    }
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function createQuickSelectHandler(): ToolHandler {
  // Snapshot per stroke so the seed colour and underlying pixels stay stable
  // even as other tools or rendering effects run.
  let pixels: Uint8Array | null = null;
  let cw = 0;
  let ch = 0;
  let prevX = 0;
  let prevY = 0;
  let strokeMode: SelectionMode = "set";
  let isDown = false;
  // Cumulative mask + per-stroke "seen" bookkeeping. Stamps within the same
  // stroke flood-fill into the same target buffer, skipping pixels another
  // stamp already explored; this keeps long strokes roughly linear-time.
  let strokeMask: Uint8Array | null = null;
  let strokeSeen: Uint8Array | null = null;

  function stamp(cx: number, cy: number): void {
    if (!pixels || !strokeMask || !strokeSeen) return;
    // Per-stamp seed: read the colour at the brush centre and flood-fill from
    // there. Each stamp picks up wherever the user is brushing, so dragging
    // across colour boundaries grows the selection through each region.
    const sx = Math.max(0, Math.min(cw - 1, Math.round(cx)));
    const sy = Math.max(0, Math.min(ch - 1, Math.round(cy)));
    const i = (sy * cw + sx) * 4;
    const seed: [number, number, number, number] = [
      pixels[i],
      pixels[i + 1],
      pixels[i + 2],
      pixels[i + 3],
    ];
    floodFillFromSeed(
      pixels,
      cw,
      ch,
      sx,
      sy,
      seed,
      effectiveTolerance(quickSelectOptions.tolerance),
      quickSelectOptions.autoEnhance,
      strokeSeen,
      strokeMask,
    );
    // Push the in-progress mask into the live selection so the user sees the
    // marching ants update every stamp. mergeMask copies the mask, so we can
    // keep mutating `strokeMask` afterwards.
    selectionStore.mergeMask(new Uint8Array(strokeMask), strokeMode);
  }

  return {
    onPointerDown(
      { x, y, shiftKey, altKey }: ToolPointerPos,
      ctx: ToolContext,
    ): void {
      pixels = buildCanvasAlignedPixels(ctx);
      if (!pixels) return;
      cw = selectionStore.width;
      ch = selectionStore.height;
      strokeMask = new Uint8Array(cw * ch);
      strokeSeen = new Uint8Array(cw * ch);

      // Decide the stroke mode: modifier keys override the option-bar default
      // (matches PS — Shift = add, Alt = subtract, otherwise the option-bar
      // mode wins; "new" replaces the existing selection on the first stamp).
      if (altKey) strokeMode = "subtract";
      else if (shiftKey) strokeMode = "add";
      else
        strokeMode =
          quickSelectOptions.mode === "subtract"
            ? "subtract"
            : quickSelectOptions.mode === "new"
              ? "set"
              : "add";

      isDown = true;
      prevX = x;
      prevY = y;
      stamp(x, y);
      // After the first "new" stamp the rest of the stroke should add to the
      // freshly-set selection, not keep replacing it.
      if (strokeMode === "set") strokeMode = "add";
    },

    onPointerMove({ x, y }: ToolPointerPos, _ctx: ToolContext): void {
      if (!isDown) return;
      const radius = Math.max(1, quickSelectOptions.size / 2);
      forEachStamp(prevX, prevY, x, y, radius * 0.5, (cx, cy) => stamp(cx, cy));
      prevX = x;
      prevY = y;
    },

    onPointerUp(_pos: ToolPointerPos, _ctx: ToolContext): void {
      isDown = false;
      pixels = null;
      strokeMask = null;
      strokeSeen = null;
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function QuickSelectOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [size, setSize] = useState(quickSelectOptions.size);
  const [tolerance, setTolerance] = useState(quickSelectOptions.tolerance);
  const [mode, setMode] = useState<QuickSelectMode>(quickSelectOptions.mode);
  const [autoEnhance, setAutoEnhance] = useState(
    quickSelectOptions.autoEnhance,
  );

  const setModeOpt = (m: QuickSelectMode): void => {
    quickSelectOptions.mode = m;
    setMode(m);
  };
  const ModeBtn = ({ id, label }: { id: QuickSelectMode; label: string }): React.JSX.Element => (
    <button
      className={`${styles.optModeBtn}${mode === id ? ` ${styles.optModeBtnActive}` : ""}`}
      onClick={() => setModeOpt(id)}
      title={label}
      style={{ width: "auto", padding: "0 6px", fontSize: 11 }}
    >
      {label}
    </button>
  );

  return (
    <>
      <ModeBtn id="new" label="New" />
      <ModeBtn id="add" label="+" />
      <ModeBtn id="subtract" label="−" />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Size:</label>
      <SliderInput
        value={size}
        min={1}
        max={500}
        inputWidth={48}
        onChange={(v) => {
          quickSelectOptions.size = v;
          setSize(v);
        }}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Tolerance:</label>
      <SliderInput
        value={tolerance}
        min={0}
        max={255}
        inputWidth={42}
        onChange={(v) => {
          quickSelectOptions.tolerance = v;
          setTolerance(v);
        }}
      />
      <span className={styles.optSep} />
      <label
        className={styles.optCheckLabel}
        title="Soft-feathers the per-stamp boundary so the selection edge is smoother."
      >
        <input
          type="checkbox"
          checked={autoEnhance}
          onChange={(e) => {
            quickSelectOptions.autoEnhance = e.target.checked;
            setAutoEnhance(e.target.checked);
          }}
        />
        Auto-Enhance
      </label>
    </>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

class QuickSelectTool implements ITool {
  readonly id = "quick-select";
  readonly label = "Quick Selection";
  readonly shortcut = "W";
  readonly icon = <SvgIcon src={quickSelectIconSvg} />;
  readonly placement = {
    group: ToolGroup.Selection,
    row: 1,
    column: 1,
  } as const;
  createHandler(): ToolHandler {
    return createQuickSelectHandler();
  }
  readonly Options = QuickSelectOptions;
}

export const quickSelectTool: ITool = new QuickSelectTool();
