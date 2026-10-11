/**
 * The starter brush library: a set of natural-media presets built on the
 * engine's features (pressure transfer, paper grain, sampled tips, smudge,
 * wet edges, blend modes, colour dynamics). Seeded into an empty user
 * library on first launch and addable later from the Brush Settings panel
 * (`useBrushes().addStarterBrushes`).
 *
 * Sampled tips are generated procedurally with a fixed seed, so every
 * install gets the same brushes without shipping image files.
 */
import type { Brush, BrushTipShape, DynamicCurve, DynamicSource } from "@/types";
import { identityCurve, makeDefaultBrush } from "./brushPreset";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** A dynamic driven by `source` at `jitter` strength, never below `minimum`. */
function dyn(
  source: DynamicSource,
  jitter = 1,
  minimum = 0,
  curve: { x: number; y: number }[] = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
): DynamicCurve {
  return { jitter, source, minimum, curve };
}

/** Falling curve: high input → low output (e.g. pressure → shallower grain). */
const FALLING = [
  { x: 0, y: 1 },
  { x: 1, y: 0.15 },
];

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A sampled tip from a density function over [-1, 1]² (black on transparent). */
function sampledTip(size: number, density: (u: number, v: number) => number): BrushTipShape {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      const d = Math.max(0, Math.min(1, density(u, v)));
      rgba[(y * size + x) * 4 + 3] = Math.round(d * 255);
    }
  }
  return { kind: "bitmap", bitmapRgba: rgba, bitmapWidth: size, bitmapHeight: size };
}

