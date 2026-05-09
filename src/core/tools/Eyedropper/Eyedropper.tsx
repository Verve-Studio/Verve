import React from "react";
import type {
  GpuLayer,
  WebGPURenderer,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import type { RGBAColor } from "@/types";
import type {
  ToolHandler,
  ToolOptionsStyles,
  ToolContext,
  ToolPointerPos,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import colorPickerIconSvg from "./color-picker.svg?raw";

// ─── Module-level options (read synchronously inside pointer events) ──────────

export const eyedropperOptions = {
  sampleSize: 1 as 1 | 3 | 5,
};

// ─── Composited pixel sampling ────────────────────────────────────────────────

function sampleCompositedPixel(
  layers: GpuLayer[],
  renderer: WebGPURenderer,
  cx: number,
  cy: number,
): [number, number, number, number] {
  // Porter-Duff "over" compositing, bottom-to-top through all visible layers
  let dstR = 0,
    dstG = 0,
    dstB = 0,
    dstA = 0;

  for (const layer of layers) {
    if (!layer.visible || layer.opacity === 0) continue;
    const [sr_raw, sg_raw, sb_raw, sa_raw] = renderer.sampleCanvasPixel(
      layer,
      cx,
      cy,
    );
    if (sa_raw === 0) continue;

    // Normalize to [0,1]: samplePixel returns 0-255 for rgba8, 0.0-1.0 for rgba32f
    const scale = layer.format === "rgba32f" ? 1 : 255;
    const sr = sr_raw / scale,
      sg = sg_raw / scale,
      sb = sb_raw / scale,
      sa = sa_raw / scale;

    const srcA = sa * layer.opacity;
    const outA = srcA + dstA * (1 - srcA);
    if (outA === 0) continue;

    dstR = (sr * srcA + dstR * dstA * (1 - srcA)) / outA;
    dstG = (sg * srcA + dstG * dstA * (1 - srcA)) / outA;
    dstB = (sb * srcA + dstB * dstA * (1 - srcA)) / outA;
    dstA = outA;
  }

  // dstR/G/B are now in [0,1] (or >1 for HDR); return as 0-255 range for sampleArea
  return [
    Math.round(dstR * 255),
    Math.round(dstG * 255),
    Math.round(dstB * 255),
    Math.round(dstA * 255),
  ];
}

function sampleArea(
  layers: GpuLayer[],
  renderer: WebGPURenderer,
  cx: number,
  cy: number,
  sampleSize: 1 | 3 | 5,
): RGBAColor {
  const half = Math.floor(sampleSize / 2);
  let totalR = 0,
    totalG = 0,
    totalB = 0,
    totalA = 0;
  let count = 0;

  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const [r, g, b, a] = sampleCompositedPixel(
        layers,
        renderer,
        cx + dx,
        cy + dy,
      );
      totalR += r;
      totalG += g;
      totalB += b;
      totalA += a;
      count++;
    }
  }

  return {
    r: Math.round(totalR / count) / 255,
    g: Math.round(totalG / count) / 255,
    b: Math.round(totalB / count) / 255,
    a: Math.round(totalA / count) / 255,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function createEyedropperHandler(): ToolHandler {
  function sampleIndexedPixel(
    ctx: ToolContext,
    canvasX: number,
    canvasY: number,
  ): { index: number; color: RGBAColor | null } | null {
    for (let i = ctx.layers.length - 1; i >= 0; i--) {
      const layer = ctx.layers[i];
      if (!layer.visible || layer.format !== "indexed8") continue;
      const lx = canvasX - layer.offsetX;
      const ly = canvasY - layer.offsetY;
      if (lx < 0 || lx >= layer.layerWidth || ly < 0 || ly >= layer.layerHeight)
        continue;
      const index = (layer.data as Uint8Array)[ly * layer.layerWidth + lx];
      const color =
        index < ctx.swatches.length
          ? {
              r: ctx.swatches[index].r / 255,
              g: ctx.swatches[index].g / 255,
              b: ctx.swatches[index].b / 255,
              a: ctx.swatches[index].a / 255,
            }
          : null;
      return { index, color };
    }
    return null;
  }

  function pick(pos: ToolPointerPos, ctx: ToolContext): void {
    if (ctx.pixelFormat === "indexed8") {
      const result = sampleIndexedPixel(
        ctx,
        Math.floor(pos.x),
        Math.floor(pos.y),
      );
      if (result && result.color) {
        ctx.setSwatch(result.index);
        ctx.setColor(result.color);
      }
      return;
    }
    const color = sampleArea(
      ctx.layers,
      ctx.renderer,
      Math.floor(pos.x),
      Math.floor(pos.y),
      eyedropperOptions.sampleSize,
    );
    ctx.setColor(color);
  }

  return {
    onPointerDown(pos, ctx) {
      pick(pos, ctx);
    },
    onPointerMove(pos, ctx) {
      // Only sample while button is held (pressure > 0)
      if (pos.pressure > 0) pick(pos, ctx);
    },
    onPointerUp() {},
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function EyedropperOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  return (
    <>
      <label className={styles.optLabel}>Sample:</label>
      <select
        className={styles.optSelect}
        defaultValue="1"
        onChange={(e) => {
          eyedropperOptions.sampleSize = parseInt(e.target.value, 10) as
            | 1
            | 3
            | 5;
        }}
      >
        <option value="1">Point</option>
        <option value="3">3×3 Average</option>
        <option value="5">5×5 Average</option>
      </select>
    </>
  );
}

class EyedropperTool implements ITool {
  readonly id = "eyedropper";
  readonly label = "Eyedropper";
  readonly shortcut = "I";
  readonly icon = <SvgIcon src={colorPickerIconSvg} />;
  readonly placement = {
    group: ToolGroup.Sampling,
    row: 0,
    column: 0,
  } as const;
  createHandler(): ToolHandler {
    return createEyedropperHandler();
  }
  readonly Options = EyedropperOptions;
}

export const eyedropperTool: ITool = new EyedropperTool();
