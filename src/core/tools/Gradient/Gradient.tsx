import React, { useState } from "react";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import { useAppContext } from "@/core/store/AppContext";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import gradientIconSvg from "./gradient.svg?raw";
import type { RGBAColor } from "@/types";
import { srgbToLinearChannel } from "@/utils/pixelFormatConvert";

// ─── Module-level options ─────────────────────────────────────────────────────

export const gradientOptions = {
  type: "linear" as "linear" | "radial",
  repeat: "none" as "none" | "repeat" | "reflect",
  opacity: 100,
  // ── Indexed8-only ──────────────────────────────────────────────────────────
  /** ID of the swatch group the gradient walks across. null = use first group
   *  with ≥ 2 indices at draw time. */
  paletteGroupId: null as string | null,
  /** "forward" = group[0] → group[N-1], "reverse" = group[N-1] → group[0]. */
  direction: "forward" as "forward" | "reverse",
  /** When true, ordered-dither between consecutive group colours instead of
   *  a hard stripe boundary. */
  dither: false,
  /** Width (in pixels along the drag axis) over which the dither
   *  transitions between two consecutive colours. */
  ditherRange: 8,
};

// 8×8 Bayer matrix for ordered dithering. Values 0–63, normalised on use.
const BAYER8: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

// ─── Colour interpolation ─────────────────────────────────────────────────────

function lerpColor(
  a: RGBAColor,
  b: RGBAColor,
  t: number,
): [number, number, number, number] {
  return [
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t,
    a.a + (b.a - a.a) * t,
  ];
}

function applyRepeat(t: number, repeat: typeof gradientOptions.repeat): number {
  if (repeat === "none") return Math.max(0, Math.min(1, t));
  const wrapped = ((t % 1) + 1) % 1;
  if (repeat === "repeat") return wrapped;
  // reflect: 0→1→0 pattern
  const cycle = ((t % 2) + 2) % 2;
  return cycle <= 1 ? cycle : 2 - cycle;
}

// ─── Indexed8 gradient rasteriser ─────────────────────────────────────────────

/**
 * Rasterise a gradient by walking the swatch group's palette indices across
 * the drag axis.  The indexed8 path never blends — each pixel snaps to one
 * palette slot (optionally ordered-dithered between adjacent slots).
 *
 * Implementation rules to avoid the symptoms we were chasing earlier:
 *  - Build a fresh full-canvas index buffer from scratch (no in-place mutation
 *    of `layer.data`, which can be racy when the renderer has just grown the
 *    layer or replaced its texture mid-conversion).
 *  - Composite into the existing layer pixels: pixels outside the active
 *    selection (or where this layer has no coverage) keep their previous
 *    indices instead of being silently zeroed.
 *  - Replace the layer's data + texture in one shot via `replaceLayerData`
 *    (which clears `dirtyRect` and forces a full upload), so no stale partial
 *    upload from a previous tool can mask the new gradient.
 */
