// JS-vs-WASM parity for the paint brush. CLAUDE.md: the per-pixel brush math
// exists twice — the C++ kernel (wasm/src/brush_stamp.cpp, via
// runBrushStamp) and the JS fallback in stampEngine's applyStamp loop
// (tipSampler / paperTexture / blendPixelOver with a dither seed). The same
// stroke is painted twice: once with the WASM module hidden from the engine
// (JS path), once with it visible (kernel path), and the pixels compared.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Brush, PixelFormat, RGBAColor } from "@/types";

const wasm = vi.hoisted(() => ({ visible: false, kernelCalls: 0 }));

vi.mock("@/wasm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/wasm")>();
  return {
    ...actual,
    getPixelOpsSync: () => (wasm.visible ? actual.getPixelOpsSync() : null),
    runBrushStamp: (...args: Parameters<typeof actual.runBrushStamp>) => {
      wasm.kernelCalls++;
      return actual.runBrushStamp(...args);
    },
    appendBrushStamp: (...args: Parameters<typeof actual.appendBrushStamp>) => {
      wasm.kernelCalls++;
      return actual.appendBrushStamp(...args);
    },
  };
});

import { getPixelOps } from "@/wasm";
import { allocWasmF32, allocWasmU8, freeWasm } from "@/wasm/wasmHeapStorage";
import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import type { TouchedBuffer } from "@/core/tools/_shared/primitives";
import { makeDefaultBrush } from "@/core/tools/Brush/brushPreset";
import { makeStarterBrushes } from "@/core/tools/Brush/brushPresets";
import { getCachedTipSampler } from "@/core/tools/Brush/tipSampler";
import { StrokeLayer } from "@/core/tools/Brush/strokeLayer";
import type { PixelOpsModule } from "@/wasm/types";
import {
  applyStrokeWetEdges,
  makeStrokeStampState,
  stampDot,
  stampSegment,
  strokeLayerNeeds,
  type StrokePoseInputs,
} from "@/core/tools/Brush/stampEngine";
import {
  asRenderer,
  makeFakeRenderer,
  makeLayer,
  makeTouched,
} from "@tests/fakes/toolsPixelFakes";

const W = 72;
const H = 56;
const PRIMARY: RGBAColor = { r: 0.85, g: 0.35, b: 0.12, a: 1 };
const SECONDARY: RGBAColor = { r: 0.1, g: 0.3, b: 0.9, a: 1 };
const POSE: StrokePoseInputs = { pressure: 1, tilt: 0, tiltAzimuth: 0, rotation: 0, direction: 0, velocity: 0 };

interface PaintOpts {
  segments?: boolean;
  selection?: Uint8Array | null;
  base?: readonly number[];
  /** WASM run: use the kernel's slice-copy fallback instead of pinning. */
  unpinned?: boolean;
}

interface PaintResult {
  data: Uint8Array | Float32Array;
  touched: Uint8Array;
  bbox: [number, number, number, number] | null;
}

function softSelection(): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m[y * W + x] = x < 20 ? 0 : x < 40 ? 128 : 255;
  return m;
}

/** Move a layer's pixels and the coverage buffer into the WASM heap, as the
 *  renderer does in production (the kernel's zero-copy path). */
async function pin(layer: GpuLayer, touched: TouchedBuffer): Promise<() => void> {
  const m = await getPixelOps();
  const src = layer.data;
  const got =
    src instanceof Float32Array
      ? allocWasmF32(m, src.length, (v) => (layer.data = v))
      : allocWasmU8(m, src.length, (v) => (layer.data = v));
  const tg = allocWasmU8(m, touched.data.length, (v) => (touched.data = v));
  if (!got || !tg) throw new Error("WASM pin failed");
  (got.view as Uint8Array).set(src as Uint8Array);
  layer.data = got.view;
  layer.wasmPtr = got.ptr;
  tg.view.fill(0);
  touched.data = tg.view;
  touched.wasmPtr = tg.ptr;
  return () => {
    freeWasm(m, got.ptr);
    freeWasm(m, tg.ptr);
  };
}

