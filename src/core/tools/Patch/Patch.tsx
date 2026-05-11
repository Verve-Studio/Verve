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
import patchIconSvg from "./patch.svg?raw";
import { activeScope } from "@/core/store/scope";

// ─── Module-level options ─────────────────────────────────────────────────────

export type PatchMode = "source" | "destination";

export const patchOptions = {
  /**
   * - "source"      : drag the selection to where you want to *sample from*.
   *                   On release the source pixels are blended into the
   *                   original selection, so blemishes inside the selection
   *                   get replaced by the dragged-to area. The selection
   *                   stays put.
   * - "destination" : drag the selection to where you want to *paste to*.
   *                   On release the original selection's pixels are blended
   *                   into the destination, and the selection moves there.
   */
  mode: "source" as PatchMode,
  /** Edge feather radius (px) for the selection boundary used when committing
   *  the patch. Higher = smoother blend at the edge. */
  diffusion: 4,
  /** Feather (px) applied at selection-creation time (matches lasso). */
  feather: 0,
  /** Anti-alias the selection boundary at creation time. */
  antiAlias: true,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function maskBoundingRect(
  mask: Uint8Array,
  W: number,
  H: number,
): Rect | null {
  let minX = W,
    minY = H,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x] > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Soft-erode mask edges by `radius` pixels (a few box-blur passes on a copy
 *  of the mask). Used to feather the patch boundary so it blends instead of
 *  forming a hard edge. The original selection mask is not modified. */
function blurMask(
  src: Uint8Array,
  W: number,
  H: number,
  radius: number,
): Uint8Array {
  if (radius <= 0) return new Uint8Array(src);
  const passes = Math.max(1, Math.min(7, radius | 0));
  let a = new Uint8Array(src);
  let b = new Uint8Array(W * H);
  for (let pass = 0; pass < passes; pass++) {
    // separable horizontal
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0,
          n = 0;
        const x0 = Math.max(0, x - 1);
        const x1 = Math.min(W - 1, x + 1);
        for (let xx = x0; xx <= x1; xx++) {
          s += a[y * W + xx];
          n++;
        }
        b[y * W + x] = (s / n) | 0;
      }
    }
    // separable vertical
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        let s = 0,
          n = 0;
        const y0 = Math.max(0, y - 1);
        const y1 = Math.min(H - 1, y + 1);
        for (let yy = y0; yy <= y1; yy++) {
          s += b[yy * W + x];
          n++;
        }
        a[y * W + x] = (s / n) | 0;
      }
    }
  }
  return a;
}

interface PatchSnapshot {
  /** Pre-drag layer pixels (full layer-local buffer). */
  pixels: Uint8Array | Float32Array;
  /** Pre-drag selection mask (canvas-space, full canvas). */
  mask: Uint8Array;
  /** Mask after diffusion blur — used as the per-pixel blend weight. */
  blendMask: Uint8Array;
  bbox: Rect;
  /** Width/height of `mask` (canvas-space). */
  maskW: number;
  maskH: number;
}

/**
 * Apply the patch to `layer.data` for an offset (dx, dy):
 *
 *   • source mode: layer[p] = lerp(snapshot[p], snapshot[p + offset], w)
 *   • destination mode: layer[p + offset] = lerp(snapshot[p + offset], snapshot[p], w)
 *
 * `snapshot.pixels` is a full-layer copy of pre-drag pixel data; layer.data is
 * the live buffer being mutated. The layer is reset to the snapshot before
 * applying so each preview frame starts from a clean baseline (no compounding
 * of in-flight edits).
 */