/** Charcoal: an irregular blob broken up by grain clumps. */
function charcoalTip(): BrushTipShape {
  const r = rng(0xc4a2c0a1);
  const grain = new Float32Array(32 * 32).map(() => r());
  const lobes = Array.from({ length: 7 }, () => [r() * 2 * Math.PI, 0.75 + r() * 0.35]);
  const sampleGrain = (u: number, v: number): number => {
    const gx = ((u + 1) / 2) * 31;
    const gy = ((v + 1) / 2) * 31;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const fx = gx - ix;
    const fy = gy - iy;
    const at = (x: number, y: number): number => grain[Math.min(31, y) * 32 + Math.min(31, x)];
    return (
      (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) +
      (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy
    );
  };
  return sampledTip(96, (u, v) => {
    const a = Math.atan2(v, u);
    let edge = 0;
    for (const [la, lr] of lobes) edge = Math.max(edge, lr * Math.max(0, Math.cos(a - la)) ** 2);
    const rr = Math.hypot(u, v) / Math.max(0.55, edge);
    const body = Math.max(0, 1 - rr * rr);
    return body * (0.35 + 0.65 * sampleGrain(u, v)) * 1.25 - 0.1;
  });
}

/** Bristles: parallel strands of varying density, tapering at both ends. */
function bristleTip(): BrushTipShape {
  const r = rng(0xb215713e);
  const strands = Array.from({ length: 34 }, () => [r() * 1.8 - 0.9, 0.35 + r() * 0.65, 0.025 + r() * 0.04]);
  return sampledTip(96, (u, v) => {
    let d = 0;
    for (const [x, s, w] of strands) d = Math.max(d, s * Math.max(0, 1 - Math.abs(u - x) / w));
    const env = Math.max(0, 1 - Math.abs(v) ** 6);
    return d * env;
  });
}

/** Leaf: a pointed ellipse with a lighter midrib. */
function leafTip(): BrushTipShape {
  return sampledTip(64, (u, v) => {
    const halfWidth = 0.55 * Math.max(0, 1 - Math.abs(v) ** 1.6);
    if (Math.abs(u) > halfWidth) return 0;
    const edge = Math.min(1, (halfWidth - Math.abs(u)) * 25);
    const rib = Math.abs(u) < 0.03 ? 0.6 : 1;
    return edge * rib;
  });
}

function preset(name: string, build: (b: Brush) => Partial<Brush>): Brush {
  const base = makeDefaultBrush(crypto.randomUUID(), name);
  return { ...base, ...build(base), name };
}

// ─── The library ────────────────────────────────────────────────────────────

/** Fresh copies of the starter brushes (new ids). */
export function makeStarterBrushes(): Brush[] {
  return [
    preset("Hard Round", (b) => ({
      tip: { ...b.tip, size: 24, hardness: 100, spacing: 6 },
      pressureSize: true,
      smoothing: { ...b.smoothing, ema: 35 },
    })),
    preset("Soft Round", (b) => ({
      tip: { ...b.tip, size: 60, hardness: 0, spacing: 8 },
      pressureSize: true,
      transfer: { opacityJitter: dyn("pressure"), flowJitter: identityCurve() },
    })),
    preset("Airbrush", (b) => ({
      tip: { ...b.tip, size: 90, hardness: 0, spacing: 6, flow: 8 },
      pressureSize: false,
      transfer: { opacityJitter: identityCurve(), flowJitter: dyn("pressure", 1, 0.1) },
      buildUp: { enabled: true, rate: 40 },
    })),
    preset("Ink Pen", (b) => ({
      tip: { ...b.tip, size: 9, hardness: 100, spacing: 4 },
      pressureSize: true,
      smoothing: { ema: 65, pullString: 0, catchUp: true },
    })),
    preset("Pencil", (b) => ({
      tip: { ...b.tip, size: 6, hardness: 70, spacing: 6 },
      pressureSize: true,
      transfer: { opacityJitter: dyn("pressure", 1, 0.12), flowJitter: identityCurve() },
      texture: { amount: 0.85, scale: 5, followBrush: false, mode: "subtract", depthJitter: identityCurve() },
      smoothing: { ...b.smoothing, ema: 30 },
    })),
    preset("Charcoal", (b) => ({
      shape: charcoalTip(),
      tip: { ...b.tip, size: 34, spacing: 10, hardness: 100 },
      pressureSize: true,
      shapeDyn: {
        sizeJitter: dyn("random", 0.25),
        angleJitter: dyn("random", 1),
        roundnessJitter: dyn("random", 0.35, 0.6),
      },
      transfer: { opacityJitter: dyn("pressure", 1, 0.45), flowJitter: identityCurve() },
      texture: { amount: 0.55, scale: 7, followBrush: false, mode: "subtract", depthJitter: dyn("pressure", 1, 0.25, FALLING) },
    })),
    preset("Bristle Oil", (b) => ({
      shape: bristleTip(),
      // Bristles run along the stroke: each streak traces a bristle.
      tip: { ...b.tip, size: 48, spacing: 4, hardness: 100, angle: Math.PI / 2 },
      pose: { ...b.pose, directionFollow: true },
      pressureSize: true,
      transfer: { opacityJitter: dyn("pressure", 1, 0.5), flowJitter: identityCurve() },
    })),
    preset("Blender", (b) => ({
      tip: { ...b.tip, size: 50, hardness: 25, spacing: 5 },
      pressureSize: true,
      transfer: { opacityJitter: dyn("pressure", 1, 0.2), flowJitter: identityCurve() },
      smudge: { enabled: true, strength: 0.8, colorRate: 0 },
    })),
    preset("Marker", (b) => ({
      tip: { ...b.tip, size: 22, hardness: 90, spacing: 5, roundness: 0.35, angle: Math.PI / 4 },
      opacity: 75,
      blendMode: "multiply",
      pressureSize: false,
    })),
    preset("Watercolor", (b) => ({
      tip: { ...b.tip, size: 70, hardness: 35, spacing: 6, flow: 25 },
      opacity: 80,
      blendMode: "multiply",
      pressureSize: true,
      wetEdges: { enabled: true, amount: 0.45, width: 6 },
      texture: { amount: 0.3, scale: 28, followBrush: false, mode: "multiply", depthJitter: identityCurve() },
    })),
    preset("Splatter", (b) => ({
      tip: { ...b.tip, size: 12, hardness: 90, spacing: 45 },
      pressureSize: false,
      scatter: { amount: 3, jitter: identityCurve(), bothAxes: true, count: 4, countJitter: dyn("random", 0.6) },
      shapeDyn: { ...b.shapeDyn, sizeJitter: dyn("random", 0.85) },
      transfer: { opacityJitter: dyn("random", 0.4), flowJitter: identityCurve() },
    })),
    preset("Foliage", (b) => ({
      shape: leafTip(),
      tip: { ...b.tip, size: 34, spacing: 55, hardness: 100 },
      pressureSize: true,
      scatter: { amount: 1.6, jitter: identityCurve(), bothAxes: true, count: 2, countJitter: identityCurve() },
      shapeDyn: {
        sizeJitter: dyn("random", 0.5),
        angleJitter: dyn("random", 1),
        roundnessJitter: identityCurve(),
      },
      colorDyn: {
        ...b.colorDyn,
        perStamp: true,
        hueJitter: dyn("random", 0.06),
        brightnessJitter: dyn("random", 0.18),
        fgBgJitter: dyn("random", 0.5),
      },
    })),
    preset("Glow", (b) => ({
      tip: { ...b.tip, size: 90, hardness: 0, spacing: 8, flow: 35 },
      blendMode: "screen",
      pressureSize: true,
    })),
  ];
}
