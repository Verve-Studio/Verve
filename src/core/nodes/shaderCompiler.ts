/**
 * Shader graph → WGSL. Walks back from the output node, asks every reached
 * node for WGSL expressions via `INode.generateShader`, and binds each
 * output to a `let` in a single per-pixel function:
 *
 *   fn ng_shade(ng_uv: vec2f, ng_pixel: vec2f, ng_src: vec4f) -> vec4f
 *
 * The host shader calls it from its fragment entry point and must define
 *  - `fn ng_load(p: vec2i) -> vec4f` — texel fetch of the layer, clamped;
 *  - the uniform `ng_u` (see `uniformDeclaration`). Its first
 *    `CONTEXT_SLOTS` vec4s carry per-frame context (`writeShaderContext`);
 *    after them come inline values and uniform params, so the code only
 *    changes when the graph's structure does.
 *
 * Nodes can also emit statements and blocks (`ctx.statement`, `ctx.block`)
 * and inline their subgraph body (`ctx.compileBody`) — that is how For Loop
 * builds its loop. A body is compiled as its own graph scope: its nodes only
 * see values passed through its boundary nodes.
 */
import type { GraphEdge, GraphNode, NodeGraph, ParamValue } from "./graphTypes";
import type { INode, PortDef, ShaderContext, ShaderOutputs } from "./INode";
import { nodePorts, paramValue } from "./graphOps";
import { nodeRegistry } from "./nodeRegistry";
import { registerSampler } from "./wgslSampling";
import { convertExpr, ident, packValue, wgslType } from "./wgsl";

export const SHADER_ENTRY = "ng_shade";

/** vec4 slots at the start of `ng_u` reserved for frame context:
 *   v[0] = (canvas width, height, 1/width, 1/height)
 *   v[1] = (layer x, layer y, layer width, layer height)  — canvas pixels
 *   v[2] = (isFloat, 0, 0, 0) */
export const CONTEXT_SLOTS = 3;

export interface ShaderFrameContext {
  width: number;
  height: number;
  layerX: number;
  layerY: number;
  layerWidth: number;
  layerHeight: number;
  isFloat: boolean;
}

/** Fill the context slots of a compiled graph's uniform values. */
export function writeShaderContext(uniforms: Float32Array, c: ShaderFrameContext): void {
  uniforms.set(
    [
      c.width, c.height, 1 / c.width, 1 / c.height,
      c.layerX, c.layerY, c.layerWidth, c.layerHeight,
      c.isFloat ? 1 : 0, 0, 0, 0,
    ],
    0,
  );
}

/** WGSL declaration of the value uniform for a compiled graph. */
export function uniformDeclaration(slots: number, group: number, binding: number): string {
  return `struct NgUniforms { v: array<vec4f, ${Math.max(1, slots)}> }
@group(${group}) @binding(${binding}) var<uniform> ng_u: NgUniforms;`;
}

export interface ShaderCompileOptions {
  /** The target is scene-linear (float document): colour values are
   *  decoded from sRGB and nodes see `ctx.linear`. */
  linear: boolean;
}

export interface ShaderCompileError {
  /** Owner node ids from the root graph down to the graph containing
   *  `nodeId` ([] = the root graph). */
  path: readonly string[];
  nodeId: string | null;
  message: string;
}

export type ShaderCompileResult =
  | {
      ok: true;
      code: string;
      /** `vec4f` slots for `ng_u.v`, 4 floats each. The first
       *  `CONTEXT_SLOTS` are zero; fill them per frame. */
      uniforms: Float32Array;
      /** Nodes that contribute to the output, as `usedKey(path, id)`. */
      used: ReadonlySet<string>;
      /** `ng_u.v` slot of each argument the shader reads (filled with the
       *  default; overwrite with the layer's value per frame). */
      argumentSlots: ReadonlyMap<string, number>;
    }
  | { ok: false; errors: ShaderCompileError[] };

class CompileError extends Error {
  constructor(
    readonly path: readonly string[],
    readonly nodeId: string | null,
    message: string,
  ) {
    super(message);
  }
}

/** Key of a node in `ShaderCompileResult.used`. */
export function usedKey(path: readonly string[], nodeId: string): string {
  return `${path.join("/")}|${nodeId}`;
}

