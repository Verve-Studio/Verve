import { describe, expect, it } from "vitest";
import "@/core/nodes";
import {
  CONTEXT_SLOTS,
  MAX_LAYER_SOURCES,
  compileShaderGraph,
  layerSourceDeclarations,
  uniformDeclaration,
  usedKey,
  writeShaderContext,
  type ShaderCompileResult,
} from "@/core/nodes/shaderCompiler";
import { setSockets } from "@/core/nodes/graphOps";
import { MAX_LOOP_ITERATIONS } from "@/core/nodes/library/Loop/ForLoopNode";
import { SUBGRAPH_INPUT, SUBGRAPH_OUTPUT } from "@/core/nodes/subgraphs";
import type { GraphArgument, NodeGraph } from "@/core/nodes/graphTypes";
import { assembleShaderSource, LAYER_SOURCE_BINDING } from "@/core/effects/CustomShader/customShaderSource";
import { GraphBuilder } from "@tests/fakes/nodesGraphKit";
import { shadePixel } from "@tests/fakes/nodesWgslEval";

type Ok = Extract<ShaderCompileResult, { ok: true }>;

function ok(r: ShaderCompileResult): Ok {
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join("; "));
  return r;
}

function errors(r: ShaderCompileResult) {
  if (r.ok) throw new Error("expected a compile error");
  return r.errors;
}

/** Layer Input → [node] → Layer Output. */
function passThrough(): { b: GraphBuilder; input: string; output: string } {
  const b = new GraphBuilder("shader");
  const input = b.add("layerInput");
  const output = b.add("layerOutput");
  return { b, input, output };
}

const context = (uniforms: Float32Array, isFloat = false): void =>
  writeShaderContext(uniforms, {
    width: 100,
    height: 50,
    layerX: 0,
    layerY: 0,
    layerWidth: 100,
    layerHeight: 50,
    isFloat,
  });

