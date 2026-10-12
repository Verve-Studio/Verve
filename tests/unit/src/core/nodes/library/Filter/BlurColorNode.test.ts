import { describe, expect, it } from "vitest";
import { GraphBuilder } from "@tests/fakes/nodesGraphKit";
import { compileShaderGraph, MAX_PASSES, writeShaderContext, type ShaderCompileResult } from "@/core/nodes/shaderCompiler";
import { f32v, loadWgsl, type NativeFn, type WVal } from "@tests/fakes/nodesWgslEval";

const W = 48;
const H = 8;

/** The layer: black left half, white right half (opaque). */
const stepLayer = (x: number): number[] => (x < W / 2 ? [0, 0, 0, 1] : [1, 1, 1, 1]);

type Ok = Extract<ShaderCompileResult, { ok: true }>;

function compile(b: GraphBuilder): Ok {
  const r = compileShaderGraph(b.graph, { linear: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  writeShaderContext(r.uniforms, { width: W, height: H, layerX: 0, layerY: 0, layerWidth: W, layerHeight: H, isFloat: false });
  return r;
}

/** Horizontal box blur of a W×H RGBA image (the host's filter, in 1D:
 *  the test images only vary along x). */
function boxBlurX(img: number[][], radius: number): number[][] {
  return img.map((_, i) => {
    const x = i % W;
    const y = Math.floor(i / W);
    const sum = [0, 0, 0, 0];
    for (let dx = -radius; dx <= radius; dx++) {
      const p = img[y * W + Math.min(W - 1, Math.max(0, x + dx))];
      for (let c = 0; c < 4; c++) sum[c] += p[c] / (2 * radius + 1);
    }
    return sum;
  });
}

/**
 * Runs a compiled graph the way the host does: every pass over the canvas
 * (then its filter, a box blur here), then `ng_shade` reading the passes.
 * Returns the output per pixel.
 */
function render(r: Ok): number[][] {
  const slots: WVal[] = [];
  for (let i = 0; i < r.uniforms.length; i += 4) slots.push(f32v(...r.uniforms.slice(i, i + 4)));
  const textures = r.passes.map((): WVal => f32v(0));
  const images: number[][][] = [];
  const natives: Record<string, NativeFn> = {
    ng_load: (args) => f32v(...stepLayer((args[0] as { c: number[] }).c[0])),
    textureDimensions: () => ({ t: "vec", k: "u", c: [W, H] }),
    textureLoad: (args) => {
      const k = textures.indexOf(args[0]);
      const [x, y] = (args[1] as { c: number[] }).c;
      return f32v(...images[k][y * W + x]);
    },
  };
  const program = loadWgsl(r.code, {
    globals: {
      ng_u: { t: "struct", f: { v: { t: "arr", items: slots } } },
      ...Object.fromEntries(textures.map((t, k) => [`ng_pass${k}`, t])),
    },
    natives,
  });
  const run = (fn: string): number[][] =>
    Array.from({ length: W * H }, (_, i) => {
      const px = [(i % W) + 0.5, Math.floor(i / W) + 0.5];
      const out = program.call(fn, [f32v(px[0] / W, px[1] / H), f32v(...px), f32v(...stepLayer(i % W))]);
      return [...(out as { c: number[] }).c];
    });
  for (const pass of r.passes) images.push(boxBlurX(run(pass.entry), pass.filter.radius));
  return run("ng_shade");
}

function blurOfLayer(radius: number): GraphBuilder {
  const b = new GraphBuilder("shader");
  const input = b.add("layerInput");
  const blur = b.add("blurColor", { radius, kind: "box" });
  const out = b.add("layerOutput");
  b.link(input, "color", blur, "color").link(blur, "color", out, "color");
  return b;
}

describe("Blur Color", () => {
  it("renders its input in a pass of its own, blurred, and reads it at the pixel", () => {
    const r = compile(blurOfLayer(4));
    expect(r.passes).toEqual([{ entry: "ng_stage0", filter: { kind: "box", radius: 4 } }]);
    const row = render(r).slice(0, W).map((p) => p[0]);
    expect(row[2]).toBeCloseTo(0, 5);
    expect(row[W - 3]).toBeCloseTo(1, 5);
    // Across the edge: a ramp 2·4 + 1 pixels wide.
    expect(row[W / 2 - 1]).toBeCloseTo(4 / 9, 5);
    expect(row[W / 2]).toBeCloseTo(5 / 9, 5);
  });

  it("costs nothing in graphs that don't use it", () => {
    const b = new GraphBuilder("shader");
    const input = b.add("layerInput");
    const out = b.add("layerOutput");
    b.link(input, "color", out, "color");
    // Present but not connected to the output: never compiled.
    const blur = b.add("blurColor");
    b.link(input, "color", blur, "color");
    const r = compile(b);
    expect(r.passes).toEqual([]);
    expect(r.code).not.toMatch(/ng_stage|ng_pass/);
  });

  it("premultiplies the pass, so transparent pixels don't darken the blur", () => {
    // Opaque red where the layer is white, transparent black where it is black.
    const b = new GraphBuilder("shader");
    const input = b.add("layerInput");
    const luminance = b.add("luminance");
    const mix = b.add("mix", { a: [0, 0, 0, 0], b: [1, 0, 0, 1] });
    const blur = b.add("blurColor", { radius: 3, kind: "box" });
    const out = b.add("layerOutput");
    b.link(input, "color", luminance, "color").link(luminance, "value", mix, "factor");
    b.link(mix, "color", blur, "color").link(blur, "color", out, "color");
    b.link(blur, "alpha", out, "alpha");
    const r = compile(b);
    const row = render(r).slice(0, W);
    // At the edge the colour stays pure red, only alpha falls off.
    const edge = row[W / 2 - 1];
    expect(edge[3]).toBeGreaterThan(0.2);
    expect(edge[3]).toBeLessThan(0.8);
    expect(edge[0]).toBeCloseTo(1, 5);
  });

  it("nests: a blur of a blur renders the inner pass first", () => {
    const b = new GraphBuilder("shader");
    const input = b.add("layerInput");
    const inner = b.add("blurColor", { radius: 2, kind: "box" });
    const outer = b.add("blurColor", { radius: 3, kind: "box" });
    const out = b.add("layerOutput");
    b.link(input, "color", inner, "color").link(inner, "color", outer, "color").link(outer, "color", out, "color");
    const r = compile(b);
    expect(r.passes.map((p) => p.filter.radius)).toEqual([2, 3]);
    // The outer pass reads the inner one; the main pass only the outer one.
    const stage1 = r.code.slice(r.code.indexOf("fn ng_stage1"), r.code.indexOf("fn ng_shade"));
    expect(stage1).toContain("ng_load_pass0");
    const main = r.code.slice(r.code.indexOf("fn ng_shade"));
    expect(main).toContain("ng_load_pass1");
    expect(main).not.toContain("ng_load_pass0");
    const row = render(r).slice(0, W).map((p) => p[0]);
    // Two box blurs (5 and 7 px wide): smoother than either alone.
    expect(row[W / 2 - 1]).toBeGreaterThan(0.3);
    expect(row[W / 2 - 1]).toBeLessThan(0.5);
    expect(row[W / 2 - 4]).toBeGreaterThan(0);
  });

  it("renders a node used by both the blur and the main pass in each", () => {
    const b = new GraphBuilder("shader");
    const input = b.add("layerInput");
    const blur = b.add("blurColor", { radius: 4, kind: "box" });
    const mix = b.add("mix");
    const out = b.add("layerOutput");
    b.link(input, "color", blur, "color");
    b.link(input, "color", mix, "a").link(blur, "color", mix, "b");
    b.link(mix, "color", out, "color");
    const row = render(compile(b)).slice(0, W).map((p) => p[0]);
    expect(row[2]).toBeCloseTo(0, 5);
    // Half the sharp black pixel, half the blurred edge.
    expect(row[W / 2 - 1]).toBeCloseTo((0 + 4 / 9) / 2, 5);
  });

  it("can't blur values from outside the loop body it sits in", () => {
    const b = new GraphBuilder("shader");
    const loop = b.add("forLoop");
    const body = b.node(loop).body!;
    const inner = new GraphBuilder(body);
    const bIn = body.nodes.find((n) => n.type === "subgraphInput")!.id;
    const bOut = body.nodes.find((n) => n.type === "subgraphOutput")!.id;
    const blur = inner.add("blurColor");
    const socket = body.subgraph!.sockets[0].id;
    inner.link(bIn, socket, blur, "color").link(blur, "color", bOut, socket);
    b.graph = { ...b.graph, nodes: b.graph.nodes.map((n) => (n.id === loop ? { ...n, body: inner.graph } : n)) };
    const out = b.add("layerOutput");
    b.link(loop, socket, out, "color");
    const r = compileShaderGraph(b.graph, { linear: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toMatch(/outside/);
  });

  it(`allows at most MAX_PASSES (${MAX_PASSES}) passes`, () => {
    const chain = (n: number) => {
      const b = new GraphBuilder("shader");
      let prev = b.add("layerInput");
      for (let i = 0; i < n; i++) {
        const blur = b.add("blurColor");
        b.link(prev, "color", blur, "color");
        prev = blur;
      }
      b.link(prev, "color", b.add("layerOutput"), "color");
      return compileShaderGraph(b.graph, { linear: false });
    };
    expect(chain(MAX_PASSES).ok).toBe(true);
    const r = chain(MAX_PASSES + 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toMatch(/at most/);
  });

  it("needs something connected to Color", () => {
    const b = new GraphBuilder("shader");
    const blur = b.add("blurColor");
    b.link(blur, "color", b.add("layerOutput"), "color");
    expect(compileShaderGraph(b.graph, { linear: false }).ok).toBe(false);
  });
});