function renderIndexedGradient(
  ctx: ToolContext,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const { renderer, layer, layers, selectionMask, render } = ctx;

  // ── 1. Resolve the swatch group ──────────────────────────────────────────
  const groups = ctx.swatchGroups;
  const palette = ctx.swatches;
  const selected =
    groups.find((g) => g.id === gradientOptions.paletteGroupId) ??
    groups.find((g) => g.swatchIndices.length >= 2);
  if (!selected) return;

  // Filter to indices that actually point to a colour in the current palette.
  // This guards against stale group entries that reference deleted swatches
  // (which would otherwise expand to (0,0,0,0) → invisible "transparent"
  // stripes) and against the 255 sentinel sneaking into the output.
  const validIndices = selected.swatchIndices.filter(
    (i) => Number.isInteger(i) && i >= 0 && i < palette.length && i !== 255,
  );
  if (validIndices.length < 2) return;

  const indices =
    gradientOptions.direction === "reverse"
      ? validIndices.slice().reverse()
      : validIndices;
  const N = indices.length;

  // ── 2. Drag-axis maths ────────────────────────────────────────────────────
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return;
  const dragLen = Math.sqrt(lenSq);

  const dither = gradientOptions.dither;
  const ditherRangePx = Math.max(1, Math.round(gradientOptions.ditherRange));
  const ditherStripeFrac = (ditherRangePx * N) / dragLen;
  const halfStripe = ditherStripeFrac / 2;

  // ── 3. Read the existing layer pixels into a canvas-sized buffer.  Pixels
  //    outside the layer's current rect default to 255 (transparent
  //    sentinel), matching the indexed8 convention. ─────────────────────────
  const cw = renderer.pixelWidth;
  const ch = renderer.pixelHeight;
  const out = new Uint8Array(cw * ch);
  out.fill(255);

  const oldData = layer.data;
  if (
    layer.format === "indexed8" &&
    oldData instanceof Uint8Array &&
    oldData.length === layer.layerWidth * layer.layerHeight
  ) {
    const lw = layer.layerWidth;
    const lh = layer.layerHeight;
    const ox = layer.offsetX;
    const oy = layer.offsetY;
    for (let ly = 0; ly < lh; ly++) {
      const dstY = ly + oy;
      if (dstY < 0 || dstY >= ch) continue;
      const dstRow = dstY * cw;
      const srcRow = ly * lw;
      for (let lx = 0; lx < lw; lx++) {
        const dstX = lx + ox;
        if (dstX < 0 || dstX >= cw) continue;
        out[dstRow + dstX] = oldData[srcRow + lx];
      }
    }
  }

  // ── 4. Write the gradient into `out` (canvas-space) ──────────────────────
  for (let cy = 0; cy < ch; cy++) {
    const rowStart = cy * cw;
    for (let cx = 0; cx < cw; cx++) {
      if (selectionMask && selectionMask[rowStart + cx] === 0) continue;

      // Project canvas pixel onto the drag axis, clamped to [0, 1].
      let t = ((cx - x0) * dx + (cy - y0) * dy) / lenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;

      // Continuous stripe position 0..N.  Boundaries between adjacent
      // colours sit at integer values (1, 2, …, N-1).
      const pf = t * N;
      let stripe = Math.floor(pf);
      if (stripe >= N) stripe = N - 1;

      if (dither && halfStripe > 0) {
        const fracInStripe = pf - stripe;
        const distPrev = fracInStripe;
        const distNext = 1 - fracInStripe;
        const threshold = BAYER8[cy & 7][cx & 7] / 64;

        if (distPrev < halfStripe && stripe > 0) {
          const probPrev = 0.5 * (1 - distPrev / halfStripe);
          if (threshold < probPrev) stripe -= 1;
        } else if (distNext < halfStripe && stripe < N - 1) {
          const probNext = 0.5 * (1 - distNext / halfStripe);
          if (threshold < probNext) stripe += 1;
        }
      }

      out[rowStart + cx] = indices[stripe];
    }
  }

  // ── 5. Promote the layer to full canvas size and swap in the new buffer.
  //    `replaceLayerData` reallocates the GPU texture and clears any stale
  //    `dirtyRect`, then immediately flushes — so no half-uploaded prior
  //    state can mask the new gradient. ──────────────────────────────────
  if (
    layer.layerWidth !== cw ||
    layer.layerHeight !== ch ||
    layer.offsetX !== 0 ||
    layer.offsetY !== 0
  ) {
    layer.layerWidth = cw;
    layer.layerHeight = ch;
    layer.offsetX = 0;
    layer.offsetY = 0;
  }
  renderer.replaceLayerData(layer, out, "indexed8", palette as RGBAColor[]);
  render(layers);
}

// ─── Gradient rasteriser ──────────────────────────────────────────────────────

