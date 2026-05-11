import React, { useState } from "react";
import { floodFill, floodFillF32 } from "@/wasm";
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
import paintBucketIconSvg from "./paint-bucket.svg?raw";
import { resolveNearestPaletteIndex } from "@/utils/indexedColorUtils";
import { srgbToLinearChannel } from "@/utils/pixelFormatConvert";

// ─── Module-level options ─────────────────────────────────────────────────────

const fillOptions = {
  tolerance: 32,
  contiguous: true,
};

// ─── Indexed8 contiguous flood fill (pure TS, synchronous) ──────────────────

function floodFillIndexedTS(
  data: Uint8Array,
  w: number,
  h: number,
  startX: number,
  startY: number,
  fillIndex: number,
): void {
  if (startX < 0 || startX >= w || startY < 0 || startY >= h) return;
  const targetIndex = data[startY * w + startX];
  if (targetIndex === fillIndex) return;
  const stack: number[] = [startY * w + startX];
  while (stack.length > 0) {
    const pos = stack.pop()!;
    if (data[pos] !== targetIndex) continue;
    data[pos] = fillIndex;
    const x = pos % w;
    const y = (pos - x) / w;
    if (x > 0) stack.push(pos - 1);
    if (x < w - 1) stack.push(pos + 1);
    if (y > 0) stack.push(pos - w);
    if (y < h - 1) stack.push(pos + w);
  }
}

// ─── Non-contiguous fill (replace all matching pixels in the layer) ───────────

function fillAllMatching(
  data: Uint8Array,
  width: number,
  height: number,
  targetR: number,
  targetG: number,
  targetB: number,
  targetA: number,
  fillR: number,
  fillG: number,
  fillB: number,
  fillA: number,
  tolerance: number,
): void {
  const thresh2 = tolerance * tolerance * 4;
  for (let i = 0; i < width * height * 4; i += 4) {
    const dr = data[i] - targetR;
    const dg = data[i + 1] - targetG;
    const db = data[i + 2] - targetB;
    const da = data[i + 3] - targetA;
    if (dr * dr + dg * dg + db * db + da * da <= thresh2) {
      data[i] = fillR;
      data[i + 1] = fillG;
      data[i + 2] = fillB;
      data[i + 3] = fillA;
    }
  }
}

