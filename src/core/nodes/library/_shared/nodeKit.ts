/** Helpers shared by node implementations. */
import type { ExecContext, ExecResult, INode, NodePorts, ParamDef, ParamSpec, PortDef } from "../../INode";
import {
  isDocumentRef,
  isLayerRef,
  isList,
  type DocumentRef,
  type LayerRef,
  type RuntimeValue,
} from "../../values";

export const floatSpec = (def: number, min?: number, max?: number, step = 0.01): ParamSpec => ({
  kind: "float",
  default: def,
  min,
  max,
  step,
});

export const colorSpec = (r: number, g: number, b: number, a = 1): ParamSpec => ({
  kind: "color",
  default: [r, g, b, a],
});

export const enumSpec = (def: string, options: readonly [string, string][]): ParamSpec => ({
  kind: "enum",
  default: def,
  options: options.map(([value, label]) => ({ value, label })),
});

export const vec2Spec = (x: number, y: number, step = 0.01): ParamSpec => ({
  kind: "vec2",
  default: [x, y],
  step,
});

/** Memoize a dynamic port set per configuration key (see `INode.ports`:
 *  the same configuration must return the same object). */
export function memoPorts(build: (key: string) => NodePorts): (key: string) => NodePorts {
  const cache = new Map<string, NodePorts>();
  return (key) => {
    let ports = cache.get(key);
    if (!ports) {
      ports = build(key);
      cache.set(key, ports);
    }
    return ports;
  };
}

export const EXEC_IN: PortDef = { id: "exec", label: "", type: "exec" };
export const EXEC_OUT: PortDef = { id: "then", label: "", type: "exec" };

/** Numeric input (0 when unconnected). */
export async function numberInput(ctx: ExecContext, id: string): Promise<number> {
  const v = await ctx.input(id);
  return typeof v === "number" ? v : 0;
}

/** Tuple input (vec2/vec3/color), falling back to `fallback`. */
export async function vectorInput(
  ctx: ExecContext,
  id: string,
  fallback: readonly number[],
): Promise<readonly number[]> {
  const v = await ctx.input(id);
  return Array.isArray(v) ? v : fallback;
}

export async function stringInput(ctx: ExecContext, id: string): Promise<string> {
  const v = await ctx.input(id);
  return typeof v === "string" ? v : "";
}

/** Layer input; throws when nothing is connected. */
export async function layerInput(ctx: ExecContext, id: string): Promise<LayerRef> {
  const v = await ctx.input(id);
  if (!isLayerRef(v)) throw new Error("No layer connected");
  return v;
}

export async function intInput(ctx: ExecContext, id: string): Promise<number> {
  return Math.round(await numberInput(ctx, id));
}

export async function boolInput(ctx: ExecContext, id: string): Promise<boolean> {
  return (await ctx.input(id)) === true;
}

/** List input's items (empty when unconnected). */
export async function listInput(ctx: ExecContext, id: string): Promise<readonly RuntimeValue[]> {
  const v = await ctx.input(id);
  return isList(v) ? v.items : [];
}

/** Document input, or null when unconnected (= the active document). */
export async function documentInput(ctx: ExecContext, id: string): Promise<DocumentRef | null> {
  const v = await ctx.input(id);
  return isDocumentRef(v) ? v : null;
}

/** Python-style index: negative counts from the end. `null` when out of range. */
export function resolveIndex(index: number, length: number): number | null {
  const i = index < 0 ? length + index : index;
  return i >= 0 && i < length ? i : null;
}

export const stringSpec = (def = "", placeholder?: string): ParamSpec => ({
  kind: "string",
  default: def,
  placeholder,
});

export const intSpec = (def: number, min?: number, max?: number): ParamSpec => ({
  kind: "int",
  default: def,
  min,
  max,
});

export const boolSpec = (def: boolean): ParamSpec => ({ kind: "bool", default: def });

/** Case-insensitive whole-string matcher for a `*` / `?` wildcard pattern;
 *  several patterns may be separated by `;` (e.g. "*.png;*.jpg"). */
export function wildcardRegExp(pattern: string): RegExp {
  const alts = (pattern.trim() || "*")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "."));
  return new RegExp(`^(?:${alts.join("|")})$`, "i");
}

