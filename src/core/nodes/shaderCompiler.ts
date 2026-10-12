/**
 * Shader graph → WGSL. Walks back from the output node, asks every reached
 * node for WGSL expressions via `INode.generateShader`, and binds each
 * output to a `let` in a single per-pixel function:
 *
 *   fn ng_shade(ng_uv: vec2f, ng_pixel: vec2f, ng_src: vec4f) -> vec4f
 *
 * The host shader calls it from its fragment entry point and must define
 *  - `fn ng_load(p: vec2i) -> vec4f` — texel fetch of the layer, clamped;
 *  - one texture per other layer the graph samples (`ng_layer0`, …; see
 *    `layerSourceDeclarations` and `ShaderCompileResult.layerSources`);
 *  - the uniform `ng_u` (see `uniformDeclaration`). Its first
 *    `CONTEXT_SLOTS` vec4s carry per-frame context (`writeShaderContext`);
 *    after them come inline values and uniform params, so the code only
 *    changes when the graph's structure does.
 *
 * Nodes can also emit statements and blocks (`ctx.statement`, `ctx.block`)
 * and inline their subgraph body (`ctx.compileBody`) — that is how For Loop
 * builds its loop. A body is compiled as its own graph scope: its nodes only
 * see values passed through its boundary nodes.
 *
 * A node that needs an input at other pixels (Blur Color) renders it in a
 * pass of its own (`ctx.inputPass`): the nodes upstream of that input are
 * compiled into a separate function `ng_stage{k}` (see
 * `ShaderCompileResult.passes`), which the host renders into a texture,
 * filters and binds as `ng_pass{k}`. Graphs without such nodes compile to
 * the single `ng_shade` function and render in one pass.
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

/** Most other layers one graph can sample (one texture binding each). */
export const MAX_LAYER_SOURCES = 8;

/** Most intermediate passes one graph can use. With the layer sources and
 *  the host's two textures this stays within WebGPU's default limit of 16
 *  sampled textures per shader stage. */
export const MAX_PASSES = 6;

/** How the host processes a pass's texture before the graph reads it. */
export interface PassFilter {
  readonly kind: "gaussian" | "box";
  /** Pixels; 0 = unfiltered. */
  readonly radius: number;
}

/** An intermediate pass: the host renders `entry` (same signature as
 *  `ng_shade`, premultiplied output) over the canvas, applies `filter` and
 *  binds the result as texture `ng_pass{index}`. Passes are listed in
 *  dependency order: a pass only reads earlier ones. */
export interface ShaderPass {
  readonly entry: string;
  readonly filter: PassFilter;
}

/** WGSL declarations of the pass textures, at consecutive bindings. */
export function passDeclarations(count: number, group: number, firstBinding: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(`@group(${group}) @binding(${firstBinding + i}) var ng_pass${i}: texture_2d<f32>;`);
  }
  return lines.join("\n");
}

/** Texel fetch of pass `i` at canvas pixel `p` (clamped), un-premultiplied. */
function passFetchCode(name: string, index: number): string {
  return `fn ${name}(p: vec2i) -> vec4f {
  let c = textureLoad(ng_pass${index}, clamp(p, vec2i(0, 0), vec2i(textureDimensions(ng_pass${index})) - vec2i(1, 1)), 0);
  return vec4f(select(vec3f(0.0), c.rgb / c.a, c.a > 1e-6), c.a);
}`;
}

/** Another layer a compiled graph samples, by name. The host binds the
 *  layer's texture to `ng_layer{index}` and writes `(offsetX, offsetY,
 *  present, 0)` into `ng_u.v[slot]` each frame; while `present` is 0 (no
 *  such layer) the layer reads as transparent. */
export interface LayerSource {
  readonly name: string;
  readonly slot: number;
}

/** WGSL declarations of the layer-source textures, at consecutive bindings. */
export function layerSourceDeclarations(count: number, group: number, firstBinding: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(`@group(${group}) @binding(${firstBinding + i}) var ng_layer${i}: texture_2d<f32>;`);
  }
  return lines.join("\n");
}

/** Texel fetch of layer source `i` at canvas pixel `p` (clamped to the
 *  canvas, like `ng_load`); transparent outside the layer. */
