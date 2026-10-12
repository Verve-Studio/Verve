import type { ParamSpec } from "@/core/params/paramTypes";
import type {
  GraphDomain,
  GraphNode,
  NodeGraph,
  ParamValue,
  SocketDecl,
  SocketDirection,
} from "./graphTypes";
import type { AutomationHost } from "./automationHost";
import type { PassFilter } from "./shaderCompiler";
import type { RuntimeValue } from "./values";

/**
 * Value types carried by ports.
 *
 * - `exec` is control flow (automation): it orders side effects instead of
 *   carrying a value.
 * - `float` … `color` are per-pixel values in shader graphs and plain values
 *   in automation graphs. They convert into each other implicitly.
 * - `image` / `layer` are whole-buffer references; `document` is an open
 *   document (tab) in automation graphs.
 * - `list` is a dynamic array of values of any type (automation only).
 * - `any` accepts every non-exec type.
 */
export type PortType =
  | "exec"
  | "float"
  | "int"
  | "bool"
  | "vec2"
  | "vec3"
  | "color"
  | "string"
  | "image"
  | "layer"
  | "document"
  | "list"
  | "any";

export type { ParamSpec } from "@/core/params/paramTypes";

export interface PortDef {
  readonly id: string;
  readonly label: string;
  readonly type: PortType;
  /** Inputs only: when set, the port shows an inline editor while it is
   *  unconnected, and the value is stored in `GraphNode.params[id]`. */
  readonly value?: ParamSpec;
}

export interface ParamDef {
  readonly id: string;
  readonly label: string;
  readonly spec: ParamSpec;
}

// ─── Shader code generation ───────────────────────────────────────────────────

/**
 * What a node sees while the shader compiler generates WGSL for it. A shader
 * graph is a per-pixel function; every expression is evaluated for the pixel
 * being shaded. WGSL types: float/int/bool → `f32` (bools are 0/1),
 * vec2 → `vec2f`, vec3 → `vec3f`, color → `vec4f`.
 *
 * Coordinates: `uv` is 0–1 across the canvas (y down), `pixel` is canvas
 * pixels (pixel centres at .5). The layer texture being shaded is
 * canvas-sized, with the parent layer at its position.
 */
export interface ShaderContext {
  /** WGSL expression for input `id`, already converted to the port's type:
   *  the linked output, or the inline value (read from the uniform buffer,
   *  so editing it doesn't rebuild the shader). `null` when the input is
   *  unconnected and has no inline value. */
  input(id: string): string | null;
  /** Input `id` rendered in a pass of its own over the whole canvas and
   *  processed by `filter` (e.g. blurred): returns the name of a fetch
   *  function, `fn(p: vec2i) -> vec4f`, reading the result at integer
   *  canvas pixel `p` (clamped). The input's upstream nodes run once per
   *  pixel in that pass; graphs that never call this render in one pass.
   *  `null` when the input is unconnected. */
  inputPass(id: string, filter: PassFilter): string | null;
  /** Parameter value, fixed at compile time (e.g. an operation enum).
   *  Changing it rebuilds the shader. */
  param(id: string): ParamValue;
  /** A float / bool / vec2 / color parameter as a runtime uniform: use for
   *  continuous values so edits don't rebuild the shader. */
  uniform(id: string): string;
  /** Value of effect argument `id` (`NodeGraph.arguments`), as a uniform
   *  the host fills with the layer's value each frame. */
  argument(id: string): string;
  /** Floats in the uniform buffer (e.g. kernel weights): `slot` is the
   *  first `ng_u.v` index used (pass it to helpers); `at` maps a WGSL `i32`
   *  index expression to the element. */
  uniformFloats(values: readonly number[]): { slot: number; at(index: string): string };

