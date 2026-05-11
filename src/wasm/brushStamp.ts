/**
 * High-level wrapper for the WASM brush-stamp kernel.
 *
 * The kernel mutates layer + touched buffers in place. Naively copying
 * the full canvas in/out per stamp would dominate (a 4K rgba8 layer is
 * 64 MB; 10 stamps/sec = 640 MB/s of memcpy, eating the WASM win). So
 * the wrapper *slices* the stamp's bounding box from the layer and
 * touched buffers, runs the kernel against the slice, and copies the
 * slice back. The slice is also pre-clipped to the layer's actual
 * extent so the kernel never has to bounds-check inside the loop.
 *
 * Tiled-mode stamps and bitmap-tip SDF caching are handled here.
 */
import type { PixelOpsModule } from "./types";

/** Field offsets in the packed `BrushStampParams` struct. MUST match the
 *  natural-alignment C++ layout in `wasm/src/brush_stamp.h` byte-for-byte
 *  — float and int are both 4 bytes, no padding. Total 172 bytes;
 *  allocation rounded to 192 for safety. */
const PARAM_F = {
  cx: 0,
  cy: 4,
  radius: 8,
  roundness: 12,
  angle: 16,
  shear: 20,
  aaWidth: 24,
  fr: 28,
  fg: 32,
  fb: 36,
  fa: 40,
  opacity: 60,
  capOpacity: 64,
  // Dual brush + grain (extension after layer_format @ 136)
  dualSizeRatio: 148,
  dualBaseAngle: 152,
  dualMix: 156,
  grainAmount: 160,
  grainScale: 164,
} as const;
const PARAM_I = {
  r: 44,
  g: 48,
  b: 52,
  a: 56,
  minX: 68,
  minY: 72,
  maxX: 76,
  maxY: 80,
  flipX: 84,
  flipY: 88,
  tipKind: 92,
  bypassCap: 96,
  layerOffsetX: 100,
  layerOffsetY: 104,
  layerW: 108,
  layerH: 112,
  touchedW: 116,
  touchedH: 120,
  tiled: 124,
  tiledW: 128,
  tiledH: 132,
  layerFormat: 136,
  dualActive: 140,
  dualTipKind: 144,
  // (5 floats follow at 148–164 — see PARAM_F)
  grainFollowBrush: 168,
} as const;
const PARAM_BYTES = 192;

export interface BrushStampJob {
  // Geometry (canvas-pixel space)
  cx: number;
  cy: number;
  radius: number;
  roundness: number;
  angle: number;
  shear: number;
  flipX: 1 | -1;
  flipY: 1 | -1;
  aaWidth: number;
  // Bbox (canvas-pixel space, inclusive — wrapper clips internally)
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  // Tip
  tipKind: 0 | 1 | 2 | 3;
  /** For tipKind=3 only — bilinear SDF in pixel-distance units. Cached
   *  in WASM heap by reference identity, so reusing the same
   *  `Float32Array` across stamps avoids re-uploading. */
  sdfData?: Float32Array;
  sdfW?: number;
  sdfH?: number;
  // Color (rgba8 path uses bytes; rgba32f uses pre-linearised floats)
  r: number;
  g: number;
  b: number;
  a: number;
  fr: number;
  fg: number;
  fb: number;
  fa: number;
  // Blend
  opacity: number;
  /** Negative = no cap (single-stamp == cap legacy behaviour). */
  capOpacity: number;
  bypassCap: boolean;
  // Layer (data is in *layer-local* coordinates)
  layerData: Uint8Array | Float32Array;
  layerOffsetX: number;
  layerOffsetY: number;
  layerW: number;
  layerH: number;
  layerFormat: 0 | 1; // 0 = rgba8, 1 = rgba32f
  /** When set, `layerData` is a view into the WASM heap at this ptr.
   *  The kernel reads/writes the layer in-place — no slice marshalling. */
  layerWasmPtr?: number;
  // Touched (canvas-sized)
  touchedData: Uint8Array;
  touchedW: number;
  touchedH: number;
  /** When set, `touchedData` is a view into the WASM heap at this ptr. */
  touchedWasmPtr?: number;
  // Selection (canvas-sized, optional)
  selMask?: Uint8Array;
  // Canvas extent — required by the kernel for bounds checks.
  canvasW: number;
  canvasH: number;
  // ── Optional dual brush ────────────────────────────────────────────
  dualActive?: boolean;
  /** 0=round 1=square 2=diamond 3=bitmap. Required when dualActive. */
  dualTipKind?: 0 | 1 | 2 | 3;
  /** Dual radius = primary radius × this. */
  dualSizeRatio?: number;
  /** Total dual rotation (primary angle + dual.angle [+ direction]). */
  dualBaseAngle?: number;
  /** 0..1 mix between identity and full multiply. */
  dualMix?: number;
  /** For dualTipKind=3 only — bitmap SDF data. Cached in WASM heap by
   *  reference identity (same WeakMap as the primary tip's SDF). */
  dualSdfData?: Float32Array;
  dualSdfW?: number;
  dualSdfH?: number;
  // ── Optional paper grain ──────────────────────────────────────────
  /** 0 disables grain entirely. */
  grainAmount?: number;
  /** Pixels per noise period (≥ 2). */
  grainScale?: number;
  /** True = sample in tip-local; false = canvas-locked. */
  grainFollowBrush?: boolean;
}