function layerFetchCode(name: string, index: number, slot: number): string {
  return `fn ${name}(p: vec2i) -> vec4f {
  let info = ng_u.v[${slot}];
  let c = clamp(p, vec2i(0, 0), vec2i(ng_u.v[0].xy) - vec2i(1, 1));
  let q = c - vec2i(info.xy);
  if (info.z == 0.0 || any(q < vec2i(0, 0)) || any(q >= vec2i(textureDimensions(ng_layer${index})))) {
    return vec4f(0.0);
  }
  return textureLoad(ng_layer${index}, q, 0);
}`;
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
      /** Other layers the shader samples; index i is texture `ng_layer{i}`. */
      layerSources: readonly LayerSource[];
      /** Intermediate passes to render before `ng_shade`; [] for most graphs. */
      passes: readonly ShaderPass[];
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
  const layerSources: LayerSource[] = [];
  const passes: ShaderPass[] = [];
  /** `fn ng_stage{k}` per pass. */
  const stageFns: string[] = [];
  /** Pass index per (node, input, filter), so a node compiled into several
   *  functions still renders its pass once. */
  const passIndex = new Map<string, number>();
  /** Fetch function of the layer named `layerName`, one per distinct name.
   *  Returns null when the graph already uses MAX_LAYER_SOURCES layers. */
  const layerFetch = (layerName: string): string | null => {
    let index = layerSources.findIndex((l) => l.name === layerName);
    if (index < 0) {
      if (layerSources.length >= MAX_LAYER_SOURCES) return null;
      index = layerSources.length;
      const slot = uniforms.length / 4;
      uniforms.push(0, 0, 0, 0);
      layerSources.push({ name: layerName, slot });
    }
    const fn = `ng_load_layer${index}`;
    return addHelper(fn, layerFetchCode(fn, index, layerSources[index].slot));
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

    let bodyResult: Record<string, string | null> = {};

    /**
     * The nodes compiled into one function (`ng_shade`, or a pass's
     * `ng_stage{k}`). Node outputs are bound in the scope's base block, so a
     * value first needed inside a nested block (e.g. a loop) is still
     * visible after it. In a pass, values from outside the body can't be
     * used: they belong to another function.
     */
    const makeScope = (base: string[], inPass: boolean) => {
      const bound = new Map<string, ShaderOutputs>();
      const visiting = new Set<string>();

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
          inputPass: (id, filter) => {
            const key = `${usedKey(path, nodeId)}:${id}:${filter.kind}:${filter.radius}`;
            let k = passIndex.get(key);
            if (k === undefined) {
              // Compile the input's upstream nodes into their own function;
              // passes they need themselves are created (and listed) first.
              const body: string[] = [];
              blocks.push(body);
              let value: string | null;
              try {
                value = makeScope(body, true).resolveInput(nodeId, id);
              } finally {
                blocks.pop();
              }
              if (value === null) return null;
              if (passes.length >= MAX_PASSES) {
                fail(nodeId, `A shader can use at most ${MAX_PASSES} blur passes`);
              }
              k = passes.length;
              const entry = `ng_stage${k}`;
              stageFns.push(
                [
                  `fn ${entry}(ng_uv: vec2f, ng_pixel: vec2f, ng_src: vec4f) -> vec4f {`,
                  ...body.map((l) => `  ${l}`),
                  `  let c: vec4f = ${value};`,
                  `  return vec4f(c.rgb * c.a, c.a);`,
                  `}`,
                ].join("\n"),
              );
              passes.push({ entry, filter });
              passIndex.set(key, k);
            }
            return addHelper(`ng_load_pass${k}`, passFetchCode(`ng_load_pass${k}`, k));
          },
          resolution: "ng_u.v[0].xy",
          texelSize: "ng_u.v[0].zw",
          layerOrigin: "ng_u.v[1].xy",
          layerSize: "ng_u.v[1].zw",
          isFloat: "ng_u.v[2].x",
          load: (p) => `ng_load(${p})`,
          layerFetch: (layerName) =>
            layerFetch(layerName) ??
            fail(nodeId, `A shader can sample at most ${MAX_LAYER_SOURCES} other layers`),
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
          bodyInputs: () => {
            if (inPass && bodyInputs) {
              fail(nodeId, "A blur inside a loop body can't use values from outside it");
            }
            return bodyInputs ?? fail(nodeId, "Only valid inside a subgraph body");
          },
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

      return { emit, resolveInput };
    };

    makeScope(current(), false).emit(sink.id);
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
    ...stageFns,
    `fn ${SHADER_ENTRY}(ng_uv: vec2f, ng_pixel: vec2f, ng_src: vec4f) -> vec4f {`,
    ...blocks[0].map((l) => `  ${l}`),
    `  return ${result};`,
    `}`,
  ].join("\n");
  return {
    ok: true,
    code,
    uniforms: new Float32Array(uniforms),
    used,
    argumentSlots,
    layerSources,
    passes,
  };
}