  /** Normalized position of the pixel (0–1), `vec2f`. */
  readonly uv: string;
  /** Pixel coordinates, `vec2f`. */
  readonly pixel: string;
  /** The layer's colour at this pixel, `vec4f`. */
  readonly source: string;
  /** Canvas size in pixels, `vec2f`. */
  readonly resolution: string;
  /** Size of one pixel in UV units (1 / resolution), `vec2f`. */
  readonly texelSize: string;
  /** Parent layer's top-left (canvas pixels), `vec2f`. */
  readonly layerOrigin: string;
  /** Parent layer's size in pixels, `vec2f`. */
  readonly layerSize: string;
  /** 1.0 for float (HDR, linear) documents, else 0.0; `f32`. */
  readonly isFloat: string;
  /** Unfiltered texel fetch at integer pixel coordinates (`vec2i`
   *  expression, clamped to the canvas). Returns `vec4f`. */
  load(pixel: string): string;
  /** Name of a fetch function, `fn(p: vec2i) -> vec4f`, reading another
   *  layer of the document by name at integer canvas pixel `p` (clamped to
   *  the canvas; transparent outside the layer, or when no layer has that
   *  name). The layer's own pixels: no opacity, mask or effects. */
  layerFetch(layerName: string): string;
  /** `vec4f` expression sampling the layer at a `vec2f` UV expression
   *  (bilinear, clamped to the edge). */
  sampleLayer(uv: string): string;

  /** Add a helper function to the program once (deduplicated by `name`)
   *  and return the name to call it by. */
  helper(name: string, code: string): string;
  /** Colours are scene-linear (float document) rather than sRGB-encoded.
   *  Nodes doing perceptual maths encode/decode around it. */
  readonly linear: boolean;
  /** Output nodes only: the pixel's final colour (`vec4f` expression). */
  setResult(expr: string): void;

  // -- Statements (for nodes that emit control flow, e.g. For Loop) --------

  /** A fresh identifier based on `hint`. */
  name(hint: string): string;
  /** Bind `expr` to a new `let` of WGSL type `wgslType`; returns its name. */
  local(wgslType: string, expr: string): string;
  /** Declare a mutable `var`; returns its name. */
  variable(wgslType: string, init: string): string;
  /** Emit a statement into the current block. */
  statement(code: string): void;
  /** Emit `header { ... }`, with everything `body` emits inside the braces. */
  block(header: string, body: () => void): void;

  // -- Subgraphs ------------------------------------------------------------

  /** This node's resolved ports (dynamic / interface-derived included). */
  readonly ports: NodePorts;
  /** Interface sockets of this node's body (subgraph nodes), else []. */
  readonly sockets: readonly SocketDecl[];
  /**
   * Subgraph nodes: inline this node's body into the current block. `inputs`
   * gives a value for every output of the body's input node (fixed ports
   * like `index`, and `in`/`both` sockets by id). Returns the value linked
   * to each input of the body's output node, by id (`null` when
   * unconnected). Call it once per emitted copy (e.g. inside a loop block).
   */
  compileBody(inputs: Readonly<Record<string, string>>): Record<string, string | null>;
  /** Subgraph input node: the values handed to `compileBody`. */
  bodyInputs(): Readonly<Record<string, string>>;
  /** Subgraph output node: report the body's results. */
  setBodyOutputs(values: Readonly<Record<string, string | null>>): void;
}

/** WGSL expression per output port id. */
export type ShaderOutputs = Readonly<Record<string, string>>;

// ─── Automation execution ─────────────────────────────────────────────────────

/** What a node sees while the automation runner executes it. */
export interface ExecContext {
  /** Value of input `id`, converted to the port's type: pulled from the
   *  linked node, or the inline value. `undefined` when unconnected without
   *  an inline value. */
  input(id: string): Promise<RuntimeValue | undefined>;
  /** Parameter value. */
  param(id: string): ParamValue;
  /** Whether input `id` is linked to another node. */
  isConnected(id: string): boolean;
  /** The application the workflow drives. */
  readonly host: AutomationHost;
  /** Aborted when the user cancels the run. */
  readonly signal: AbortSignal;
  /** Workflow variables (Set / Get Variable), shared by the whole run. */
  readonly variables: Map<string, RuntimeValue>;
  /** Publish data outputs before running a branch (e.g. loop variables). */
  setOutputs(values: Readonly<Record<string, RuntimeValue>>): void;
  /** Run the chain linked to exec output `id` to completion. */
  runBranch(id: string): Promise<void>;
}

export interface ExecResult {
  /** Data output values. */
  readonly outputs?: Readonly<Record<string, RuntimeValue>>;
  /** Exec output to continue through. Omitted: the node's first exec
   *  output. `null`: stop this chain. */
  readonly next?: string | null;
}