interface BrushStampScratch {
  paramsPtr: number;
  paramsView: DataView;
  /** Bitmap-tip SDFs cached in WASM heap by Float32Array identity. */
  sdfPtrByData: WeakMap<Float32Array, number>;
  /** Selection mask cache for the zero-copy path: keyed by Uint8Array
   *  reference identity (selection store gives the same buffer until the
   *  mask actually changes), so we upload once per mask change. */
  selMaskPtr: number;
  selMaskFor: Uint8Array | null;
}

const SCRATCH = new WeakMap<PixelOpsModule, BrushStampScratch>();

function getScratch(m: PixelOpsModule): BrushStampScratch {
  let s = SCRATCH.get(m);
  if (s) return s;
  const paramsPtr = m._malloc(PARAM_BYTES);
  s = {
    paramsPtr,
    paramsView: new DataView(m.HEAPU8.buffer, paramsPtr, PARAM_BYTES),
    sdfPtrByData: new WeakMap(),
    selMaskPtr: 0,
    selMaskFor: null,
  };
  SCRATCH.set(m, s);
  return s;
}

/** Upload (or return cached) selection mask for the zero-copy path. */
function uploadSelMaskCanvas(
  m: PixelOpsModule,
  s: BrushStampScratch,
  mask: Uint8Array,
): number {
  if (s.selMaskFor === mask && s.selMaskPtr !== 0) return s.selMaskPtr;
  if (s.selMaskPtr !== 0) m._free(s.selMaskPtr);
  s.selMaskPtr = m._malloc(mask.byteLength);
  m.HEAPU8.set(mask, s.selMaskPtr);
  s.selMaskFor = mask;
  return s.selMaskPtr;
}

/** Re-bind cached views if the WASM heap was resized. */
function refreshParamsView(m: PixelOpsModule, s: BrushStampScratch): void {
  if (s.paramsView.buffer !== m.HEAPU8.buffer) {
    s.paramsView = new DataView(m.HEAPU8.buffer, s.paramsPtr, PARAM_BYTES);
  }
}

function uploadSdf(
  m: PixelOpsModule,
  s: BrushStampScratch,
  sdf: Float32Array,
): number {
  const cached = s.sdfPtrByData.get(sdf);
  if (cached !== undefined) return cached;
  const ptr = m._malloc(sdf.byteLength);
  new Float32Array(m.HEAPU8.buffer, ptr, sdf.length).set(sdf);
  s.sdfPtrByData.set(sdf, ptr);
  return ptr;
}

/**
 * Zero-copy implementation: layer.data and touched.data are already in
 * the WASM heap, so we just hand the kernel their ptrs (no slicing, no
 * memcpy). Selection mask still needs a one-shot upload — most strokes
 * share one mask and the cache hits after the first stamp.
 *
 * Bbox is clipped to canvas + layer extent at the call site (we only
 * trust pre-clipped values to keep the kernel's per-pixel bounds checks
 * fast).
 */
