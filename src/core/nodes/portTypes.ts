import type { PortType } from "./INode";

/** Wire / socket colour per port type. */
export const PORT_COLORS: Record<PortType, string> = {
  exec: "#e8e8e8",
  float: "#a1a1a1",
  int: "#4f9e52",
  bool: "#cca6d6",
  vec2: "#6c6cd6",
  vec3: "#6363c7",
  color: "#c7c729",
  string: "#70b2ff",
  image: "#d68cd6",
  layer: "#3fb68b",
  any: "#8a8a8a",
};

/** Types that convert into each other implicitly (splat / truncate /
 *  luminance), matching how shader languages and Blender behave. */
const NUMERIC: ReadonlySet<PortType> = new Set([
  "float",
  "int",
  "bool",
  "vec2",
  "vec3",
  "color",
]);

/** Can an output of type `from` feed an input of type `to`? */
export function canConnectTypes(from: PortType, to: PortType): boolean {
  if (from === "exec" || to === "exec") return from === to;
  if (from === "any" || to === "any") return true;
  if (from === to) return true;
  return NUMERIC.has(from) && NUMERIC.has(to);
}

/** Inputs normally take one link and outputs fan out. Exec flow is the
 *  reverse: an exec output continues to exactly one node, while several
 *  branches may merge into one exec input. */
export function isSingleLink(type: PortType, side: "in" | "out"): boolean {
  return type === "exec" ? side === "out" : side === "in";
}
