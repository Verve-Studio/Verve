import { describe, expect, it } from "vitest";
import { GraphBuilder } from "@tests/fakes/nodesGraphKit";
import { compileShaderGraph, writeShaderContext } from "@/core/nodes/shaderCompiler";
import { f32v, loadWgsl, type WVal } from "@tests/fakes/nodesWgslEval";
import type { ParamValue } from "@/core/nodes/graphTypes";

/** The Noise node's Fac on a W×H canvas, as a function of the pixel. */
function clouds(
  values: Readonly<Record<string, ParamValue>>,
  w: number,
  h: number,
): (x: number, y: number) => number {
  const b = new GraphBuilder("shader");
  const n = b.add("noise", values);
  const out = b.add("layerOutput");
  b.link(n, "fac", out, "color");
  const r = compileShaderGraph(b.graph, { linear: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  writeShaderContext(r.uniforms, { width: w, height: h, layerX: 0, layerY: 0, layerWidth: w, layerHeight: h, isFloat: false });
  const slots: WVal[] = [];
  for (let i = 0; i < r.uniforms.length; i += 4) slots.push(f32v(...r.uniforms.slice(i, i + 4)));
  const program = loadWgsl(r.code, {
    globals: { ng_u: { t: "struct", f: { v: { t: "arr", items: slots } } } },
    natives: { ng_load: () => f32v(0, 0, 0, 1) },
  });
  return (x, y) => {
    const px = [x + 0.5, y + 0.5];
    const out = program.call("ng_shade", [f32v(px[0] / w, px[1] / h), f32v(...px), f32v(0, 0, 0, 1)]);
    return (out as { c: number[] }).c[0];
  };
}

/** Local minima and maxima along a row: how much fine structure there is. */
function extremaAlong(f: (x: number, y: number) => number, y: number, n: number): number {
  const v = Array.from({ length: n }, (_, x) => f(x, y));
  let count = 0;
  for (let x = 1; x < n - 1; x++) if ((v[x] - v[x - 1]) * (v[x + 1] - v[x]) < 0) count++;
  return count;
}

describe("Noise (clouds)", () => {
  it("stays in 0–1 and uses the range", () => {
    const f = clouds({}, 128, 128);
    const vals: number[] = [];
    for (let y = 0; y < 128; y += 7) for (let x = 0; x < 128; x += 7) vals.push(f(x, y));
    expect(Math.min(...vals)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...vals)).toBeLessThanOrEqual(1);
    expect(Math.max(...vals) - Math.min(...vals)).toBeGreaterThan(0.5);
    expect(vals.every(Number.isFinite)).toBe(true);
  });

  it("keeps pixel-level detail at a small scale (large features)", () => {
    const smooth = extremaAlong(clouds({ scale: 1, detail: 0 }, 256, 256), 40, 128);
    const detailed = extremaAlong(clouds({ scale: 1 }, 256, 256), 40, 128);
    expect(smooth).toBeLessThanOrEqual(2);
    expect(detailed).toBeGreaterThan(12);
  });

  it("stops adding octaves below ~2 px features", () => {
    // 64 px high at scale 1: octaves are capped at log2(64) − 1 = 5.
    const capped = clouds({ scale: 1, detail: 15 }, 64, 64);
    const five = clouds({ scale: 1, detail: 5 }, 64, 64);
    for (const [x, y] of [[3, 4], [30, 17], [50, 60]]) expect(capped(x, y)).toBeCloseTo(five(x, y), 6);
  });

  it("is in square pixel units: a wider canvas extends the pattern instead of stretching it", () => {
    const narrow = clouds({ scale: 3 }, 60, 40);
    const wide = clouds({ scale: 3 }, 120, 40);
    for (const [x, y] of [[5, 5], [33, 21], [59, 39]]) expect(wide(x, y)).toBeCloseTo(narrow(x, y), 6);
  });

  it("gives another pattern per seed", () => {
    const a = clouds({ seed: 0 }, 64, 64);
    const b = clouds({ seed: 1 }, 64, 64);
    let diff = 0;
    for (let x = 0; x < 64; x += 8) diff += Math.abs(a(x, 20) - b(x, 20));
    expect(diff / 8).toBeGreaterThan(0.05);
  });
});