function runBrushStampZeroCopy(
  m: PixelOpsModule,
  j: BrushStampJob,
  cx0: number,
  cy0: number,
  cx1: number,
  cy1: number,
): boolean {
  const s = getScratch(m);
  // syncIfGrew is a no-op when nothing allocated since last call; safe.
  if (s.paramsView.buffer !== m.HEAPU8.buffer) {
    s.paramsView = new DataView(m.HEAPU8.buffer, s.paramsPtr, PARAM_BYTES);
  }
  // Upload bitmap SDFs if needed (cached by Float32Array identity).
  const sdfPtr = j.sdfData ? uploadSdf(m, s, j.sdfData) : 0;
  const dualSdfPtr = j.dualSdfData ? uploadSdf(m, s, j.dualSdfData) : 0;
  const selPtr = j.selMask ? uploadSelMaskCanvas(m, s, j.selMask) : 0;

  // Pack params in **canvas space** — no slice rebase needed; the kernel
  // walks layer.data via its real (layer_offset, layer_w, layer_h) and
  // touched.data as canvas-sized.
  const view = s.paramsView;
  view.setFloat32(PARAM_F.cx, j.cx, true);
  view.setFloat32(PARAM_F.cy, j.cy, true);
  view.setFloat32(PARAM_F.radius, j.radius, true);
  view.setFloat32(PARAM_F.roundness, j.roundness, true);
  view.setFloat32(PARAM_F.angle, j.angle, true);
  view.setFloat32(PARAM_F.shear, j.shear, true);
  view.setFloat32(PARAM_F.aaWidth, j.aaWidth, true);
  view.setFloat32(PARAM_F.fr, j.fr, true);
  view.setFloat32(PARAM_F.fg, j.fg, true);
  view.setFloat32(PARAM_F.fb, j.fb, true);
  view.setFloat32(PARAM_F.fa, j.fa, true);
  view.setInt32(PARAM_I.r, j.r, true);
  view.setInt32(PARAM_I.g, j.g, true);
  view.setInt32(PARAM_I.b, j.b, true);
  view.setInt32(PARAM_I.a, j.a, true);
  view.setFloat32(PARAM_F.opacity, j.opacity, true);
  view.setFloat32(PARAM_F.capOpacity, j.capOpacity, true);
  view.setInt32(PARAM_I.minX, cx0, true);
  view.setInt32(PARAM_I.minY, cy0, true);
  view.setInt32(PARAM_I.maxX, cx1, true);
  view.setInt32(PARAM_I.maxY, cy1, true);
  view.setInt32(PARAM_I.flipX, j.flipX, true);
  view.setInt32(PARAM_I.flipY, j.flipY, true);
  view.setInt32(PARAM_I.tipKind, j.tipKind, true);
  view.setInt32(PARAM_I.bypassCap, j.bypassCap ? 1 : 0, true);
  view.setInt32(PARAM_I.layerOffsetX, j.layerOffsetX, true);
  view.setInt32(PARAM_I.layerOffsetY, j.layerOffsetY, true);
  view.setInt32(PARAM_I.layerW, j.layerW, true);
  view.setInt32(PARAM_I.layerH, j.layerH, true);
  view.setInt32(PARAM_I.touchedW, j.touchedW, true);
  view.setInt32(PARAM_I.touchedH, j.touchedH, true);
  view.setInt32(PARAM_I.tiled, 0, true);
  view.setInt32(PARAM_I.tiledW, 0, true);
  view.setInt32(PARAM_I.tiledH, 0, true);
  view.setInt32(PARAM_I.layerFormat, j.layerFormat, true);
  view.setInt32(PARAM_I.dualActive, j.dualActive ? 1 : 0, true);
  view.setInt32(PARAM_I.dualTipKind, j.dualTipKind ?? 0, true);
  view.setFloat32(PARAM_F.dualSizeRatio, j.dualSizeRatio ?? 1, true);
  view.setFloat32(PARAM_F.dualBaseAngle, j.dualBaseAngle ?? 0, true);
  view.setFloat32(PARAM_F.dualMix, j.dualMix ?? 0, true);
  view.setFloat32(PARAM_F.grainAmount, j.grainAmount ?? 0, true);
  view.setFloat32(PARAM_F.grainScale, j.grainScale ?? 64, true);
  view.setInt32(PARAM_I.grainFollowBrush, j.grainFollowBrush ? 1 : 0, true);

  m._pixelops_brush_stamp(
    s.paramsPtr,
    j.layerWasmPtr!,
    j.touchedWasmPtr!,
    selPtr,
    sdfPtr,
    j.sdfW ?? 0,
    j.sdfH ?? 0,
    dualSdfPtr,
    j.dualSdfW ?? 0,
    j.dualSdfH ?? 0,
  );
  return true;
}

