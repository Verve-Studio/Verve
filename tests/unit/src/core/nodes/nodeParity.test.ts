/**
 * Value nodes listed in both domains must give the same result in the
 * automation path (`execute`) and in the shader path (compiled WGSL, run
 * on the CPU by test/fakes/nodesWgslEval).
 *
 * The automation side runs `execute` with an ExecContext that resolves
 * inputs exactly like the runner (`convertValue` to the port's type); the
 * shader side compiles a real graph whose inline values / feeder nodes
 * carry the same inputs.
 */
import { describe, expect, it } from "vitest";
import "@/core/nodes";
import { nodeRegistry } from "@/core/nodes/nodeRegistry";
import { compileShaderGraph, writeShaderContext } from "@/core/nodes/shaderCompiler";
import { nodePorts, paramValue } from "@/core/nodes/graphOps";
import { convertValue, type RuntimeValue } from "@/core/nodes/values";
import { wgslType } from "@/core/nodes/wgsl";
import type { ExecContext, INode, PortDef, PortType } from "@/core/nodes/INode";
import type { ParamValue } from "@/core/nodes/graphTypes";
import { GraphBuilder } from "@tests/fakes/nodesGraphKit";
import { shadePixel } from "@tests/fakes/nodesWgslEval";
import { FakeAutomationHost } from "@tests/fakes/nodesAutomationHost";

const DOC = { width: 64, height: 32 };

type Inputs = Record<string, RuntimeValue>;

// ─── Deterministic inputs ─────────────────────────────────────────────────────

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

const SPECIAL_FLOATS = [0, 1, -1, 0.25, 2, -0.75, 3.125, 0.0625];

function sample(type: PortType, r: () => number): RuntimeValue {
  const f = (): number => {
    const x = r();
    return x < 0.35 ? SPECIAL_FLOATS[Math.floor(r() * SPECIAL_FLOATS.length)] : (r() - 0.4) * 6;
  };
  switch (type) {
    case "float":
      return f();
    case "int":
      return Math.floor(r() * 9) - 4;
    case "bool":
      return r() < 0.5;
    case "vec2":
      return [f(), f()];
    case "vec3":
      return [r(), r(), r()];
    case "color":
      return [r(), r(), r(), r() < 0.3 ? 1 : r()];
    default:
      throw new Error(`no sampler for ${type}`);
  }
}

// ─── Both paths ───────────────────────────────────────────────────────────────

/** Feeder node for an input without an inline editor. */
function feed(b: GraphBuilder, type: PortType, v: RuntimeValue): [string, string] {
  switch (type) {
    case "float":
    case "int":
    case "bool":
      return [b.add("value", { value: Number(convertValue(v, "float")) }), "value"];
    case "vec2": {
      const [x, y] = convertValue(v, "vec2") as number[];
      return [b.add("combineXy", { x, y }), "vector"];
    }
    default: {
      const c = convertValue(v, "color") as number[];
      return [b.add("color", { color: [c[0], c[1], c[2], c[3]] }), "color"];
    }
  }
}

function toParam(v: RuntimeValue, type: PortType): ParamValue {
  const c = convertValue(v, type);
  if (typeof c === "number" || typeof c === "boolean" || typeof c === "string") return c;
  if (Array.isArray(c) && (c.length === 2 || c.length === 4)) return c as unknown as ParamValue;
  throw new Error(`can't inline ${JSON.stringify(c)} as ${type}`);
}

/** Shader result for output `out` (as plain numbers). */
function viaShader(def: INode, config: Record<string, ParamValue>, inputs: Inputs, out: PortDef): number[] {
  const b = new GraphBuilder("shader");
  const id = b.add(def.type, config);
  for (const p of nodePorts(def, b.node(id), b.graph).inputs) {
    if (!(p.id in inputs)) continue;
    if (p.value) b.set(id, p.id, toParam(inputs[p.id], p.type));
    else {
      const [src, port] = feed(b, p.type, inputs[p.id]);
      b.link(src, port, id, p.id);
    }
  }
  const output = b.add("layerOutput");
  b.link(id, out.id, output, "color");
  if (out.type === "color") {
    const sep = b.add("separateRgba");
    b.link(id, out.id, sep, "color").link(sep, "a", output, "alpha");
  }
  const r = compileShaderGraph(b.graph, { linear: false });
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join("; "));
  writeShaderContext(r.uniforms, {
    ...DOC,
    layerX: 0,
    layerY: 0,
    layerWidth: DOC.width,
    layerHeight: DOC.height,
    isFloat: false,
  });
  const px = shadePixel(r.code, r.uniforms, { uv: [0.25, 0.75], pixel: [16.5, 24.5] });
  const n = { vec2: 2, vec3: 3, color: 4 }[out.type as string] ?? 1;
  return px.slice(0, n);
}