function paint(
  brush: Brush,
  format: PixelFormat,
  opts: PaintOpts = {},
  pinned?: { layer: GpuLayer; touched: TouchedBuffer },
): PaintResult {
  const renderer = makeFakeRenderer(W, H);
  const layer = pinned?.layer ?? makeLayer(format, W, H, opts.base ? { fill: opts.base } : {});
  const touched = pinned?.touched ?? makeTouched(W, H);
  const state = makeStrokeStampState(PRIMARY, touched, 0x5eed);
  // Blend modes / per-dab colour paint through the stroke layer, as Brush.tsx
  // sets it up: in the WASM heap when the module is visible, else JS memory.
  const needs = strokeLayerNeeds(brush);
  if (needs && format !== "indexed8")
    state.strokeLayer = new StrokeLayer(W, H, format === "rgba32f", needs.recolor, wasm.visible ? pixelOps : null);
  const sampler = getCachedTipSampler(brush.shape);
  let bbox: [number, number, number, number] | null = null;
  const onBbox = (a: number, b: number, c: number, d: number): void => {
    bbox = bbox ? [Math.min(bbox[0], a), Math.min(bbox[1], b), Math.max(bbox[2], c), Math.max(bbox[3], d)] : [a, b, c, d];
  };
  const sel = opts.selection ?? null;
  const size = brush.tip.size;
  if (opts.segments) {
    const pts = [
      [8.3, 30.1],
      [24.7, 12.4],
      [44.2, 40.6],
      [63.9, 20.2],
    ];
    stampDot(asRenderer(renderer), layer, [layer], brush, sampler, pts[0][0], pts[0][1], size, brush.opacity, PRIMARY, SECONDARY, sel, false, state, POSE, onBbox);
    for (let i = 1; i < pts.length; i++) {
      const [p0x, p0y] = pts[i - 1];
      const [p1x, p1y] = pts[i];
      stampSegment({
        renderer: asRenderer(renderer), layer, layers: [layer], brush, sampler,
        p0x, p0y, cpx: (p0x + p1x) / 2 + 3, cpy: (p0y + p1y) / 2 - 4, p1x, p1y,
        size0: size, size1: size * 0.8, opacity0: brush.opacity, opacity1: brush.opacity,
        primary: PRIMARY, secondary: SECONDARY, selectionMask: sel, tiledMode: false, state,
        pose0: POSE, pose1: POSE, onStampBbox: onBbox,
      });
    }
  } else {
    // Overlapping dots at sub-pixel positions (incl. one past the canvas edge).
    const dots = [
      [20.25, 20.5], [27.6, 24.1], [33.1, 28.9], [40.45, 30.2], [70.6, 10.3],
    ];
    for (const [x, y] of dots)
      stampDot(asRenderer(renderer), layer, [layer], brush, sampler, x, y, size, brush.opacity, PRIMARY, SECONDARY, sel, false, state, POSE, onBbox);
  }
  state.strokeLayer?.dispose();
  return { data: layer.data.slice(), touched: touched.data.slice(), bbox };
}

async function paintBoth(brush: () => Brush, format: PixelFormat, opts: PaintOpts = {}) {
  wasm.visible = false;
  wasm.kernelCalls = 0;
  const js = paint(brush(), format, opts);
  expect(wasm.kernelCalls, "JS run must not reach the kernel").toBe(0);
  wasm.visible = true;
  let kernel: PaintResult;
  if (opts.unpinned) {
    kernel = paint(brush(), format, opts);
  } else {
    const layer = makeLayer(format, W, H, opts.base ? { fill: opts.base } : {});
    const touched = makeTouched(W, H);
    const release = await pin(layer, touched);
    try {
      kernel = paint(brush(), format, opts, { layer, touched });
    } finally {
      release();
    }
  }
  expect(wasm.kernelCalls, "WASM run must use the kernel").toBeGreaterThan(0);
  return { js, kernel };
}

/** Max abs difference and number of differing values. With `alphaEps` set
 *  (RGBA data), the colour of a pixel whose alpha is <= alphaEps in both
 *  buffers is ignored: it is invisible, and the kernel may leave the dab
 *  colour behind under a zero / sub-quantum alpha. */
