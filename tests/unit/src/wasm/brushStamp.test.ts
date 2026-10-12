// Basic contract of the WASM brush-stamp wrapper: slicing, layer offsets,
// format handling and the zero-copy path. (JS-vs-WASM pixel parity of the
// brush engine is covered alongside the Brush tool.)
import { beforeAll, describe, expect, it } from "vitest";
import { allocWasmF32, allocWasmU8, freeWasm, getPixelOps, runBrushStamp, type BrushStampJob } from "@/wasm";
import type { PixelOpsModule } from "@/wasm/types";

let m: PixelOpsModule;
beforeAll(async () => {
  m = await getPixelOps();
});

const CANVAS = 16;

/** A hard, opaque round dab of radius `r` at canvas (cx, cy). */
function job(over: Partial<BrushStampJob> & Pick<BrushStampJob, "layerData">): BrushStampJob {
  const cx = over.cx ?? 8;
  const cy = over.cy ?? 8;
  const r = over.radius ?? 3;
  return {
    cx,
    cy,
    radius: r,
    roundness: 1,
    angle: 0,
    shear: 0,
    flipX: 1,
    flipY: 1,
    aa: false,
    softness: 0,
    minX: Math.floor(cx - r - 1),
    minY: Math.floor(cy - r - 1),
    maxX: Math.ceil(cx + r + 1),
    maxY: Math.ceil(cy + r + 1),
    tipKind: 0,
    r: 200,
    g: 40,
    b: 10,
    a: 255,
    fr: 2.5,
    fg: 0.25,
    fb: 0,
    fa: 1,
    opacity: 100, // 0..100
    capOpacity: -1,
    bypassCap: false,
    layerOffsetX: 0,
    layerOffsetY: 0,
    layerW: CANVAS,
    layerH: CANVAS,
    layerFormat: 0,
    touchedData: new Uint8Array(CANVAS * CANVAS),
    touchedW: CANVAS,
    touchedH: CANVAS,
    canvasW: CANVAS,
    canvasH: CANVAS,
    ditherSeed: 1,
    sweepDx: 0,
    sweepDy: 0,
    sweepR0: 0,
    blendMode: 0,
    strokeFlags: 0,
    ...over,
  };
}

const rgbaAt = (d: Uint8Array | Float32Array, w: number, x: number, y: number): number[] =>
  Array.from(d.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));

describe("runBrushStamp", () => {
  it("paints an opaque dab on rgba8 and leaves pixels outside its radius untouched", () => {
    const layer = new Uint8Array(CANVAS * CANVAS * 4);
    const j = job({ layerData: layer });
    expect(runBrushStamp(m, j)).toBe(true);
    expect(rgbaAt(layer, CANVAS, 8, 8)).toEqual([200, 40, 10, 255]);
    expect(rgbaAt(layer, CANVAS, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(rgbaAt(layer, CANVAS, 8, 14)).toEqual([0, 0, 0, 0]);
    // Coverage is recorded in the canvas-sized touched buffer.
    expect(j.touchedData[8 * CANVAS + 8]).toBeGreaterThan(0);
    expect(j.touchedData[0]).toBe(0);
  });

  it("writes linear HDR floats on rgba32f layers", () => {
    const layer = new Float32Array(CANVAS * CANVAS * 4);
    expect(runBrushStamp(m, job({ layerData: layer, layerFormat: 1 }))).toBe(true);
    const c = rgbaAt(layer, CANVAS, 8, 8);
    expect(c[0]).toBeCloseTo(2.5, 5);
    expect(c[1]).toBeCloseTo(0.25, 5);
    expect(c[3]).toBeCloseTo(1, 5);
    expect(rgbaAt(layer, CANVAS, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("maps canvas coordinates into an offset layer", () => {
    // 8×8 layer at canvas (6, 6); the dab at canvas (8, 8) is layer (2, 2).
    const layer = new Uint8Array(8 * 8 * 4);
    const j = job({ layerData: layer, layerOffsetX: 6, layerOffsetY: 6, layerW: 8, layerH: 8 });
    expect(runBrushStamp(m, j)).toBe(true);
    expect(rgbaAt(layer, 8, 2, 2)).toEqual([200, 40, 10, 255]);
    expect(rgbaAt(layer, 8, 7, 7)).toEqual([0, 0, 0, 0]);
  });

  it("returns false and writes nothing when the bbox misses the layer", () => {
    const layer = new Uint8Array(4 * 4 * 4);
    const j = job({ layerData: layer, layerW: 4, layerH: 4 }); // dab at (8, 8)
    expect(runBrushStamp(m, j)).toBe(false);
    expect(layer.every((v) => v === 0)).toBe(true);
  });

  it("respects a hard selection mask", () => {
    const layer = new Uint8Array(CANVAS * CANVAS * 4);
    const sel = new Uint8Array(CANVAS * CANVAS);
    for (let y = 0; y < CANVAS; y++) for (let x = 0; x < 8; x++) sel[y * CANVAS + x] = 255;
    expect(runBrushStamp(m, job({ layerData: layer, selMask: sel }))).toBe(true);
    expect(rgbaAt(layer, CANVAS, 7, 8)).toEqual([200, 40, 10, 255]);
    expect(rgbaAt(layer, CANVAS, 9, 8)).toEqual([0, 0, 0, 0]);
  });

  it("the zero-copy path (heap-resident layer) matches the slice path", () => {
    for (const format of [0, 1] as const) {
      const sliced = format === 1 ? new Float32Array(CANVAS * CANVAS * 4) : new Uint8Array(CANVAS * CANVAS * 4);
      runBrushStamp(m, job({ layerData: sliced, layerFormat: format, aa: true, softness: 0.5 }));

      let layerView: Uint8Array | Float32Array;
      let touchedView: Uint8Array;
      const layerAlloc =
        format === 1
          ? allocWasmF32(m, CANVAS * CANVAS * 4, (v) => (layerView = v))!
          : allocWasmU8(m, CANVAS * CANVAS * 4, (v) => (layerView = v))!;
      layerView = layerAlloc.view;
      layerView.fill(0);
      const touchedAlloc = allocWasmU8(m, CANVAS * CANVAS, (v) => (touchedView = v))!;
      touchedView = touchedAlloc.view;
      touchedView.fill(0);
      try {
        runBrushStamp(
          m,
          job({
            layerData: layerView,
            layerWasmPtr: layerAlloc.ptr,
            touchedData: touchedView,
            touchedWasmPtr: touchedAlloc.ptr,
            layerFormat: format,
            aa: true,
            softness: 0.5,
          }),
        );
        if (format === 1) {
          expect(Array.from(layerView)).toEqual(Array.from(sliced));
        } else {
          // 8-bit writes use stochastic rounding seeded by pixel position,
          // which the slice path rebases: allow ±1.
          for (let i = 0; i < sliced.length; i++) {
            expect(Math.abs(layerView[i] - sliced[i])).toBeLessThanOrEqual(1);
          }
        }
      } finally {
        freeWasm(m, layerAlloc.ptr);
        freeWasm(m, touchedAlloc.ptr);
      }
    }
  });
});