function renderGradient(
  ctx: ToolContext,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  // Indexed8 documents take a completely different code path: no alpha
  // blending, no colour interpolation — just palette indices.
  if (ctx.layer.format === "indexed8") {
    renderIndexedGradient(ctx, x0, y0, x1, y1);
    return;
  }

  const {
    renderer,
    layer,
    layers,
    primaryColor,
    secondaryColor,
    selectionMask,
    render,
    growLayerToFit,
  } = ctx;
  const { type, repeat, opacity } = gradientOptions;

  // Grow layer to full canvas coverage
  const cw = renderer.pixelWidth;
  const ch = renderer.pixelHeight;
  growLayerToFit(0, 0);
  growLayerToFit(cw - 1, 0);
  growLayerToFit(0, ch - 1);
  growLayerToFit(cw - 1, ch - 1);

  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return;
  const len = Math.sqrt(lenSq);

  const alpha = opacity / 100;

  for (let ly = 0; ly < layer.layerHeight; ly++) {
    for (let lx = 0; lx < layer.layerWidth; lx++) {
      const cx = lx + layer.offsetX;
      const cy = ly + layer.offsetY;

      // Skip pixels outside the active selection
      if (selectionMask && selectionMask[cy * cw + cx] === 0) continue;

      let t: number;
      if (type === "linear") {
        // Project pixel onto the gradient direction vector
        t = ((cx - x0) * dx + (cy - y0) * dy) / lenSq;
      } else {
        // Radial: distance from center / radius
        const ddx = cx - x0;
        const ddy = cy - y0;
        t = Math.sqrt(ddx * ddx + ddy * ddy) / len;
      }

      t = applyRepeat(t, repeat);

      const [gr, gg, gb, ga] = lerpColor(primaryColor, secondaryColor, t);
      const srcA = ga * alpha;

      if (srcA <= 0) continue;

      // Porter-Duff "over" composite onto existing pixel
      const i = (ly * layer.layerWidth + lx) * 4;
      if (layer.format === "rgba32f") {
        // gr/gg/gb are sRGB-encoded floats from primary/secondary; rgba32f
        // layers store linear-light, so gamma-decode before compositing.
        const sr = srgbToLinearChannel(gr);
        const sg = srgbToLinearChannel(gg);
        const sb = srgbToLinearChannel(gb);
        const dstR = layer.data[i],
          dstG = layer.data[i + 1],
          dstB = layer.data[i + 2];
        const dstA = layer.data[i + 3]; // already 0.0–1.0
        const outA = srcA + dstA * (1 - srcA);
        if (outA <= 0) {
          layer.data[i] = 0;
          layer.data[i + 1] = 0;
          layer.data[i + 2] = 0;
          layer.data[i + 3] = 0;
        } else {
          const blend = dstA * (1 - srcA);
          layer.data[i] = (sr * srcA + dstR * blend) / outA;
          layer.data[i + 1] = (sg * srcA + dstG * blend) / outA;
          layer.data[i + 2] = (sb * srcA + dstB * blend) / outA;
          layer.data[i + 3] = outA;
        }
      } else {
        // Convert float [0,1] to 0-255 for rgba8
        const gr8 = Math.round(Math.min(gr, 1) * 255);
        const gg8 = Math.round(Math.min(gg, 1) * 255);
        const gb8 = Math.round(Math.min(gb, 1) * 255);
        const dstR = layer.data[i];
        const dstG = layer.data[i + 1];
        const dstB = layer.data[i + 2];
        const dstA = layer.data[i + 3] / 255;
        const outA = srcA + dstA * (1 - srcA);
        if (outA <= 0) {
          layer.data[i] = 0;
          layer.data[i + 1] = 0;
          layer.data[i + 2] = 0;
          layer.data[i + 3] = 0;
        } else {
          const blend = dstA * (1 - srcA);
          layer.data[i] = Math.round((gr8 * srcA + dstR * blend) / outA);
          layer.data[i + 1] = Math.round((gg8 * srcA + dstG * blend) / outA);
          layer.data[i + 2] = Math.round((gb8 * srcA + dstB * blend) / outA);
          layer.data[i + 3] = Math.round(outA * 255);
        }
      }
    }
  }

  renderer.flushLayer(layer);
  render(layers);
}

// ─── Overlay preview ──────────────────────────────────────────────────────────