describe("compileShaderGraph", () => {
  it("emits ng_shade(uv, pixel, src) -> vec4f returning the output colour", () => {
    const { b, input, output } = passThrough();
    b.link(input, "color", output, "color");
    const r = ok(compileShaderGraph(b.graph, { linear: false }));
    expect(r.code).toMatch(/^fn ng_shade\(ng_uv: vec2f, ng_pixel: vec2f, ng_src: vec4f\) -> vec4f \{$/m);
    expect(r.code.trimEnd().endsWith("}")).toBe(true);
    // The first CONTEXT_SLOTS vec4s are reserved and zero.
    expect([...r.uniforms.slice(0, CONTEXT_SLOTS * 4)]).toEqual(new Array(CONTEXT_SLOTS * 4).fill(0));
    expect(shadePixel(r.code, r.uniforms, { src: [0.2, 0.4, 0.6, 0.8] })).toEqual([0.2, 0.4, 0.6, 1]);
    expect(r.used).toEqual(new Set([usedKey([], input), usedKey([], output)]));
    expect(r.argumentSlots.size).toBe(0);
    expect(r.layerSources).toEqual([]);
  });

  it("runs a representative graph end to end", () => {
    const { b, input, output } = passThrough();
    const inv = b.add("invert", { factor: 1 });
    const mix = b.add("mix", { mode: "multiply", factor: 1, b: [0.5, 0.5, 0.5, 1] });
    b.link(input, "color", inv, "color").link(inv, "color", mix, "a").link(mix, "color", output, "color");
    b.link(input, "alpha", output, "alpha");
    const r = ok(compileShaderGraph(b.graph, { linear: false }));
    const px = shadePixel(r.code, r.uniforms, { src: [0.2, 0.4, 1, 0.5] });
    [0.4, 0.3, 0, 0.5].forEach((v, i) => expect(px[i]).toBeCloseTo(v, 6));
    expect(r.code).toMatchSnapshot();
  });

  it("reports a missing output node", () => {
    const b = new GraphBuilder("shader");
    b.add("layerInput");
    expect(errors(compileShaderGraph(b.graph, { linear: false }))[0]).toMatchObject({
      nodeId: null,
      path: [],
      message: "Add a Layer Output node",
    });
  });

  it("rejects a second output node", () => {
    const { b, input, output } = passThrough();
    b.link(input, "color", output, "color");
    const g = b.graph;
    const second = { ...g.nodes.find((n) => n.id === output)!, id: "second" };
    const r = compileShaderGraph({ ...g, nodes: [...g.nodes, second] }, { linear: false });
    expect(errors(r)[0]).toMatchObject({ nodeId: "second", message: "Only one output node is allowed" });
  });

  it("reports unlinked required inputs instead of using a default", () => {
    const { b, output } = passThrough();
    const e = errors(compileShaderGraph(b.graph, { linear: false }));
    expect(e).toHaveLength(1);
    expect(e[0].nodeId).toBe(output);
    expect(e[0].message).toMatch(/connect something to Color/);
  });

  it("reports cycles (built without the editor's checks)", () => {
    const { b, input, output } = passThrough();
    const m1 = b.add("math");
    const m2 = b.add("math");
    b.link(input, "alpha", m1, "a").link(m1, "result", m2, "a").link(m2, "result", output, "color");
    const g: NodeGraph = {
      ...b.graph,
      edges: [...b.graph.edges, { id: "back", from: { node: m2, port: "result" }, to: { node: m1, port: "b" } }],
    };
    expect(errors(compileShaderGraph(g, { linear: false }))[0].message).toBe("Cycle in graph");
  });

  it("rejects automation-only and unknown nodes", () => {
    const { b, output } = passThrough();
    const g = b.graph;
    const withNode = (type: string): NodeGraph => ({
      ...g,
      nodes: [...g.nodes, { id: "x", type, x: 0, y: 0, params: {} }],
      edges: [{ id: "e", from: { node: "x", port: "value" }, to: { node: output, port: "color" } }],
    });
    expect(errors(compileShaderGraph(withNode("getVariable"), { linear: false }))[0]).toMatchObject({
      nodeId: "x",
      message: "Get Variable can't be used in a shader",
    });
    expect(errors(compileShaderGraph(withNode("nope"), { linear: false }))[0]).toMatchObject({
      nodeId: "x",
      message: 'Unknown node type "nope"',
    });
  });

  it("skips nodes that don't reach the output", () => {
    const { b, input, output } = passThrough();
    const dangling = b.add("noise");
    b.link(input, "color", output, "color");
    const r = ok(compileShaderGraph(b.graph, { linear: false }));
    expect(r.used.has(usedKey([], dangling))).toBe(false);
    expect(r.code).not.toMatch(/noise/i);
  });

  it("ignores comment frames", () => {
    const { b, input, output } = passThrough();
    const inv = b.add("invert");
    b.link(input, "color", inv, "color").link(inv, "color", output, "color");
    const plain = ok(compileShaderGraph(b.graph, { linear: false }));
    const framed: NodeGraph = {
      ...b.graph,
      frames: [{ id: "f", nodeIds: [inv, input], x: 0, y: 0, width: 10, height: 10, text: "note", color: "#fff" }],
    };
    const r = ok(compileShaderGraph(framed, { linear: false }));
    expect(r.code).toBe(plain.code);
    expect([...r.uniforms]).toEqual([...plain.uniforms]);
  });

  it("keeps inline values in uniforms: x / 0 compiles and yields 0", () => {
    const { b, output } = passThrough();
    const m = b.add("math", { op: "divide", a: 1, b: 0 });
    b.link(m, "result", output, "color");
    const r = ok(compileShaderGraph(b.graph, { linear: false }));
    expect(r.code).not.toMatch(/\b1\.0 \/ 0\.0\b/);
    expect(shadePixel(r.code, r.uniforms)[0]).toBe(0);
  });

  it("decodes inline colours to linear for float documents", () => {
    const { b, output } = passThrough();
    const c = b.add("color", { color: [0.5, 0.5, 0.5, 1] });
    b.link(c, "color", output, "color");
    const srgb = ok(compileShaderGraph(b.graph, { linear: false }));
    const lin = ok(compileShaderGraph(b.graph, { linear: true }));
    expect(lin.code).toBe(srgb.code);
    expect(shadePixel(srgb.code, srgb.uniforms)[0]).toBeCloseTo(0.5, 6);
    expect(shadePixel(lin.code, lin.uniforms)[0]).toBeCloseTo(0.2140, 3);
  });

  it("exposes frame context through the reserved slots", () => {
    const { b, output } = passThrough();
    const info = b.add("documentInfo");
    b.link(info, "aspect", output, "color");
    const r = ok(compileShaderGraph(b.graph, { linear: false }));
    context(r.uniforms);
    expect([...r.uniforms.slice(0, 12)]).toEqual([100, 50, 0.01, 0.02, 0, 0, 100, 50, 0, 0, 0, 0].map(Math.fround));
    expect(shadePixel(r.code, r.uniforms)[0]).toBeCloseTo(2, 6);
  });
});

describe("Sample Layer by name", () => {
  function sampling(names: string[]): NodeGraph {
    const { b, output } = passThrough();
    let prev: string | null = null;
    for (const name of names) {
      const s = b.add("sampleLayer", { layer: name });
      if (prev) {
        const mix = b.add("mix");
        b.link(prev, "color", mix, "a").link(s, "color", mix, "b");
        prev = mix;
      } else prev = s;
    }
    b.link(prev!, "color", output, "color");
    return b.graph;
  }

  it("binds one texture per distinct layer name", () => {
    const r = ok(compileShaderGraph(sampling(["Clouds", "Mask", "Clouds"]), { linear: false }));
    expect(r.layerSources.map((l) => l.name)).toEqual(["Clouds", "Mask"]);
    expect(r.code).toContain("ng_layer0");
    expect(r.code).toContain("ng_layer1");
    expect(r.code).not.toContain("ng_layer2");
    // Each source owns a distinct uniform slot after the context slots.
    const slots = r.layerSources.map((l) => l.slot);
    expect(new Set(slots).size).toBe(2);
    for (const s of slots) expect(s).toBeGreaterThanOrEqual(CONTEXT_SLOTS);
    for (const s of slots) expect(r.code).toContain(`ng_u.v[${s}]`);
  });

  it("reads this layer when the name is empty", () => {
    const r = ok(compileShaderGraph(sampling([""]), { linear: false }));
    expect(r.layerSources).toEqual([]);
    expect(r.code).toContain("ng_load(");
  });

  it(`allows at most MAX_LAYER_SOURCES (${MAX_LAYER_SOURCES}) other layers`, () => {
    const names = Array.from({ length: MAX_LAYER_SOURCES }, (_, i) => `L${i}`);
    expect(ok(compileShaderGraph(sampling(names), { linear: false })).layerSources).toHaveLength(MAX_LAYER_SOURCES);
    const e = errors(compileShaderGraph(sampling([...names, "one too many"]), { linear: false }));
    expect(e[0].message).toMatch(new RegExp(`at most ${MAX_LAYER_SOURCES} other layers`));
  });

  it("declares the textures at consecutive bindings from 5 in the host module", () => {
    expect(LAYER_SOURCE_BINDING).toBe(5);
    expect(layerSourceDeclarations(3, 0, LAYER_SOURCE_BINDING).split("\n")).toEqual([
      "@group(0) @binding(5) var ng_layer0: texture_2d<f32>;",
      "@group(0) @binding(6) var ng_layer1: texture_2d<f32>;",
      "@group(0) @binding(7) var ng_layer2: texture_2d<f32>;",
    ]);
    expect(layerSourceDeclarations(0, 0, 5)).toBe("");
    const source = assembleShaderSource("fn ng_shade(ng_uv: vec2f, ng_pixel: vec2f, ng_src: vec4f) -> vec4f { return ng_src; }", 4, 2);
    const bindings = [...source.matchAll(/@group\(0\) @binding\((\d+)\)/g)].map((m) => Number(m[1]));
    expect(new Set(bindings).size).toBe(bindings.length);
    expect(bindings.filter((x) => x >= LAYER_SOURCE_BINDING)).toEqual([5, 6]);
  });

  it("samples the named layer at its offset and reads transparent outside it", () => {
    const r = ok(compileShaderGraph(sampling(["Other"]), { linear: false }));
    context(r.uniforms);
    const slot = r.layerSources[0].slot;
    r.uniforms.set([10, 0, 1, 0], slot * 4); // layer at (10, 0), present
    const texel = (x: number, y: number): number[] => [x / 100, y / 100, 0.5, 1];
    const natives = {
      textureDimensions: () => ({ t: "vec", k: "u", c: [20, 20] }) as const,
      textureLoad: (args: unknown[]) => {
        const q = (args[1] as { c: number[] }).c;
        return { t: "vec", k: "f", c: texel(q[0], q[1]) } as const;
      },
    };
    const at = (px: number, py: number): number[] =>
      shadePixel(r.code, r.uniforms, {
        uv: [(px + 0.5) / 100, (py + 0.5) / 50],
        pixel: [px + 0.5, py + 0.5],
        natives: natives as never,
        globals: { ng_layer0: { t: "vec", k: "f", c: [0] } },
      });
    // Canvas pixel (12, 3) is layer pixel (2, 3).
    at(12, 3).forEach((v, i) => expect(v).toBeCloseTo([0.02, 0.03, 0.5, 1][i], 5));
    // Left of the layer: transparent (rgb 0; alpha comes from the output's default 1).
    expect(at(2, 3).slice(0, 3)).toEqual([0, 0, 0]);
    // Absent layer (present = 0) reads transparent everywhere.
    r.uniforms[slot * 4 + 2] = 0;
    expect(at(12, 3).slice(0, 3)).toEqual([0, 0, 0]);
  });
});

describe("effect arguments", () => {
  const ARGS: GraphArgument[] = [
    { id: "a_amount", name: "Amount", type: "float", default: 0.75, min: 0, max: 1 },
    { id: "a_tint", name: "Tint", type: "color", default: [0.5, 0.25, 1, 1] },
    { id: "a_unused", name: "Unused", type: "vec2", default: [3, 4] },
  ];

  function graph(args: GraphArgument[] = ARGS) {
    const b = new GraphBuilder({ id: "g", name: "g", domain: "shader", nodes: [], edges: [], arguments: args });
    const input = b.add("layerInput");
    const output = b.add("layerOutput");
    const mix = b.add("mix");
    b.link(input, "a_amount", mix, "factor").link(input, "color", mix, "a").link(input, "a_tint", mix, "b");
    b.link(mix, "color", output, "color");
    return b.graph;
  }

  it("gives each argument a uniform slot holding its default", () => {
    const r = ok(compileShaderGraph(graph(), { linear: false }));
    // Layer Input exposes every argument once it is used.
    expect([...r.argumentSlots.keys()].sort()).toEqual(["a_amount", "a_tint", "a_unused"]);
    const unused = r.argumentSlots.get("a_unused")!;
    expect([...r.uniforms.slice(unused * 4, unused * 4 + 2)]).toEqual([3, 4]);
    const amount = r.argumentSlots.get("a_amount")!;
    const tint = r.argumentSlots.get("a_tint")!;
    expect(amount).toBeGreaterThanOrEqual(CONTEXT_SLOTS);
    expect(r.uniforms[amount * 4]).toBeCloseTo(0.75, 6);
    expect([...r.uniforms.slice(tint * 4, tint * 4 + 4)]).toEqual([0.5, 0.25, 1, 1]);
    expect(r.code).toContain(`ng_u.v[${amount}].x`);
  });

  it("has no argument slots when nothing reads the arguments", () => {
    const b = new GraphBuilder({ id: "g", name: "g", domain: "shader", nodes: [], edges: [], arguments: ARGS });
    const c = b.add("color");
    const output = b.add("layerOutput");
    b.link(c, "color", output, "color");
    expect(ok(compileShaderGraph(b.graph, { linear: false })).argumentSlots.size).toBe(0);
  });

  it("doesn't rebuild the shader when an argument's default changes", () => {
    const a = ok(compileShaderGraph(graph(), { linear: false }));
    const b = ok(
      compileShaderGraph(graph([{ ...ARGS[0], default: 0.1 }, ARGS[1], ARGS[2]]), { linear: false }),
    );
    expect(b.code).toBe(a.code);
    expect(b.uniforms[b.argumentSlots.get("a_amount")! * 4]).toBeCloseTo(0.1, 6);
  });

  it("writing an argument slot changes the output (per-layer values)", () => {
    const r = ok(compileShaderGraph(graph(), { linear: false }));
    const slot = r.argumentSlots.get("a_amount")!;
    r.uniforms[slot * 4] = 0;
    const src = [0.2, 0.2, 0.2, 1] as const;
    expect(shadePixel(r.code, r.uniforms, { src })[0]).toBeCloseTo(0.2, 6);
    r.uniforms[slot * 4] = 1;
    expect(shadePixel(r.code, r.uniforms, { src })[0]).toBeCloseTo(0.5, 6);
  });
});

describe("uniform helpers", () => {
  it("declares at least one slot", () => {
    expect(uniformDeclaration(0, 0, 2)).toContain("array<vec4f, 1>");
    expect(uniformDeclaration(7, 1, 3)).toContain("array<vec4f, 7>");
    expect(uniformDeclaration(7, 1, 3)).toContain("@group(1) @binding(3) var<uniform> ng_u: NgUniforms;");
  });
});

describe("For Loop", () => {
  /** For Loop whose body multiplies the carried colour by `factor`. */
  function loopGraph(count: number, factor = 0.5) {
    const { b, input, output } = passThrough();
    const loop = b.add("forLoop", { count });
    const owner = b.node(loop);
    const socket = owner.body!.subgraph!.sockets[0].id;
    b.link(input, "color", loop, socket).link(loop, socket, output, "color");
    // Edit the body: Loop Start.color → Mix(multiply by factor) → Loop End.color
    const body = new GraphBuilder(owner.body!);
    const start = owner.body!.nodes.find((n) => n.type === SUBGRAPH_INPUT)!.id;
    const end = owner.body!.nodes.find((n) => n.type === SUBGRAPH_OUTPUT)!.id;
    const mul = body.add("mix", { mode: "multiply", factor: 1, b: [factor, factor, factor, 1] });
    body.link(start, socket, mul, "a").link(mul, "color", end, socket);
    b.graph = {
      ...b.graph,
      nodes: b.graph.nodes.map((n) => (n.id === loop ? { ...n, body: body.graph } : n)),
    };
    return { b, loop, socket, mul };
  }

  it("compiles its body into a loop that carries values", () => {
    const { b, loop, mul } = loopGraph(3);
    const r = ok(compileShaderGraph(b.graph, { linear: false }));
    expect(r.code).toMatch(/for \(var i\d+: i32 = 0;/);
    expect(r.used.has(usedKey([loop], mul))).toBe(true);
    const px = shadePixel(r.code, r.uniforms, { src: [0.8, 0.4, 1, 1] });
    [0.1, 0.05, 0.125].forEach((v, i) => expect(px[i]).toBeCloseTo(v, 6));
  });

  it("clamps the count to [0, MAX_LOOP_ITERATIONS]", () => {
    const zero = loopGraph(-5);
    const r = ok(compileShaderGraph(zero.b.graph, { linear: false }));
    expect(shadePixel(r.code, r.uniforms, { src: [0.8, 0.4, 1, 1] }).slice(0, 3)).toEqual([0.8, 0.4, 1]);
    expect(r.code).toContain(`, 0, ${MAX_LOOP_ITERATIONS})`);
  });

  it("keeps the count out of the WGSL (uniform)", () => {
    const { b, loop } = loopGraph(3);
    const a = ok(compileShaderGraph(b.graph, { linear: false }));
    b.set(loop, "count", 7);
    const c = ok(compileShaderGraph(b.graph, { linear: false }));
    expect(c.code).toBe(a.code);
    const px = shadePixel(c.code, c.uniforms, { src: [1, 1, 1, 1] });
    expect(px[0]).toBeCloseTo(0.5 ** 7, 6);
  });

  it("reports errors inside the body with the owner path", () => {
    const { b, loop } = loopGraph(2);
    const owner = b.node(loop);
    const bad = { ...owner.body!, nodes: [...owner.body!.nodes, { id: "bodyOut", type: "layerOutput", x: 0, y: 0, params: {} }] };
    const g = { ...b.graph, nodes: b.graph.nodes.map((n) => (n.id === loop ? { ...n, body: bad } : n)) };
    expect(errors(compileShaderGraph(g, { linear: false }))[0]).toMatchObject({
      path: [loop],
      nodeId: "bodyOut",
      message: "Output nodes can't be used inside a subgraph",
    });
  });

  it("loops nothing when all sockets are removed", () => {
    const { b, loop } = loopGraph(2);
    const g = setSockets(b.graph, loop, []);
    // The output's colour link came from the removed socket.
    expect(errors(compileShaderGraph(g, { linear: false }))[0].message).toMatch(/connect something to Color/);
  });
});