export function compileShaderGraph(
  graph: NodeGraph,
  options: ShaderCompileOptions,
): ShaderCompileResult {
  const helpers = new Map<string, string>();
  const addHelper = (name: string, code: string): string => {
    if (!helpers.has(name)) helpers.set(name, code);
    return name;
  };
  const uniforms: number[] = new Array(CONTEXT_SLOTS * 4).fill(0);
  let counter = 0;
  let result: string | null = null;
  const used = new Set<string>();
  const argumentSlots = new Map<string, number>();
  /** Uniform expression of argument `id` (one slot per argument). */
  const argumentExpr = (id: string): string | null => {
    const arg = graph.arguments?.find((a) => a.id === id);
    if (!arg) return null;
    const packed = packValue(arg.default, options.linear);
    if (!packed) return null;
    let slot = argumentSlots.get(id);
    if (slot === undefined) {
      slot = uniforms.length / 4;
      uniforms.push(...packed.data);
      argumentSlots.set(id, slot);
    }
    return `ng_u.v[${slot}]${packed.swizzle}`;
  };
  /** Statement buffers: the innermost open block is last. */
  const blocks: string[][] = [[]];
  const current = (): string[] => blocks[blocks.length - 1];

  const uniformExpr = (value: ParamValue, to: PortDef["type"]): string | null => {
    const packed = packValue(value, options.linear);
    if (!packed) return null;
    const slot = uniforms.length / 4;
    uniforms.push(...packed.data);
    return convertExpr(`ng_u.v[${slot}]${packed.swizzle}`, packed.type, to);
  };

  /**
   * Compile one graph scope — the root, or a body inlined at the current
   * block. For a body, returns what its output node received.
   */
  const compileGraph = (
    g: NodeGraph,
    path: readonly string[],
    bodyInputs: Readonly<Record<string, string>> | null,
  ): Record<string, string | null> => {
    const fail = (nodeId: string | null, message: string): never => {
      throw new CompileError(path, nodeId, message);
    };
    const nodes = new Map(g.nodes.map((n) => [n.id, n]));
    const incoming = new Map<string, GraphEdge>();
    for (const e of g.edges) incoming.set(`${e.to.node}:${e.to.port}`, e);
    const lookup = (id: string): [GraphNode, INode] => {
      const node = nodes.get(id);
      const def = node && nodeRegistry.get(node.type);
      if (!node || !def) return fail(id, `Unknown node type "${node?.type}"`);
      return [node, def];
    };

    // The sink: a body's output boundary node, or the graph's output node.
    const outputs = g.nodes.filter((n) => nodeRegistry.get(n.type)?.graphOutput);
    const boundaryOut = g.nodes.find((n) => nodeRegistry.get(n.type)?.boundary === "output");
    let sink: GraphNode;
    if (bodyInputs) {
      if (outputs.length > 0) fail(outputs[0].id, "Output nodes can't be used inside a subgraph");
      sink = boundaryOut ?? fail(null, "The body has no output node");
    } else {
      if (outputs.length > 1) fail(outputs[1].id, "Only one output node is allowed");
      sink = outputs[0] ?? fail(null, "Add a Layer Output node");
    }

    // Node outputs are bound in this scope's base block, so a value first
    // needed inside a nested block (e.g. a loop) is still visible after it.
    const base = current();
    const bound = new Map<string, ShaderOutputs>();
    const visiting = new Set<string>();
    let bodyResult: Record<string, string | null> = {};

    const resolveInput = (nodeId: string, portId: string): string | null => {
      const [node, def] = lookup(nodeId);
      const port = nodePorts(def, node, g).inputs.find((p) => p.id === portId);
      if (!port) return null;
      const edge = incoming.get(`${nodeId}:${portId}`);
      if (edge) {
        const expr = emit(edge.from.node)[edge.from.port];
        const [srcNode, srcDef] = lookup(edge.from.node);
        const outPort = nodePorts(srcDef, srcNode, g).outputs.find((p) => p.id === edge.from.port);
        if (!expr || !outPort) {
          return fail(edge.from.node, `${srcDef.label} has no shader value for "${edge.from.port}"`);
        }
        return convertExpr(expr, outPort.type, port.type);
      }
      // Inline values are uniforms, never literals: besides not rebuilding
      // the shader on every edit, WGSL would constant-fold literal-only
      // expressions and reject e.g. `1.0 / 0.0` at compile time.
      if (!port.value) return null;
      return uniformExpr(paramValue(def, node, portId, g), port.type);
    };

    const emit = (nodeId: string): ShaderOutputs => {
      const done = bound.get(nodeId);
      if (done) return done;
      if (visiting.has(nodeId)) fail(nodeId, "Cycle in graph");
      const [node, def] = lookup(nodeId);
      const generate = def.domains.includes("shader") ? def.generateShader : undefined;
      if (!generate) return fail(nodeId, `${def.label} can't be used in a shader`);
      visiting.add(nodeId);
      const ports = nodePorts(def, node, g);
      for (const id of def.requiredInputs ?? []) {
        if (!incoming.has(`${nodeId}:${id}`)) {
          const label = ports.inputs.find((p) => p.id === id)?.label ?? id;
          fail(nodeId, `${def.label}: connect something to ${label}`);
        }
      }
      used.add(usedKey(path, nodeId));
      const name = (hint: string): string => `${ident(hint)}${counter++}`;

      const ctx: ShaderContext = {
        input: (id) => resolveInput(nodeId, id),
        param: (id) => paramValue(def, node, id, g),
        uniform: (id) => {
          const value = paramValue(def, node, id, g);
          const spec = def.params?.find((p) => p.id === id)?.spec;
          const type = spec?.kind === "color" ? "color" : spec?.kind === "vec2" ? "vec2" : "float";
          return uniformExpr(value, type) ?? fail(nodeId, `Parameter "${id}" has no shader value`);
        },
        argument: (id) =>
          argumentExpr(id) ?? fail(nodeId, `Unknown argument "${id}"`),
        uniformFloats: (values) => {
          const slot = uniforms.length / 4;
          uniforms.push(...values);
          while (uniforms.length % 4 !== 0) uniforms.push(0);
          return { slot, at: (i) => `ng_u.v[${slot} + (${i}) / 4][(${i}) % 4]` };
        },
        uv: "ng_uv",
        pixel: "ng_pixel",
        source: "ng_src",
        resolution: "ng_u.v[0].xy",
        texelSize: "ng_u.v[0].zw",
        layerOrigin: "ng_u.v[1].xy",
        layerSize: "ng_u.v[1].zw",
        isFloat: "ng_u.v[2].x",
        load: (p) => `ng_load(${p})`,
        sampleLayer: (uv) => `${registerSampler(addHelper, "bilinear", "clamp")}(${uv})`,
        helper: addHelper,
        linear: options.linear,
        setResult: (expr) => {
          result = expr;
        },

        name,
        local: (type, expr) => {
          const n = name("l");
          current().push(`let ${n}: ${type} = ${expr};`);
          return n;
        },
        variable: (type, init) => {
          const n = name("v");
          current().push(`var ${n}: ${type} = ${init};`);
          return n;
        },
        statement: (code) => {
          current().push(code);
        },
        block: (header, body) => {
          const inner: string[] = [];
          blocks.push(inner);
          try {
            body();
          } finally {
            blocks.pop();
          }
          current().push(`${header} {`, ...inner.map((l) => `  ${l}`), `}`);
        },

        ports,
        sockets: node.body?.subgraph?.sockets ?? [],
        compileBody: (inputs) => {
          if (!node.body) return fail(nodeId, `${def.label} has no body`);
          return compileGraph(node.body, [...path, nodeId], inputs);
        },
        bodyInputs: () => bodyInputs ?? fail(nodeId, "Only valid inside a subgraph body"),
        setBodyOutputs: (values) => {
          bodyResult = { ...values };
        },
      };

      // A node's own statements go to its scope's base block (even when it
      // is first needed inside another node's open block); only the blocks
      // it opens itself nest inside that.
      let out: ShaderOutputs;
      blocks.push(base);
      try {
        out = generate.call(def, ctx);
      } catch (err) {
        if (err instanceof CompileError) throw err;
        return fail(nodeId, err instanceof Error ? err.message : String(err));
      } finally {
        blocks.pop();
      }

      // Bind each output to a let so downstream nodes reuse it.
      const names: Record<string, string> = {};
      for (const p of ports.outputs) {
        const expr = out[p.id];
        const type = wgslType(p.type);
        if (!expr || !type) continue;
        const n = name(`n_${p.id}_`);
        base.push(`let ${n}: ${type} = ${expr};`);
        names[p.id] = n;
      }
      visiting.delete(nodeId);
      bound.set(nodeId, names);
      return names;
    };

    emit(sink.id);
    return bodyResult;
  };

  try {
    compileGraph(graph, [], null);
  } catch (err) {
    const e = err instanceof CompileError ? err : new CompileError([], null, String(err));
    return { ok: false, errors: [{ path: e.path, nodeId: e.nodeId, message: e.message }] };
  }
  if (result === null) {
    return {
      ok: false,
      errors: [{ path: [], nodeId: null, message: "Output node produced no colour" }],
    };
  }

  const code = [
    ...helpers.values(),
    `fn ${SHADER_ENTRY}(ng_uv: vec2f, ng_pixel: vec2f, ng_src: vec4f) -> vec4f {`,
    ...blocks[0].map((l) => `  ${l}`),
    `  return ${result};`,
    `}`,
  ].join("\n");
  return { ok: true, code, uniforms: new Float32Array(uniforms), used, argumentSlots };
}