function drawOverlayPreview(
  canvas: HTMLCanvasElement,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  type: typeof gradientOptions.type,
): void {
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) return;
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);

  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;

  ctx2d.save();
  ctx2d.strokeStyle = "#ffffff";
  ctx2d.lineWidth = 1;
  ctx2d.setLineDash([4, 3]);
  ctx2d.lineDashOffset = 0;
  ctx2d.shadowColor = "#000000";
  ctx2d.shadowBlur = 2;

  if (type === "linear") {
    // Dashed line with perpendicular ticks at start and end
    ctx2d.beginPath();
    ctx2d.moveTo(x0, y0);
    ctx2d.lineTo(x1, y1);
    ctx2d.stroke();

    // Draw perpendicular ticks (8px each side)
    const nx = -dy / len,
      ny = dx / len;
    const tickLen = 8;
    for (const [tx, ty] of [
      [x0, y0],
      [x1, y1],
    ]) {
      ctx2d.beginPath();
      ctx2d.moveTo(tx + nx * tickLen, ty + ny * tickLen);
      ctx2d.lineTo(tx - nx * tickLen, ty - ny * tickLen);
      ctx2d.stroke();
    }
  } else {
    // Circle at radius + line from center
    ctx2d.beginPath();
    ctx2d.arc(x0, y0, len, 0, Math.PI * 2);
    ctx2d.stroke();

    ctx2d.beginPath();
    ctx2d.moveTo(x0, y0);
    ctx2d.lineTo(x1, y1);
    ctx2d.stroke();
  }

  // Arrow head at end
  const angle = Math.atan2(dy, dx);
  const arrowLen = 8;
  ctx2d.setLineDash([]);
  ctx2d.beginPath();
  ctx2d.moveTo(x1, y1);
  ctx2d.lineTo(
    x1 - arrowLen * Math.cos(angle - 0.4),
    y1 - arrowLen * Math.sin(angle - 0.4),
  );
  ctx2d.moveTo(x1, y1);
  ctx2d.lineTo(
    x1 - arrowLen * Math.cos(angle + 0.4),
    y1 - arrowLen * Math.sin(angle + 0.4),
  );
  ctx2d.stroke();

  ctx2d.restore();
}

function clearOverlay(canvas: HTMLCanvasElement): void {
  const ctx2d = canvas.getContext("2d");
  if (ctx2d) ctx2d.clearRect(0, 0, canvas.width, canvas.height);
}

// ─── Handler ─────────────────────────────────────────────────────────────────

