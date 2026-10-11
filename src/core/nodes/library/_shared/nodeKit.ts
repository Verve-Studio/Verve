/** Helpers shared by node implementations. */
import type { ExecContext, NodePorts, ParamSpec, PortDef } from "../../INode";
import { isLayerRef, type LayerRef } from "../../values";

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