function applyPatch(
  ctx: ToolContext,
  snapshot: PatchSnapshot,
  dx: number,
  dy: number,
  mode: PatchMode,
): void {
  const layer = ctx.layer;
  const isFloat = layer.format === "rgba32f";
  const W = layer.layerWidth;
  const H = layer.layerHeight;
  const offX = layer.offsetX;
  const offY = layer.offsetY;
  const max = isFloat ? 1 : 255;

  // Reset to snapshot (cheap full-buffer copy keeps preview consistent).
  if (isFloat) {
    (layer.data as Float32Array).set(snapshot.pixels as Float32Array);
  } else {
    (layer.data as Uint8Array).set(snapshot.pixels as Uint8Array);
  }

  const mW = snapshot.maskW;
  const bbox = snapshot.bbox;
  const blendMask = snapshot.blendMask;

  for (let cy = bbox.y; cy < bbox.y + bbox.h; cy++) {
    for (let cx = bbox.x; cx < bbox.x + bbox.w; cx++) {
      const w255 = blendMask[cy * mW + cx];
      if (w255 === 0) continue;
      const w = w255 / 255;

      // Source mode: read from cx+dx, cy+dy; write to cx, cy.
      // Destination mode: read from cx, cy; write to cx+dx, cy+dy.
      const srcCx = mode === "source" ? cx + dx : cx;
      const srcCy = mode === "source" ? cy + dy : cy;
      const dstCx = mode === "source" ? cx : cx + dx;
      const dstCy = mode === "source" ? cy : cy + dy;

      // Convert canvas-space → layer-local for both endpoints; bail on bounds.
      const srcLx = srcCx - offX;
      const srcLy = srcCy - offY;
      const dstLx = dstCx - offX;
      const dstLy = dstCy - offY;
      if (
        srcLx < 0 ||
        srcLy < 0 ||
        srcLx >= W ||
        srcLy >= H ||
        dstLx < 0 ||
        dstLy < 0 ||
        dstLx >= W ||
        dstLy >= H
      )
        continue;

      const si = (srcLy * W + srcLx) * 4;
      const di = (dstLy * W + dstLx) * 4;
      const inv = 1 - w;

      if (isFloat) {
        const src = snapshot.pixels as Float32Array;
        const dst = layer.data as Float32Array;
        const dR = src[di];
        const dG = src[di + 1];
        const dB = src[di + 2];
        const dA = src[di + 3];
        dst[di] = dR * inv + src[si] * w;
        dst[di + 1] = dG * inv + src[si + 1] * w;
        dst[di + 2] = dB * inv + src[si + 2] * w;
        dst[di + 3] = dA * inv + src[si + 3] * w;
      } else {
        const src = snapshot.pixels as Uint8Array;
        const dst = layer.data as Uint8Array;
        const dR = src[di];
        const dG = src[di + 1];
        const dB = src[di + 2];
        const dA = src[di + 3];
        dst[di] = Math.max(0, Math.min(max, Math.round(dR * inv + src[si] * w)));
        dst[di + 1] = Math.max(
          0,
          Math.min(max, Math.round(dG * inv + src[si + 1] * w)),
        );
        dst[di + 2] = Math.max(
          0,
          Math.min(max, Math.round(dB * inv + src[si + 2] * w)),
        );
        dst[di + 3] = Math.max(
          0,
          Math.min(max, Math.round(dA * inv + src[si + 3] * w)),
        );
      }
    }
  }

  // Mark the entire patched area dirty (union of src+dst bboxes).
  const minLx = Math.max(
    0,
    Math.min(bbox.x, bbox.x + dx) - offX,
  );
  const maxLx = Math.min(
    W - 1,
    Math.max(bbox.x + bbox.w, bbox.x + bbox.w + dx) - offX,
  );
  const minLy = Math.max(
    0,
    Math.min(bbox.y, bbox.y + dy) - offY,
  );
  const maxLy = Math.min(
    H - 1,
    Math.max(bbox.y + bbox.h, bbox.y + bbox.h + dy) - offY,
  );
  ctx.renderer.markDirtyRect(layer, minLx, minLy, maxLx + 1, maxLy + 1);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function createPatchHandler(): ToolHandler {
  // Phase A — drawing a freehand selection (no selection yet, or click-outside).
  let drawingPath = false;
  let pathPoints: { x: number; y: number }[] = [];

  // Phase B — dragging an existing selection to apply a patch.
  let patching = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let snapshot: PatchSnapshot | null = null;

  function captureSnapshot(ctx: ToolContext): PatchSnapshot | null {
    const mask = ctx.selectionMask;
    if (!mask) return null;
    // canvas-space mask dimensions — selection mask is always canvas-sized.
    const mW = ctx.renderer.pixelWidth;
    const mH = ctx.renderer.pixelHeight;
    const bbox = maskBoundingRect(mask, mW, mH);
    if (!bbox) return null;
    const pixels =
      ctx.layer.format === "rgba32f"
        ? new Float32Array(ctx.layer.data as Float32Array)
        : new Uint8Array(ctx.layer.data as Uint8Array);
    const blendMask = blurMask(mask, mW, mH, patchOptions.diffusion);
    return {
      pixels,
      mask: new Uint8Array(mask),
      blendMask,
      bbox,
      maskW: mW,
      maskH: mH,
    };
  }

  return {
    onPointerDown(
      { x, y, shiftKey, altKey }: ToolPointerPos,
      ctx: ToolContext,
    ): void {
      if (ctx.layer.format === "indexed8") return;

      // Click inside the existing selection → patch drag.
      if (
        ctx.selectionMask &&
        activeScope().selection.isPixelSelected(Math.round(x), Math.round(y))
      ) {
        snapshot = captureSnapshot(ctx);
        if (!snapshot) return;
        patching = true;
        dragStartX = Math.round(x);
        dragStartY = Math.round(y);
        ctx.setCursor("move");
        return;
      }

      // Otherwise start drawing a new selection (lasso-style). Modifier keys
      // mirror the lasso's add/subtract/replace behaviour via setPolygon mode.
      void shiftKey;
      void altKey;
      drawingPath = true;
      pathPoints = [{ x, y }];
      activeScope().selection.setPending({ type: "path", points: [...pathPoints] });
      ctx.setCursor("crosshair");
    },

    onPointerMove(
      { x, y, shiftKey, altKey }: ToolPointerPos,
      ctx: ToolContext,
    ): void {
      if (drawingPath) {
        const last = pathPoints[pathPoints.length - 1];
        if (Math.abs(x - last.x) < 2 && Math.abs(y - last.y) < 2) return;
        pathPoints.push({ x, y });
        activeScope().selection.setPending({ type: "path", points: [...pathPoints] });
        void shiftKey;
        void altKey;
        return;
      }
      if (!patching || !snapshot) return;
      const dx = Math.round(x) - dragStartX;
      const dy = Math.round(y) - dragStartY;
      applyPatch(ctx, snapshot, dx, dy, patchOptions.mode);
      ctx.renderer.flushLayer(ctx.layer);
      ctx.render();
    },

    onPointerUp(
      { x, y, shiftKey, altKey }: ToolPointerPos,
      ctx: ToolContext,
    ): void {
      if (drawingPath) {
        pathPoints.push({ x, y });
        const mode = altKey ? "subtract" : shiftKey ? "add" : "set";
        const effectiveFeather =
          patchOptions.feather > 0
            ? patchOptions.feather
            : patchOptions.antiAlias
              ? 1
              : 0;
        activeScope().selection.setPolygon(pathPoints, mode, effectiveFeather);
        drawingPath = false;
        pathPoints = [];
        return;
      }
      if (!patching || !snapshot) return;
      const dx = Math.round(x) - dragStartX;
      const dy = Math.round(y) - dragStartY;
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
        // Tiny drag — revert preview.
        if (ctx.layer.format === "rgba32f") {
          (ctx.layer.data as Float32Array).set(snapshot.pixels as Float32Array);
        } else {
          (ctx.layer.data as Uint8Array).set(snapshot.pixels as Uint8Array);
        }
        ctx.renderer.flushLayer(ctx.layer);
        ctx.render();
      } else {
        applyPatch(ctx, snapshot, dx, dy, patchOptions.mode);
        ctx.renderer.flushLayer(ctx.layer);
        // Destination mode moves the selection along with the patched pixels.
        if (patchOptions.mode === "destination") {
          activeScope().selection.translateMask(dx, dy);
        }
        ctx.render();
        ctx.commitStroke("Patch");
      }
      patching = false;
      snapshot = null;
    },

    onHover(pos: ToolPointerPos, ctx: ToolContext): void {
      // Don't override the cursor while in mid-drag; the active branch
      // (drawing or patching) owns the cursor for that interaction.
      if (drawingPath || patching) return;
      // "move" when over an existing selection (you can drag-patch from
      // here), otherwise crosshair (you can draw a new selection).
      const inside =
        !!ctx.selectionMask &&
        activeScope().selection.isPixelSelected(Math.round(pos.x), Math.round(pos.y));
      ctx.setCursor(inside ? "move" : "crosshair");
    },

    onLeave(ctx: ToolContext): void {
      ctx.setCursor("");
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

const MODE_LABELS: Record<PatchMode, string> = {
  source: "Source",
  destination: "Destination",
};

function PatchOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [mode, setMode] = useState<PatchMode>(patchOptions.mode);
  const [diffusion, setDiffusion] = useState(patchOptions.diffusion);
  const [feather, setFeather] = useState(patchOptions.feather);
  const [antiAlias, setAntiAlias] = useState(patchOptions.antiAlias);

  return (
    <>
      <label className={styles.optLabel}>Patch:</label>
      <select
        className={styles.optSelect}
        value={mode}
        onChange={(e) => {
          const v = e.target.value as PatchMode;
          patchOptions.mode = v;
          setMode(v);
        }}
      >
        {(Object.keys(MODE_LABELS) as PatchMode[]).map((k) => (
          <option key={k} value={k}>
            {MODE_LABELS[k]}
          </option>
        ))}
      </select>
      <span className={styles.optSep} />
      <label
        className={styles.optLabel}
        title="Edge softening for the patch boundary. Higher = smoother blend."
      >
        Diffusion:
      </label>
      <SliderInput
        value={diffusion}
        min={0}
        max={7}
        inputWidth={32}
        onChange={(v) => {
          patchOptions.diffusion = v;
          setDiffusion(v);
        }}
      />
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Feather:</label>
      <SliderInput
        value={feather}
        min={0}
        max={100}
        suffix="px"
        inputWidth={38}
        onChange={(v) => {
          patchOptions.feather = v;
          setFeather(v);
        }}
      />
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={antiAlias}
          onChange={(e) => {
            patchOptions.antiAlias = e.target.checked;
            setAntiAlias(e.target.checked);
          }}
        />
        Anti-alias
      </label>
    </>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

class PatchTool implements ITool {
  readonly id = "patch";
  readonly label = "Patch";
  readonly shortcut = "J";
  readonly icon = <SvgIcon src={patchIconSvg} />;
  readonly placement = {
    group: ToolGroup.Retouching,
    row: 1,
    column: 0,
  } as const;
  readonly modifiesPixels = true;
  readonly pixelOnly = true;
  readonly indexed8Unsupported = true;
  createHandler(): ToolHandler {
    return createPatchHandler();
  }
  readonly Options = PatchOptions;
}

export const patchTool: ITool = new PatchTool();