function createGradientHandler(): ToolHandler {
  let startPos: { x: number; y: number } | null = null;

  return {
    onPointerDown({ x, y }: ToolPointerPos, ctx: ToolContext) {
      startPos = { x, y };
      if (ctx.overlayCanvas)
        drawOverlayPreview(ctx.overlayCanvas, x, y, x, y, gradientOptions.type);
    },

    onPointerMove({ x, y }: ToolPointerPos, ctx: ToolContext) {
      if (!startPos) return;
      if (ctx.overlayCanvas) {
        drawOverlayPreview(
          ctx.overlayCanvas,
          startPos.x,
          startPos.y,
          x,
          y,
          gradientOptions.type,
        );
      }
    },

    onPointerUp({ x, y }: ToolPointerPos, ctx: ToolContext) {
      if (!startPos) return;
      const s = startPos;
      startPos = null;

      if (ctx.overlayCanvas) clearOverlay(ctx.overlayCanvas);

      renderGradient(ctx, s.x, s.y, x, y);
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function GradientOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const { state } = useAppContext();
  const isIndexed = state.pixelFormat === "indexed8";

  const [type, setType] = useState(gradientOptions.type);
  const [repeat, setRepeat] = useState(gradientOptions.repeat);
  const [opacity, setOpacity] = useState(gradientOptions.opacity);
  const [paletteGroupId, setPaletteGroupId] = useState(
    gradientOptions.paletteGroupId,
  );
  const [direction, setDirection] = useState(gradientOptions.direction);
  const [dither, setDither] = useState(gradientOptions.dither);
  const [ditherRange, setDitherRange] = useState(gradientOptions.ditherRange);

  const handleType = (v: typeof gradientOptions.type): void => {
    gradientOptions.type = v;
    setType(v);
  };
  const handleRepeat = (v: typeof gradientOptions.repeat): void => {
    gradientOptions.repeat = v;
    setRepeat(v);
  };
  const handleOpacity = (v: number): void => {
    gradientOptions.opacity = v;
    setOpacity(v);
  };
  const handleGroup = (v: string): void => {
    const id = v === "" ? null : v;
    gradientOptions.paletteGroupId = id;
    setPaletteGroupId(id);
  };
  const handleDirection = (v: typeof gradientOptions.direction): void => {
    gradientOptions.direction = v;
    setDirection(v);
  };
  const handleDither = (v: boolean): void => {
    gradientOptions.dither = v;
    setDither(v);
  };
  const handleDitherRange = (v: number): void => {
    gradientOptions.ditherRange = v;
    setDitherRange(v);
  };

  // ── Indexed8 palette-group gradient ─────────────────────────────────────
  if (isIndexed) {
    const eligibleGroups = state.swatchGroups.filter(
      (g) => g.swatchIndices.length >= 2,
    );
    const selectValue =
      paletteGroupId &&
      eligibleGroups.some((g) => g.id === paletteGroupId)
        ? paletteGroupId
        : "";
    return (
      <>
        <label className={styles.optLabel}>Group:</label>
        <select
          className={styles.optSelect}
          value={selectValue}
          onChange={(e) => handleGroup(e.target.value)}
        >
          <option value="">
            {eligibleGroups.length === 0
              ? "No groups (≥ 2 colours)"
              : "First eligible"}
          </option>
          {eligibleGroups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({g.swatchIndices.length})
            </option>
          ))}
        </select>
        <span className={styles.optSep} />
        <label className={styles.optLabel}>Direction:</label>
        <select
          className={styles.optSelect}
          value={direction}
          onChange={(e) =>
            handleDirection(e.target.value as typeof gradientOptions.direction)
          }
        >
          <option value="forward">Start → End</option>
          <option value="reverse">End → Start</option>
        </select>
        <span className={styles.optSep} />
        <label className={styles.optCheckLabel}>
          <input
            type="checkbox"
            checked={dither}
            onChange={(e) => handleDither(e.target.checked)}
          />
          Dither
        </label>
        {dither && (
          <>
            <label className={styles.optLabel}>Range:</label>
            <SliderInput
              value={ditherRange}
              min={1}
              max={1024}
              suffix="px"
              inputWidth={42}
              onChange={handleDitherRange}
            />
          </>
        )}
      </>
    );
  }

  // ── Default freeform gradient (rgba8 / rgba32f) ─────────────────────────
  return (
    <>
      <label className={styles.optLabel}>Type:</label>
      <select
        className={styles.optSelect}
        value={type}
        onChange={(e) =>
          handleType(e.target.value as typeof gradientOptions.type)
        }
      >
        <option value="linear">Linear</option>
        <option value="radial">Radial</option>
      </select>
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Repeat:</label>
      <select
        className={styles.optSelect}
        value={repeat}
        onChange={(e) =>
          handleRepeat(e.target.value as typeof gradientOptions.repeat)
        }
      >
        <option value="none">None</option>
        <option value="repeat">Repeat</option>
        <option value="reflect">Reflect</option>
      </select>
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Opacity:</label>
      <SliderInput
        value={opacity}
        min={1}
        max={100}
        suffix="%"
        inputWidth={42}
        onChange={handleOpacity}
      />
    </>
  );
}

class GradientTool implements ITool {
  readonly id = "gradient";
  readonly label = "Gradient";
  readonly shortcut = "G";
  readonly icon = <SvgIcon src={gradientIconSvg} />;
  readonly placement = { group: ToolGroup.Fill, row: 0, column: 1 } as const;
  readonly modifiesPixels = true;
  readonly paintsOntoPixelLayer = true;
  readonly pixelOnly = true;
  createHandler(): ToolHandler {
    return createGradientHandler();
  }
  readonly Options = GradientOptions;
}

export const gradientTool: ITool = new GradientTool();