function diff(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  eps = 0,
  alphaEps?: number,
): { max: number; count: number; nonzero: number } {
  let max = 0;
  let count = 0;
  let nonzero = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== 0) nonzero++;
    if (alphaEps !== undefined && (i & 3) !== 3) {
      const ai = i | 3;
      if (a[ai] <= alphaEps && b[ai] <= alphaEps) continue;
    }
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
    if (d > eps) count++;
  }
  return { max, count, nonzero };
}

/** First few differing pixels, for failure messages. */
function describeDiff(r: { js: PaintResult; kernel: PaintResult }, eps: number): string {
  const rows: string[] = [];
  for (let i = 0; i < r.js.data.length && rows.length < 6; i++) {
    if (Math.abs(r.js.data[i] - r.kernel.data[i]) > eps) {
      const p = i >> 2;
      rows.push(`(${p % W},${Math.floor(p / W)}) ch${i & 3}: js=${r.js.data[i]} wasm=${r.kernel.data[i]}`);
    }
  }
  return rows.join("; ");
}

function expectParity(r: { js: PaintResult; kernel: PaintResult }, format: PixelFormat): void {
  const eps = format === "rgba32f" ? 1e-4 : 0;
  const d = diff(r.js.data, r.kernel.data, eps, format === "rgba32f" ? 1 / 1024 : 0);
  const msg = describeDiff(r, format === "rgba32f" ? 2e-3 : 1);
  expect(d.nonzero, "stroke painted something").toBeGreaterThan(50);
  if (format === "rgba32f") {
    expect(d.max, msg).toBeLessThan(2e-3);
  } else {
    // Float (JS double vs C++ float) can flip a stochastic rounding: ±1 on
    // a handful of channels.
    expect(d.max, msg).toBeLessThanOrEqual(1);
    expect(d.count, msg).toBeLessThanOrEqual(Math.max(4, d.nonzero * 0.01));
  }
  const t = diff(r.js.touched, r.kernel.touched);
  expect(t.max).toBeLessThanOrEqual(1);
  expect(r.js.bbox).toEqual(r.kernel.bbox);
}

type Variant = [string, () => Brush];

function variant(name: string, tweak: (b: Brush) => void): Variant {
  return [
    name,
    () => {
      const b = makeDefaultBrush("parity", name);
      b.pressureSize = false;
      b.motionBlur = 0;
      tweak(b);
      return b;
    },
  ];
}

const VARIANTS: Variant[] = [
  variant("default round", () => {}),
  variant("hard, aliased", (b) => {
    b.tip.hardness = 100;
    b.antiAlias = false;
  }),
  variant("soft, large", (b) => {
    b.tip.hardness = 0;
    b.tip.size = 30;
  }),
  variant("square, rotated, squashed", (b) => {
    b.shape = { kind: "square" };
    b.tip.angle = 0.6;
    b.tip.roundness = 0.45;
  }),
  variant("diamond", (b) => {
    b.shape = { kind: "diamond" };
    b.tip.hardness = 50;
  }),
  variant("low flow below opacity", (b) => {
    b.tip.flow = 35;
    b.opacity = 70;
  }),
  variant("paper grain multiply", (b) => {
    b.texture = { ...b.texture, amount: 0.7, scale: 9, mode: "multiply" };
  }),
  variant("paper grain subtract, tip-local", (b) => {
    b.texture = { ...b.texture, amount: 0.5, scale: 6, mode: "subtract", followBrush: true };
    b.opacity = 60;
  }),
  variant("dual tip", (b) => {
    b.dualTip = { enabled: true, shape: { kind: "square" }, sizeRatio: 0.4, angle: 0.3, mix: 0.8, directionFollow: false };
    b.tip.size = 24;
  }),
  variant("bitmap tip", (b) => {
    const sampled = makeStarterBrushes().find((s) => s.shape.kind === "bitmap");
    if (!sampled) throw new Error("no sampled starter brush");
    b.shape = sampled.shape;
    b.tip.size = 26;
  }),
];

let pixelOps: PixelOpsModule;

beforeAll(async () => {
  pixelOps = await getPixelOps();
});

beforeEach(() => {
  wasm.visible = false;
});

