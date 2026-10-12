import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import "@/core/nodes";
import {
  DEFAULT_INFO,
  EFFECT_FORMAT,
  EFFECT_FORMAT_VERSION,
  parseEffect,
  serializeEffect,
} from "@/core/effects/CustomShader/effectFile";
import { compileShaderGraph } from "@/core/nodes/shaderCompiler";
import type { NodeGraph } from "@/core/nodes/graphTypes";
import { GraphBuilder } from "@tests/fakes/nodesGraphKit";
import { shadePixel } from "@tests/fakes/nodesWgslEval";
import { REPO_ROOT } from "@tests/paths";

function sampleEffect(): NodeGraph {
  const b = new GraphBuilder({
    id: "g",
    name: "Glow",
    domain: "shader",
    nodes: [],
    edges: [],
    arguments: [{ id: "a_amt", name: "Amount", type: "float", default: 0.5, min: 0, max: 1 }],
    info: { name: "Glow", author: "Me", description: "Makes things glow", version: "2.0" },
  });
  const input = b.add("layerInput");
  const output = b.add("layerOutput");
  const inv = b.add("invert");
  b.link(input, "color", inv, "color").link(input, "a_amt", inv, "factor").link(inv, "color", output, "color");
  return b.graph;
}

const file = (graph: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ format: EFFECT_FORMAT, formatVersion: EFFECT_FORMAT_VERSION, graph, ...extra });

describe(".effect files", () => {
  it("round-trips a shader graph with its info and arguments", () => {
    const g = sampleEffect();
    const text = serializeEffect(g);
    expect(JSON.parse(text)).toMatchObject({ format: "verve-effect", formatVersion: 1 });
    expect(parseEffect(text)).toEqual({ ok: true, graph: g });
  });

  it("fills missing info with defaults (on save and on load)", () => {
    const { info: _drop, ...bare } = sampleEffect();
    expect(JSON.parse(serializeEffect(bare)).graph.info).toEqual(DEFAULT_INFO);
    const parsed = parseEffect(file({ ...bare, info: { name: 7, author: "A" } }));
    expect(parsed.ok && parsed.graph.info).toEqual({ ...DEFAULT_INFO, author: "A" });
  });

  it("keeps well-formed arguments of known types only", () => {
    const g = sampleEffect();
    const args = [
      g.arguments![0],
      { id: "x", name: "Bad type", type: "mat4", default: 0 },
      { id: "y", name: "No default", type: "float" },
      { name: "No id", type: "float", default: 1 },
      "junk",
    ];
    const parsed = parseEffect(file({ ...g, arguments: args }));
    expect(parsed.ok && parsed.graph.arguments).toEqual([g.arguments![0]]);
    // No arguments key → none added.
    const { arguments: _a, ...noArgs } = g;
    const p2 = parseEffect(file(noArgs));
    expect(p2.ok && "arguments" in p2.graph).toBe(false);
    // A non-array is dropped to an empty list.
    const p3 = parseEffect(file({ ...g, arguments: "x" }));
    expect(p3.ok && p3.graph.arguments).toEqual([]);
  });

  it("rejects bad JSON, other formats, newer versions and non-shader graphs", () => {
    expect(parseEffect("nope")).toEqual({ ok: false, error: "Not a valid effect file (bad JSON)" });
    expect(parseEffect(JSON.stringify({ format: "verve-automation", formatVersion: 1, graph: sampleEffect() }))).toEqual({
      ok: false,
      error: "Not a Verve effect file",
    });
    expect(parseEffect(file(sampleEffect(), { formatVersion: EFFECT_FORMAT_VERSION + 1 }))).toEqual({
      ok: false,
      error: "Made with a newer version of Verve",
    });
    expect(parseEffect(file({ ...sampleEffect(), domain: "automation" }))).toEqual({
      ok: false,
      error: "Not a shader graph",
    });
    expect(parseEffect(file({ ...sampleEffect(), edges: null }))).toEqual({
      ok: false,
      error: "The graph has no nodes / links",
    });
  });
});

describe("bundled effects (resources/effects)", () => {
  const dir = resolve(REPO_ROOT, "resources/effects");
  const files = readdirSync(dir).filter((f) => f.endsWith(".effect"));

  it("exist", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s parses, compiles and runs", (name) => {
    const parsed = parseEffect(readFileSync(join(dir, name), "utf8"));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.graph.info?.name.length).toBeGreaterThan(0);
    for (const linear of [false, true]) {
      const r = compileShaderGraph(parsed.graph, { linear });
      if (!r.ok) throw new Error(r.errors.map((e) => e.message).join("; "));
      expect(shadePixel(r.code, r.uniforms, { src: [0.5, 0.5, 0.5, 1] })).toHaveLength(4);
    }
  });
});