/** Automation result (all outputs), normalised to numbers. */
async function viaAutomation(
  def: INode,
  config: Record<string, ParamValue>,
  inputs: Inputs,
): Promise<Record<string, number[]>> {
  const b = new GraphBuilder("automation");
  const id = b.add(def.type, config);
  const node = b.node(id);
  const ports = nodePorts(def, node, b.graph);
  const host = new FakeAutomationHost({ width: DOC.width, height: DOC.height });
  const ctx: ExecContext = {
    input: async (pid) => {
      const port = ports.inputs.find((p) => p.id === pid);
      if (!port || port.type === "exec") return undefined;
      if (pid in inputs) return convertValue(inputs[pid], port.type);
      if (!port.value) return undefined;
      return convertValue(paramValue(def, node, pid, b.graph) as RuntimeValue, port.type);
    },
    param: (pid) => paramValue(def, node, pid, b.graph),
    isConnected: (pid) => pid in inputs,
    host,
    signal: new AbortController().signal,
    variables: new Map(),
    setOutputs: () => {},
    runBranch: async () => {},
  };
  const res = (await def.execute!(ctx)) ?? {};
  const outs: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(res.outputs ?? {})) {
    if (typeof v === "boolean") outs[k] = [v ? 1 : 0];
    else if (typeof v === "number") outs[k] = [v];
    else if (Array.isArray(v)) outs[k] = [...v];
  }
  return outs;
}

function close(a: number, b: number): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) <= 1e-5 + 1e-5 * Math.max(Math.abs(a), Math.abs(b));
}

// ─── Cases ────────────────────────────────────────────────────────────────────

const dual = nodeRegistry
  .forDomain("shader")
  .filter((d) => d.domains.includes("automation"))
  .sort((a, b) => a.type.localeCompare(b.type));

/** Inputs where the shader result is undefined by WGSL (GPU-dependent),
 *  and the outputs that are automation-only by design. */
const UNDEFINED_ON_GPU: Record<string, (op: string, i: Inputs) => boolean> = {
  // pow(x, y) is exp2(y·log2 x): undefined for x ≤ 0; atan2(0, 0) too.
  math: (op, i) =>
    (op === "power" && Number(i.a) <= 0) || (op === "atan2" && i.a === 0 && i.b === 0),
};
const AUTOMATION_ONLY_OUTPUTS: Record<string, readonly string[]> = {
  // The shader has no "unsaved" state.
  documentInfo: ["dirty"],
};

function configsOf(def: INode): Record<string, ParamValue>[] {
  const out: Record<string, ParamValue>[] = [];
  const enums = (def.params ?? []).filter((p) => p.spec.kind === "enum");
  if (enums.length === 0) return [{}];
  for (const p of enums) {
    if (p.spec.kind !== "enum") continue;
    for (const o of p.spec.options) out.push({ [p.id]: o.value });
  }
  // Bool params (e.g. Map Range's clamp) both ways.
  for (const p of def.params ?? []) if (p.spec.kind === "bool") out.push({ [p.id]: !p.spec.default });
  return out;
}

const cases = dual.flatMap((def) =>
  configsOf(def).map((config) => [`${def.type} ${JSON.stringify(config)}`, def, config] as const),
);

describe("shader / automation parity", () => {
  it("covers every node listed in both domains", () => {
    expect(dual.map((d) => d.type)).toEqual(
      expect.arrayContaining(["math", "mix", "clamp", "mapRange", "ifElse", "vectorMath", "hueSaturation"]),
    );
  });

  it.each(cases)("%s", async (_name, def, config) => {
    const shaderable = (p: PortDef): boolean => wgslType(p.type) !== null;
    const b = new GraphBuilder("shader");
    const ports = nodePorts(def, b.node(b.add(def.type, config)), b.graph);
    // Nodes whose data type has no shader form (If / Else on text) are
    // automation-only in that configuration.
    if (!ports.outputs.some(shaderable)) return;
    const outputs = ports.outputs.filter(
      (p) => shaderable(p) && !(AUTOMATION_ONLY_OUTPUTS[def.type] ?? []).includes(p.id),
    );
    const op = String(config.op ?? "");
    const r = rng(def.type.length * 7919 + JSON.stringify(config).length);
    let compared = 0;
    for (let n = 0; n < 24; n++) {
      const inputs: Inputs = {};
      for (const p of ports.inputs) if (shaderable(p)) inputs[p.id] = sample(p.type, r);
      if (UNDEFINED_ON_GPU[def.type]?.(op, inputs)) continue;
      const auto = await viaAutomation(def, config, inputs);
      for (const out of outputs) {
        const shader = viaShader(def, config, inputs, out);
        const expected = auto[out.id];
        expect(expected, `${out.id} missing from automation outputs`).toBeDefined();
        const ok = shader.length === expected.length && shader.every((x, i) => close(x, expected[i]));
        if (!ok) {
          throw new Error(
            `${out.id}: shader ${JSON.stringify(shader)} ≠ automation ${JSON.stringify(expected)} for ${JSON.stringify(inputs)}`,
          );
        }
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(0);
  });

  // WGSL `round` is half-to-even; the shader path rounds half up like Math.round.
  it("Math Round agrees on exact halves", async () => {
    const def = nodeRegistry.get("math")!;
    for (const a of [0.5, 2.5, -1.5]) {
      const auto = await viaAutomation(def, { op: "round" }, { a, b: 0 });
      const shader = viaShader(def, { op: "round" }, { a, b: 0 }, { id: "result", label: "", type: "float" });
      expect(shader[0]).toBe(auto.result[0]);
    }
  });

  it("Math Snap agrees on exact halves", async () => {
    const def = nodeRegistry.get("math")!;
    const inputs = { a: 1, b: 2 }; // 1 / 2 = 0.5 → rounds up → 2
    const auto = await viaAutomation(def, { op: "snap" }, inputs);
    const shader = viaShader(def, { op: "snap" }, inputs, { id: "result", label: "", type: "float" });
    expect(shader[0]).toBe(auto.result[0]);
  });
});