describe("brush stamp: JS fallback vs WASM kernel parity", () => {
  for (const format of ["rgba8", "rgba32f"] as const) {
    describe(format, () => {
      it.each(VARIANTS)("%s (dots)", async (_name, brush) => {
        expectParity(await paintBoth(brush, format), format);
      });
    });
  }

  it.each(["rgba8", "rgba32f"] as const)("stroke segments with swept dabs (%s)", async (format) => {
    expectParity(await paintBoth(VARIANTS[0][1], format, { segments: true }), format);
  });

  it.each(["rgba8", "rgba32f"] as const)("soft selection mask (%s)", async (format) => {
    const r = await paintBoth(VARIANTS[2][1], format, { selection: softSelection() });
    expectParity(r, format);
    // Nothing lands left of the selection.
    for (let y = 0; y < H; y++) for (let x = 0; x < 20; x++) expect(r.kernel.data[(y * W + x) * 4 + 3]).toBe(0);
  });

  it.each(["rgba8", "rgba32f"] as const)("painting over existing pixels (%s)", async (format) => {
    const base = format === "rgba8" ? [30, 140, 200, 180] : [0.05, 0.4, 2.5, 0.7];
    expectParity(await paintBoth(VARIANTS[5][1], format, { base }), format);
  });
});

describe("brush blend modes and per-dab colour (stroke paint layer): JS vs WASM parity", () => {
  const BASE8 = [40, 160, 220, 200];
  const BASEF = [0.02, 0.35, 0.7, 0.8];
  const modes = ["multiply", "screen", "overlay", "darken", "color", "luminosity", "behind", "clear"] as const;
  for (const format of ["rgba8", "rgba32f"] as const) {
    it.each(modes)(`%s (${format})`, async (mode) => {
      const brush = variant(mode, (b) => {
        b.blendMode = mode;
        b.tip.hardness = 40;
      })[1];
      expect(strokeLayerNeeds(brush())).not.toBeNull();
      const r = await paintBoth(brush, format, { segments: true, base: format === "rgba8" ? BASE8 : BASEF });
      expectParity(r, format);
    });
  }

  it.each(["rgba8", "rgba32f"] as const)("per-dab hue jitter (%s)", async (format) => {
    const brush = variant("hue jitter", (b) => {
      b.colorDyn.hueJitter = { jitter: 0.6, source: "random", minimum: 0, curve: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
      b.colorDyn.perStamp = true;
    })[1];
    expect(strokeLayerNeeds(brush())).toEqual({ recolor: true });
    expectParity(await paintBoth(brush, format, { segments: true }), format);
  });

  it("multiply darkens once per stroke instead of compounding over overlapping dabs", async () => {
    wasm.visible = false;
    const brush = variant("multiply", (b) => {
      b.blendMode = "multiply";
      b.tip.hardness = 100;
      b.tip.spacing = 5;
    })[1]();
    const grey = { r: 0.5, g: 0.5, b: 0.5, a: 1 };
    const renderer = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H, { fill: [200, 200, 200, 255] });
    const touched = makeTouched(W, H);
    const state = makeStrokeStampState(grey, touched, 9);
    state.strokeLayer = new StrokeLayer(W, H, false, false, null);
    const sampler = getCachedTipSampler(brush.shape);
    for (let i = 0; i < 6; i++)
      stampDot(asRenderer(renderer), layer, [layer], brush, sampler, 30 + i * 0.5, 28, 16, 100, grey, SECONDARY, null, false, state, POSE);
    state.strokeLayer.dispose();
    const i = (28 * W + 31) * 4;
    // 200 × (128/255) ≈ 100, once — not 200 × 0.5^6.
    expect(Math.abs(layer.data[i] - Math.round((200 * 128) / 255))).toBeLessThanOrEqual(1);
  });
});

describe("kernel slice-copy fallback (layer / coverage not pinned in the WASM heap)", () => {
  it("matches the JS path for a plain round brush (rgba32f: no stochastic rounding)", async () => {
    const r = await paintBoth(VARIANTS[2][1], "rgba32f", { unpinned: true });
    expect(diff(r.js.data, r.kernel.data, 1e-4, 1 / 1024).max).toBeLessThan(2e-3);
  });

  it("samples canvas-locked paper grain at canvas coordinates", async () => {
    const r = await paintBoth(VARIANTS[6][1], "rgba32f", { unpinned: true });
    expect(diff(r.js.data, r.kernel.data, 1e-4, 1 / 1024).max).toBeLessThan(2e-3);
  });
});