function fillAllMatchingF32(
  data: Float32Array,
  width: number,
  height: number,
  targetR: number,
  targetG: number,
  targetB: number,
  targetA: number,
  fillR: number,
  fillG: number,
  fillB: number,
  fillA: number,
  tolerance: number, // [0,1] float space
): void {
  const thresh2 = tolerance * tolerance * 4;
  for (let i = 0; i < width * height * 4; i += 4) {
    const dr = data[i] - targetR;
    const dg = data[i + 1] - targetG;
    const db = data[i + 2] - targetB;
    const da = data[i + 3] - targetA;
    if (dr * dr + dg * dg + db * db + da * da <= thresh2) {
      data[i] = fillR;
      data[i + 1] = fillG;
      data[i + 2] = fillB;
      data[i + 3] = fillA;
    }
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

function createFillHandler(): ToolHandler {
  return {
    onPointerDown({ x, y }: ToolPointerPos, ctx: ToolContext) {
      const {
        renderer,
        layer,
        layers,
        primaryColor,
        selectionMask,
        render,
        commitStroke,
        growLayerToFit,
      } = ctx;
      // primaryColor is sRGB-encoded float [0,1] (may be >1 for HDR on rgba32f layers)
      const r = Math.round(Math.min(primaryColor.r, 1) * 255);
      const g = Math.round(Math.min(primaryColor.g, 1) * 255);
      const b = Math.round(Math.min(primaryColor.b, 1) * 255);
      const a = Math.round(primaryColor.a * 255);
      // Linear-light float fill values for rgba32f (gamma-decode sRGB → linear;
      // values > 1 stay > 1 to preserve HDR highlights).
      const fr = srgbToLinearChannel(primaryColor.r);
      const fg = srgbToLinearChannel(primaryColor.g);
      const fb = srgbToLinearChannel(primaryColor.b);
      const fa = primaryColor.a;

      // Grow the layer to cover the full canvas so that clicks on transparent
      // areas outside the initial sparse buffer are still reachable.
      const cw = renderer.pixelWidth;
      const ch = renderer.pixelHeight;
      growLayerToFit(0, 0);
      growLayerToFit(cw - 1, 0);
      growLayerToFit(0, ch - 1);
      growLayerToFit(cw - 1, ch - 1);

      // Snapshot pixels outside the selection so we can restore them after fill.
      // (We snapshot only when a selection mask is active to avoid the copy cost.)
      const snapshot = selectionMask ? layer.data.slice() : null;

      /** Restore pixels that fall outside the active selection mask. */
      const applySelectionMask = (): void => {
        if (!snapshot || !selectionMask) return;
        const lw = layer.layerWidth;
        for (let ly2 = 0; ly2 < layer.layerHeight; ly2++) {
          for (let lx2 = 0; lx2 < lw; lx2++) {
            const cx2 = lx2 + layer.offsetX;
            const cy2 = ly2 + layer.offsetY;
            const mi = cy2 * cw + cx2;
            if (mi < 0 || mi >= selectionMask.length || selectionMask[mi] !== 0)
              continue;
            const pi = (ly2 * lw + lx2) * 4;
            layer.data[pi] = snapshot[pi];
            layer.data[pi + 1] = snapshot[pi + 1];
            layer.data[pi + 2] = snapshot[pi + 2];
            layer.data[pi + 3] = snapshot[pi + 3];
          }
        }
      };

      // Convert canvas-space click to layer-local coords (re-compute after growth)
      const lx = Math.floor(x) - layer.offsetX;
      const ly = Math.floor(y) - layer.offsetY;

      // ── indexed8 path ───────────────────────────────────────────────────────
      if (layer.format === "indexed8") {
        const strokeIndex = resolveNearestPaletteIndex(
          r,
          g,
          b,
          a,
          ctx.swatches,
        );
        const lw = layer.layerWidth;

        const applyIndexedSelectionMask = (snapshotI: Uint8Array): void => {
          if (!selectionMask) return;
          for (let ly2 = 0; ly2 < layer.layerHeight; ly2++) {
            for (let lx2 = 0; lx2 < lw; lx2++) {
              const cx2 = lx2 + layer.offsetX;
              const cy2 = ly2 + layer.offsetY;
              const mi = cy2 * cw + cx2;
              if (
                mi < 0 ||
                mi >= selectionMask.length ||
                selectionMask[mi] !== 0
              )
                continue;
              (layer.data as Uint8Array)[ly2 * lw + lx2] =
                snapshotI[ly2 * lw + lx2];
            }
          }
        };

        if (fillOptions.contiguous) {
          if (
            lx < 0 ||
            ly < 0 ||
            lx >= layer.layerWidth ||
            ly >= layer.layerHeight
          )
            return;
          const snapshotI = selectionMask
            ? (layer.data as Uint8Array).slice()
            : null;
          floodFillIndexedTS(
            layer.data as Uint8Array,
            layer.layerWidth,
            layer.layerHeight,
            lx,
            ly,
            strokeIndex,
          );
          if (snapshotI) applyIndexedSelectionMask(snapshotI);
          renderer.flushLayer(layer, ctx.swatches);
          render(layers);
          commitStroke("Fill");
        } else {
          if (
            lx < 0 ||
            ly < 0 ||
            lx >= layer.layerWidth ||
            ly >= layer.layerHeight
          )
            return;
          const snapshotI = selectionMask
            ? (layer.data as Uint8Array).slice()
            : null;
          const targetIndex = (layer.data as Uint8Array)[
            ly * layer.layerWidth + lx
          ];
          for (let i = 0; i < layer.data.length; i++) {
            if ((layer.data as Uint8Array)[i] === targetIndex) {
              (layer.data as Uint8Array)[i] = strokeIndex;
            }
          }
          if (snapshotI) applyIndexedSelectionMask(snapshotI);
          renderer.flushLayer(layer, ctx.swatches);
          render(layers);
          commitStroke("Fill");
        }
        return;
      }

      if (fillOptions.contiguous) {
        // Async WASM flood fill (contiguous)
        if (layer.format === "rgba32f") {
          // Float32 path: tolerance normalised to [0,1] space (slider is 0-255)
          const tolF32 = fillOptions.tolerance / 255;
          floodFillF32(
            layer.data.slice() as Float32Array,
            layer.layerWidth,
            layer.layerHeight,
            lx,
            ly,
            fr,
            fg,
            fb,
            fa,
            tolF32,
          )
            .then((result) => {
              (layer.data as Float32Array).set(result);
              applySelectionMask();
              renderer.flushLayer(layer);
              render(layers);
              commitStroke("Fill");
            })
            .catch((err) => {
              console.error("[Fill] WASM f32 flood fill failed:", err);
            });
        } else {
          floodFill(
            layer.data.slice() as Uint8Array,
            layer.layerWidth,
            layer.layerHeight,
            lx,
            ly,
            r,
            g,
            b,
            a,
            fillOptions.tolerance,
          )
            .then((result) => {
              layer.data.set(result);
              applySelectionMask();
              renderer.flushLayer(layer);
              render(layers);
              commitStroke("Fill");
            })
            .catch((err) => {
              console.error("[Fill] WASM flood fill failed:", err);
            });
        }
      } else {
        // Non-contiguous: fill all matching pixels synchronously
        if (
          lx < 0 ||
          ly < 0 ||
          lx >= layer.layerWidth ||
          ly >= layer.layerHeight
        )
          return;
        if (layer.format === "rgba32f") {
          const data = layer.data as Float32Array;
          const startIdx = (ly * layer.layerWidth + lx) * 4;
          fillAllMatchingF32(
            data,
            layer.layerWidth,
            layer.layerHeight,
            data[startIdx],
            data[startIdx + 1],
            data[startIdx + 2],
            data[startIdx + 3],
            fr,
            fg,
            fb,
            fa,
            fillOptions.tolerance / 255,
          );
        } else {
          const startIdx = (ly * layer.layerWidth + lx) * 4;
          const targetR = layer.data[startIdx];
          const targetG = layer.data[startIdx + 1];
          const targetB = layer.data[startIdx + 2];
          const targetA = layer.data[startIdx + 3];
          fillAllMatching(
            layer.data as Uint8Array,
            layer.layerWidth,
            layer.layerHeight,
            targetR,
            targetG,
            targetB,
            targetA,
            r,
            g,
            b,
            a,
            fillOptions.tolerance,
          );
        }
        applySelectionMask();
        renderer.flushLayer(layer);
        render(layers);
        commitStroke("Fill");
      }
    },
    onPointerMove() {},
    onPointerUp() {},
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function FillOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [tolerance, setTolerance] = useState(fillOptions.tolerance);
  const [contiguous, setContiguous] = useState(fillOptions.contiguous);

  const handleTolerance = (v: number): void => {
    fillOptions.tolerance = v;
    setTolerance(v);
  };
  const handleContiguous = (v: boolean): void => {
    fillOptions.contiguous = v;
    setContiguous(v);
  };

  return (
    <>
      <label className={styles.optLabel}>Tolerance:</label>
      <SliderInput
        value={tolerance}
        min={0}
        max={255}
        inputWidth={42}
        onChange={handleTolerance}
      />
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={contiguous}
          onChange={(e) => handleContiguous(e.target.checked)}
        />
        Contiguous
      </label>
    </>
  );
}

class FillTool implements ITool {
  readonly id = "fill";
  readonly label = "Paint Bucket";
  readonly shortcut = "G";
  readonly icon = <SvgIcon src={paintBucketIconSvg} />;
  readonly placement = { group: ToolGroup.Fill, row: 0, column: 0 } as const;
  readonly modifiesPixels = true;
  readonly skipAutoHistory = true;
  readonly paintsOntoPixelLayer = true;
  readonly pixelOnly = true;
  createHandler(): ToolHandler {
    return createFillHandler();
  }
  readonly Options = FillOptions;
}

export const fillTool: ITool = new FillTool();
