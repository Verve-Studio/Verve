/**
 * Every shader node, in every enum configuration, compiles inside a minimal
 * graph (Layer Input → node → Layer Output), produces the documented entry
 * point, never emits its inline values as WGSL literals, and keeps the
 * same WGSL when only inline values change. The generated program is also
 * run on the CPU (test/fakes/nodesWgslEval) to catch malformed WGSL.
 */
import { describe, expect, it } from "vitest";
import "@/core/nodes";
import { nodeRegistry } from "@/core/nodes/nodeRegistry";
import { compileShaderGraph } from "@/core/nodes/shaderCompiler";
import { nodePorts } from "@/core/nodes/graphOps";
import { wgslType } from "@/core/nodes/wgsl";
import type { INode, ParamSpec } from "@/core/nodes/INode";
import type { ParamValue } from "@/core/nodes/graphTypes";
import { GraphBuilder } from "@tests/fakes/nodesGraphKit";
import { shadePixel } from "@tests/fakes/nodesWgslEval";

const ENTRY = "fn ng_shade(ng_uv: vec2f, ng_pixel: vec2f, ng_src: vec4f) -> vec4f {";

const shaderNodes = nodeRegistry
  .forDomain("shader")
  .filter((d) => !d.boundary && !d.graphOutput && d.type !== "layerInput");

function configurations(def: INode): Record<string, ParamValue>[] {
  const out: Record<string, ParamValue>[] = [{}];
  for (const p of def.params ?? []) {
    if (p.spec.kind !== "enum") continue;
    for (const o of p.spec.options) if (o.value !== p.spec.default) out.push({ [p.id]: o.value });
  }
  return out;
}

/** A distinctive value of the spec's shape that no generator would emit
 *  as a literal on its own. Exactly representable in f32. */
function sentinel(spec: ParamSpec, i: number): number | readonly number[] | undefined {
  const x = 1234.5 + i * 2;
  switch (spec.kind) {
    case "float":
      return x;
    case "int":
      return 4321 + i;
    case "vec2":
      return [x, x + 1] as const;
    case "color":
      return [0.123046875, 0.2109375, 0.3046875, 0.7109375] as const;
    default:
      return undefined;
  }
}

interface Built {
  builder: GraphBuilder;
  nodeId: string;
}

/** Layer Input → node → Layer Output, wiring the node's first per-pixel
 *  output to the output colour. */
function build(def: INode, config: Record<string, ParamValue>): Built | null {
  const b = new GraphBuilder("shader");
  const input = b.add("layerInput");
  const id = b.add(def.type, config);
  const out = b.add("layerOutput");
  const ports = nodePorts(def, b.node(id), b.graph);
  const first = ports.outputs.find((p) => wgslType(p.type));
  if (!first) return null;
  b.link(id, first.id, out, "color");
  // Required inputs need a link; feed them the layer colour.
  for (const req of def.requiredInputs ?? []) b.link(input, "color", id, req);
  return { builder: b, nodeId: id };
}

const cases = shaderNodes.flatMap((def) =>
  configurations(def).map((c) => [`${def.type} ${JSON.stringify(c)}`, def, c] as const),
);

describe("shader node sweep", () => {
  it("covers every shader node", () => {
    expect(shaderNodes.length).toBeGreaterThan(40);
  });

  it.each(cases)("%s compiles and runs", (_name, def, config) => {
    const built = build(def, config);
    if (!built) return; // no per-pixel output (none today)
    for (const linear of [false, true]) {
      const r = compileShaderGraph(built.builder.graph, { linear });
      if (!r.ok) throw new Error(r.errors.map((e) => e.message).join("; "));
      expect(r.code).toContain(ENTRY);
      expect(r.uniforms.length % 4).toBe(0);
      expect(r.used.size).toBeGreaterThanOrEqual(2);
      const px = shadePixel(r.code, r.uniforms, {
        uv: [0.3, 0.6],
        pixel: [9.5, 19.5],
        src: [0.6, 0.4, 0.2, 1],
      });
      expect(px).toHaveLength(4);
    }
  });

  it.each(cases)("%s keeps inline values out of the WGSL", (_name, def, config) => {
    const built = build(def, config);
    if (!built) return;
    const before = compileShaderGraph(built.builder.graph, { linear: false });
    if (!before.ok) throw new Error(before.errors[0].message);

    // Set every inline input to a sentinel value.
    const ports = nodePorts(def, built.builder.node(built.nodeId), built.builder.graph);
    const sentinels: number[] = [];
    ports.inputs.forEach((p, i) => {
      const v = p.value && sentinel(p.value, i);
      if (v === undefined) return;
      built.builder.set(built.nodeId, p.id, v as ParamValue);
      if (typeof v === "number") sentinels.push(v);
      else if (Array.isArray(v)) sentinels.push(v[0] as number);
    });
    const after = compileShaderGraph(built.builder.graph, { linear: false });
    if (!after.ok) throw new Error(after.errors[0].message);

    // Same structure → identical WGSL; the values live in the uniforms.
    expect(after.code).toBe(before.code);
    for (const s of sentinels) {
      expect(after.code).not.toContain(String(s));
      expect([...after.uniforms]).toContain(s);
    }
  });
});