// ─── Node ─────────────────────────────────────────────────────────────────────

export interface NodePorts {
  readonly inputs: readonly PortDef[];
  readonly outputs: readonly PortDef[];
}

/** Where a node sits, for ports / titles that depend on context. */
export interface PortScope {
  readonly node: Pick<GraphNode, "params" | "body">;
  /** The graph containing the node (null while the node is being created). */
  readonly graph: NodeGraph | null;
}

/**
 * Describes the nested graph a subgraph node owns. The owner's ports and the
 * body's boundary nodes are derived from the interface sockets stored on the
 * body (`NodeGraph.subgraph.sockets`) — see `subgraphs.ts`.
 */
export interface SubgraphSpec {
  /** Header of the body's input / output boundary nodes. */
  readonly inputTitle: string;
  readonly outputTitle: string;
  /** Label of the socket list on the owner node, e.g. "Loop values". */
  readonly socketsLabel: string;
  /** Directions and types the user may give new sockets. */
  readonly directions: readonly SocketDirection[];
  readonly types: readonly PortType[];
  /** Fixed outputs of the body's input node before the sockets (e.g. Index). */
  readonly bodyInputs?: readonly PortDef[];
  /** Fixed owner ports before the sockets (e.g. Count). */
  readonly ownerInputs?: readonly PortDef[];
  readonly ownerOutputs?: readonly PortDef[];
  /** Sockets of a newly added node. */
  readonly defaultSockets: readonly Omit<SocketDecl, "id">[];
}

/**
 * A node type. Each node lives in its own file under `library/{Category}/`
 * and is registered in `@/core/nodes/index.ts`.
 *
 * A node supports the domains listed in `domains` and implements the
 * matching method: `generateShader` for "shader", `execute` for
 * "automation" (the registry enforces this). Nodes that do pure value maths
 * (Math, Mix, …) list both.
 */
export interface INode {
  /** Unique id, stored in `GraphNode.type`. */
  readonly type: string;
  readonly label: string;
  /** Add-node menu grouping and header colour. */
  readonly category: string;
  /** Graph domains this node can be used in. */
  readonly domains: readonly GraphDomain[];
  readonly description?: string;
  /** Ports in the default configuration (see `ports` for dynamic ones). */
  readonly inputs: readonly PortDef[];
  readonly outputs: readonly PortDef[];
  readonly params?: readonly ParamDef[];
  /** Node width in graph units (the editor's default is 160). */
  readonly width?: number;
  /** At most one node of this type per graph (e.g. the shader output). */
  readonly unique?: boolean;
  /** The graph's result node (Layer Output): shader compilation starts
   *  here. Not allowed inside subgraph bodies. */
  readonly graphOutput?: boolean;
  /** Inputs that must be linked when the node is used (e.g. the output's
   *  Color): an unlinked one is a compile error, not a silent default. */
  readonly requiredInputs?: readonly string[];

  /** Present on nodes that own a nested graph (`GraphNode.body`). */
  readonly subgraph?: SubgraphSpec;
  /** Boundary node of a subgraph body (generic Subgraph Input / Output):
   *  created with the body, never added from the menu or deleted. */
  readonly boundary?: "input" | "output";

  /**
   * Ports that depend on the node's parameters (e.g. a data-type enum) or,
   * for subgraph and boundary nodes, on the body interface. Receives the
   * params with defaults filled in. Must return the same object for the
   * same configuration (memoize) — layouts are cached on it. When omitted,
   * `inputs` / `outputs` are used as-is.
   */
  ports?(params: Readonly<Record<string, ParamValue>>, scope: PortScope): NodePorts;
  /** Header text when it depends on context (boundary nodes); else `label`. */
  title?(scope: PortScope): string;

  /** Shader domain: WGSL expressions for this node's outputs. */
  generateShader?(ctx: ShaderContext): ShaderOutputs;

  /** Automation domain. Exec nodes (with exec ports) perform side effects
   *  and pick the exec output to continue through; pure nodes compute
   *  their outputs when pulled. */
  execute?(ctx: ExecContext): Promise<ExecResult | void> | ExecResult | void;
}