describe("stamp engine behaviour (JS path)", () => {
  it("a full-opacity dab reaches the colour at its centre and records the stroke bbox", () => {
    wasm.visible = false;
    const brush = VARIANTS[1][1]();
    const r = paint(brush, "rgba8");
    const i = (Math.round(20.5) * W + 20) * 4;
    expect(Array.from(r.data.subarray(i, i + 4))).toEqual([
      Math.round(PRIMARY.r * 255),
      Math.round(PRIMARY.g * 255),
      Math.round(PRIMARY.b * 255),
      255,
    ]);
    expect(r.bbox).not.toBeNull();
  });

  it("rgba32f dabs store linear light (sRGB primary is gamma-decoded)", () => {
    wasm.visible = false;
    const r = paint(VARIANTS[1][1](), "rgba32f");
    const i = (Math.round(20.5) * W + 20) * 4;
    expect(r.data[i]).toBeCloseTo(Math.pow((PRIMARY.r + 0.055) / 1.055, 2.4), 4);
    expect(r.data[i + 3]).toBeCloseTo(1, 6);
  });

  it("a stroke never exceeds its opacity, however many dabs overlap", () => {
    wasm.visible = false;
    const brush = VARIANTS[0][1]();
    brush.opacity = 40;
    const r = paint(brush, "rgba8", { segments: true });
    let maxA = 0;
    for (let i = 3; i < r.data.length; i += 4) maxA = Math.max(maxA, r.data[i]);
    expect(maxA).toBeLessThanOrEqual(Math.ceil(0.4 * 255));
    expect(maxA).toBeGreaterThanOrEqual(Math.floor(0.4 * 255) - 1);
  });

  it("is deterministic for a fixed stroke seed", () => {
    wasm.visible = false;
    const brush = VARIANTS[6][1];
    expect(Array.from(paint(brush(), "rgba8").data)).toEqual(Array.from(paint(brush(), "rgba8").data));
  });

  it("does not throw on an indexed8 layer", () => {
    // The brush tool is indexed8Unsupported; the engine must at least not
    // throw on an indexed layer.
    wasm.visible = true;
    expect(() => paint(VARIANTS[0][1](), "indexed8")).not.toThrow();
  });

  it("wet edges darken the stroke rim, not the interior, and report the dirty rect", () => {
    wasm.visible = false;
    const renderer = makeFakeRenderer(W, H);
    const layer = makeLayer("rgba8", W, H);
    const touched = makeTouched(W, H);
    const brush = VARIANTS[1][1]();
    brush.wetEdges = { enabled: true, amount: 0.8, width: 3 };
    const white = { r: 1, g: 1, b: 1, a: 1 };
    const state = makeStrokeStampState(white, touched, 1);
    stampDot(asRenderer(renderer), layer, [layer], brush, getCachedTipSampler(brush.shape), 36, 28, 20, 100, white, SECONDARY, null, false, state, POSE);
    expect(state.strokeBboxValid).toBe(true);
    const before = Array.from(layer.data);
    const { dirty } = applyStrokeWetEdges(asRenderer(renderer), layer, touched, brush, {
      lx: state.strokeBboxLx, ly: state.strokeBboxLy, rx: state.strokeBboxRx, ry: state.strokeBboxRy,
    });
    const centre = (28 * W + 36) * 4;
    const rim = (28 * W + 36 + 8) * 4;
    expect(layer.data[centre]).toBe(before[centre]);
    expect(layer.data[rim]).toBeLessThan(before[rim]);
    expect(dirty).not.toBeNull();
    expect(36 + 8 >= dirty!.lx && 36 + 8 < dirty!.rx).toBe(true);
    // Disabled: no-op.
    brush.wetEdges.enabled = false;
    expect(applyStrokeWetEdges(asRenderer(renderer), layer, touched, brush, null).dirty).toBeNull();
  });
});