/**
 * Run one brush stamp through the WASM kernel. Mutates `layerData` and
 * `touchedData` in place.
 *
 * Returns `false` if the bbox doesn't intersect the layer/canvas (caller
 * can treat as a successful no-op). Throws if WASM allocation fails.
 */
export function runBrushStamp(m: PixelOpsModule, j: BrushStampJob): boolean {
  // ── Clip the stamp's bbox to canvas + layer extent ───────────────────
  const layerCanvasX0 = j.layerOffsetX;
  const layerCanvasY0 = j.layerOffsetY;
  const layerCanvasX1 = j.layerOffsetX + j.layerW - 1;
  const layerCanvasY1 = j.layerOffsetY + j.layerH - 1;
  const cx0 = Math.max(j.minX, 0, layerCanvasX0);
  const cy0 = Math.max(j.minY, 0, layerCanvasY0);
  const cx1 = Math.min(j.maxX, j.canvasW - 1, layerCanvasX1);
  const cy1 = Math.min(j.maxY, j.canvasH - 1, layerCanvasY1);
  if (cx1 < cx0 || cy1 < cy0) return false;

  // ── Zero-copy fast path ──────────────────────────────────────────────
  // When both layer.data and touched.data live in the WASM heap, the
  // kernel can mutate them in place via their ptrs. Skips the per-stamp
  // bbox slice copy in/out — the dominant cost for big brushes (~360 KB
  // round-trip per 300-px stamp). Selection mask still gets a one-shot
  // upload cached by identity (most strokes share the same mask).
  if (j.layerWasmPtr !== undefined && j.touchedWasmPtr !== undefined) {
    return runBrushStampZeroCopy(m, j, cx0, cy0, cx1, cy1);
  }

  const sliceW = cx1 - cx0 + 1;
  const sliceH = cy1 - cy0 + 1;
  const bpp = j.layerFormat === 1 ? 16 : 4;

  const s = getScratch(m);
  refreshParamsView(m, s);

  // ── Allocate scratch slices in WASM heap ────────────────────────────
  const layerSliceBytes = sliceW * sliceH * bpp;
  const layerSlicePtr = m._malloc(layerSliceBytes);
  const touchedSliceBytes = sliceW * sliceH;
  const touchedSlicePtr = m._malloc(touchedSliceBytes);
  const selSlicePtr = j.selMask ? m._malloc(touchedSliceBytes) : 0;

  try {
    refreshParamsView(m, s);

    // ── Copy bbox slice INTO the WASM heap ─────────────────────────────
    // Layer rows: slice is sliceW px wide, sourced from the original
    // layer's row at layer-local Y = (canvasY - layerOffsetY), starting
    // at layer-local X = (cx0 - layerOffsetX).
    if (j.layerFormat === 1) {
      const f32 = j.layerData as Float32Array;
      const dst = new Float32Array(
        m.HEAPU8.buffer,
        layerSlicePtr,
        sliceW * sliceH * 4,
      );
      const startLx = cx0 - j.layerOffsetX;
      for (let row = 0; row < sliceH; row++) {
        const srcLy = cy0 - j.layerOffsetY + row;
        const srcOff = (srcLy * j.layerW + startLx) * 4;
        const dstOff = row * sliceW * 4;
        dst.set(f32.subarray(srcOff, srcOff + sliceW * 4), dstOff);
      }
    } else {
      const u8 = j.layerData as Uint8Array;
      const startLx = cx0 - j.layerOffsetX;
      for (let row = 0; row < sliceH; row++) {
        const srcLy = cy0 - j.layerOffsetY + row;
        const srcOff = (srcLy * j.layerW + startLx) * 4;
        m.HEAPU8.set(
          u8.subarray(srcOff, srcOff + sliceW * 4),
          layerSlicePtr + row * sliceW * 4,
        );
      }
    }

    // Touched & sel slices are 1 byte/pixel, canvas-indexed.
    for (let row = 0; row < sliceH; row++) {
      const srcOff = (cy0 + row) * j.touchedW + cx0;
      m.HEAPU8.set(
        j.touchedData.subarray(srcOff, srcOff + sliceW),
        touchedSlicePtr + row * sliceW,
      );
    }
    if (j.selMask && selSlicePtr !== 0) {
      for (let row = 0; row < sliceH; row++) {
        const srcOff = (cy0 + row) * j.canvasW + cx0;
        m.HEAPU8.set(
          j.selMask.subarray(srcOff, srcOff + sliceW),
          selSlicePtr + row * sliceW,
        );
      }
    }

    // ── Pack params (bbox/offsets are slice-local) ────────────────────
    // Slice-local layer offset = cx0 (canvas), so kernel's
    // `lxLocal = canvasX - layerOX` gives the slice's local index.
    const view = s.paramsView;
    view.setFloat32(PARAM_F.cx, j.cx, true);
    view.setFloat32(PARAM_F.cy, j.cy, true);
    view.setFloat32(PARAM_F.radius, j.radius, true);
    view.setFloat32(PARAM_F.roundness, j.roundness, true);
    view.setFloat32(PARAM_F.angle, j.angle, true);
    view.setFloat32(PARAM_F.shear, j.shear, true);
    view.setFloat32(PARAM_F.aaWidth, j.aaWidth, true);
    view.setFloat32(PARAM_F.fr, j.fr, true);
    view.setFloat32(PARAM_F.fg, j.fg, true);
    view.setFloat32(PARAM_F.fb, j.fb, true);
    view.setFloat32(PARAM_F.fa, j.fa, true);
    view.setInt32(PARAM_I.r, j.r, true);
    view.setInt32(PARAM_I.g, j.g, true);
    view.setInt32(PARAM_I.b, j.b, true);
    view.setInt32(PARAM_I.a, j.a, true);
    view.setFloat32(PARAM_F.opacity, j.opacity, true);
    view.setFloat32(PARAM_F.capOpacity, j.capOpacity, true);
    view.setInt32(PARAM_I.minX, cx0, true);
    view.setInt32(PARAM_I.minY, cy0, true);
    view.setInt32(PARAM_I.maxX, cx1, true);
    view.setInt32(PARAM_I.maxY, cy1, true);
    view.setInt32(PARAM_I.flipX, j.flipX, true);
    view.setInt32(PARAM_I.flipY, j.flipY, true);
    view.setInt32(PARAM_I.tipKind, j.tipKind, true);
    view.setInt32(PARAM_I.bypassCap, j.bypassCap ? 1 : 0, true);
    view.setInt32(PARAM_I.layerOffsetX, cx0, true);
    view.setInt32(PARAM_I.layerOffsetY, cy0, true);
    view.setInt32(PARAM_I.layerW, sliceW, true);
    view.setInt32(PARAM_I.layerH, sliceH, true);
    // Touched is also slice-sized; kernel computes its key as
    // `(canvasY - cy0) * sliceW + (canvasX - cx0)` only when we set
    // touchedW = sliceW AND tell the kernel its "canvas" is the slice.
    // Equivalently: touched_w = sliceW, canvas_h = sliceH, but the
    // kernel uses touched_w directly so we can shift by passing a
    // slice-relative key. We pre-shift by passing layerOffset = cx0.
    // That makes lxLocal == sliceX. Then for the touched index we need
    // touchedW = sliceW AND we must also subtract cx0 from canvasX. The
    // kernel uses canvasX (post-tile-wrap) directly for the touched
    // key, so we can't "shift" in-kernel. Instead we encode the touched
    // index by claiming the kernel's canvas IS the slice: touched_w =
    // sliceW, touched_h = sliceH, AND we adjust the kernel's pixel-
    // walk so canvasX/Y is already 0..sliceW-1. We accomplish that by
    // setting min_x=0, max_x=sliceW-1, etc., and shifting cx/cy below.
    view.setInt32(PARAM_I.touchedW, sliceW, true);
    view.setInt32(PARAM_I.touchedH, sliceH, true);
    // Disable tiled-wrap inside the kernel — we've already fully
    // clipped to the slice. (Caller is expected to fall back to JS for
    // tiled-mode strokes.)
    view.setInt32(PARAM_I.tiled, 0, true);
    view.setInt32(PARAM_I.tiledW, 0, true);
    view.setInt32(PARAM_I.tiledH, 0, true);
    view.setInt32(PARAM_I.layerFormat, j.layerFormat, true);
    // ── Dual brush + paper grain (default off) ─────────────────────────
    const dualActive = j.dualActive ? 1 : 0;
    view.setInt32(PARAM_I.dualActive, dualActive, true);
    view.setInt32(PARAM_I.dualTipKind, j.dualTipKind ?? 0, true);
    view.setFloat32(PARAM_F.dualSizeRatio, j.dualSizeRatio ?? 1, true);
    view.setFloat32(PARAM_F.dualBaseAngle, j.dualBaseAngle ?? 0, true);
    view.setFloat32(PARAM_F.dualMix, j.dualMix ?? 0, true);
    view.setFloat32(PARAM_F.grainAmount, j.grainAmount ?? 0, true);
    view.setFloat32(PARAM_F.grainScale, j.grainScale ?? 64, true);
    view.setInt32(PARAM_I.grainFollowBrush, j.grainFollowBrush ? 1 : 0, true);

    // The kernel expects bbox + cx in a single coord space. We use the
    // SLICE space: rebase everything so (0, 0) is the slice's top-left.
    view.setFloat32(PARAM_F.cx, j.cx - cx0, true);
    view.setFloat32(PARAM_F.cy, j.cy - cy0, true);
    view.setInt32(PARAM_I.minX, 0, true);
    view.setInt32(PARAM_I.minY, 0, true);
    view.setInt32(PARAM_I.maxX, sliceW - 1, true);
    view.setInt32(PARAM_I.maxY, sliceH - 1, true);
    view.setInt32(PARAM_I.layerOffsetX, 0, true);
    view.setInt32(PARAM_I.layerOffsetY, 0, true);

    const sdfPtr = j.sdfData ? uploadSdf(m, s, j.sdfData) : 0;
    const dualSdfPtr = j.dualSdfData ? uploadSdf(m, s, j.dualSdfData) : 0;

    // ── Run kernel ─────────────────────────────────────────────────────
    refreshParamsView(m, s);
    m._pixelops_brush_stamp(
      s.paramsPtr,
      layerSlicePtr,
      touchedSlicePtr,
      selSlicePtr,
      sdfPtr,
      j.sdfW ?? 0,
      j.sdfH ?? 0,
      dualSdfPtr,
      j.dualSdfW ?? 0,
      j.dualSdfH ?? 0,
    );

    // ── Copy slice back to caller's buffers ───────────────────────────
    if (j.layerFormat === 1) {
      const f32 = j.layerData as Float32Array;
      const src = new Float32Array(
        m.HEAPU8.buffer,
        layerSlicePtr,
        sliceW * sliceH * 4,
      );
      const startLx = cx0 - j.layerOffsetX;
      for (let row = 0; row < sliceH; row++) {
        const dstLy = cy0 - j.layerOffsetY + row;
        const dstOff = (dstLy * j.layerW + startLx) * 4;
        f32.set(
          src.subarray(row * sliceW * 4, (row + 1) * sliceW * 4),
          dstOff,
        );
      }
    } else {
      const u8 = j.layerData as Uint8Array;
      const startLx = cx0 - j.layerOffsetX;
      for (let row = 0; row < sliceH; row++) {
        const dstLy = cy0 - j.layerOffsetY + row;
        const dstOff = (dstLy * j.layerW + startLx) * 4;
        u8.set(
          m.HEAPU8.subarray(
            layerSlicePtr + row * sliceW * 4,
            layerSlicePtr + (row + 1) * sliceW * 4,
          ),
          dstOff,
        );
      }
    }
    for (let row = 0; row < sliceH; row++) {
      const dstOff = (cy0 + row) * j.touchedW + cx0;
      j.touchedData.set(
        m.HEAPU8.subarray(
          touchedSlicePtr + row * sliceW,
          touchedSlicePtr + (row + 1) * sliceW,
        ),
        dstOff,
      );
    }

    return true;
  } finally {
    m._free(layerSlicePtr);
    m._free(touchedSlicePtr);
    if (selSlicePtr !== 0) m._free(selSlicePtr);
  }
}