// ─── Automation nodes ─────────────────────────────────────────────────────────

/** Layer input: the connected layer, or the active layer when unconnected. */
export const LAYER_IN: PortDef = { id: "layer", label: "Layer", type: "layer" };
/** Layers input: a list (or a single layer); unconnected = active layer. */
export const LAYERS_IN: PortDef = { id: "layers", label: "Layers", type: "list" };
export const LAYER_OUT: PortDef = { id: "layer", label: "Layer", type: "layer" };
export const DOCUMENT_OUT: PortDef = { id: "document", label: "Document", type: "document" };

/** Connected layer, or the active layer when the input is unconnected. */
export async function layerOrActive(ctx: ExecContext, id = "layer"): Promise<LayerRef> {
  const v = await ctx.input(id);
  if (isLayerRef(v)) return v;
  if (ctx.isConnected(id)) throw new Error("The connected value isn't a layer");
  const active = ctx.host.activeLayer();
  if (!active) throw new Error("No layer connected and no active layer");
  return active;
}

/** Optional layer input (null when unconnected). */
export async function optionalLayerInput(ctx: ExecContext, id: string): Promise<LayerRef | null> {
  const v = await ctx.input(id);
  return isLayerRef(v) ? v : null;
}

/** Layers from a list / single-layer input; unconnected = the active layer. */
export async function layersOrActive(ctx: ExecContext, id = "layers"): Promise<LayerRef[]> {
  if (!ctx.isConnected(id)) {
    const active = ctx.host.activeLayer();
    if (!active) throw new Error("No layers connected and no active layer");
    return [active];
  }
  const v = await ctx.input(id);
  const items = isList(v) ? v.items : v === undefined || v === null ? [] : [v];
  const layers = items.filter(isLayerRef);
  if (layers.length !== items.length) throw new Error("The list contains values that aren't layers");
  return layers;
}

/** Enum parameter / inline value as a string. */
export const enumParam = (ctx: ExecContext, id: string): string => String(ctx.param(id));

/**
 * Base class for automation action nodes: an exec input and output around
 * the node's data ports, and `run` returning the data outputs. Subclasses
 * declare `dataInputs` / `dataOutputs`.
 */
export abstract class ActionNode implements INode {
  abstract readonly type: string;
  abstract readonly label: string;
  abstract readonly category: string;
  readonly domains = ["automation"] as const;
  readonly description?: string;
  readonly width?: number;
  readonly params?: readonly ParamDef[];
  protected abstract readonly dataInputs: readonly PortDef[];
  protected readonly dataOutputs: readonly PortDef[] = [];
  private _inputs?: readonly PortDef[];
  private _outputs?: readonly PortDef[];

  get inputs(): readonly PortDef[] {
    return (this._inputs ??= [EXEC_IN, ...this.dataInputs]);
  }

  get outputs(): readonly PortDef[] {
    return (this._outputs ??= [EXEC_OUT, ...this.dataOutputs]);
  }

  protected abstract run(ctx: ExecContext): Promise<Readonly<Record<string, RuntimeValue>> | void>;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const outputs = await this.run(ctx);
    return outputs ? { outputs } : {};
  }
}

/** Width / height in pixels from inputs in `units` ("pixels" | "percent"
 *  of the document size), rounded and at least 1. */
export function imageSize(
  units: string,
  width: number,
  height: number,
  doc: { width: number; height: number },
): [number, number] {
  const pct = units === "percent";
  return [
    Math.max(1, Math.round(pct ? (doc.width * width) / 100 : width)),
    Math.max(1, Math.round(pct ? (doc.height * height) / 100 : height)),
  ];
}

/** Resolve an AI upscale model by id or label (empty = the first one). */
export async function upscaleModel(ctx: ExecContext, wanted: string): Promise<string> {
  const models = await ctx.host.upscaleModels();
  if (models.length === 0) throw new Error("No AI upscale models are installed");
  if (!wanted) return models[0].id;
  const w = wanted.toLowerCase();
  const hit = models.find((m) => m.id.toLowerCase() === w || m.label.toLowerCase() === w);
  if (!hit) throw new Error(`Unknown model "${wanted}" (installed: ${models.map((m) => m.id).join(", ")})`);
  return hit.id;
}
