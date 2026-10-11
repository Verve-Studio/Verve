/**
 * `.effect` files: a shader node graph saved for reuse. Effects in the user
 * effects folder (or bundled with the app) appear under Effects → Custom
 * Effects. JSON:
 *
 *   { "format": "verve-effect", "formatVersion": 1, "graph": NodeGraph }
 *
 * The graph's `info` carries the name, author, description and version.
 */
import type { GraphArgument, GraphInfo, NodeGraph } from "@/core/nodes/graphTypes";

export const EFFECT_FORMAT = "verve-effect";
export const EFFECT_FORMAT_VERSION = 1;

export interface EffectFile {
  format: typeof EFFECT_FORMAT;
  formatVersion: number;
  graph: NodeGraph;
}

export const DEFAULT_INFO: GraphInfo = {
  name: "Custom Effect",
  author: "",
  description: "",
  version: "1.0",
};

export function serializeEffect(graph: NodeGraph): string {
  const file: EffectFile = {
    format: EFFECT_FORMAT,
    formatVersion: EFFECT_FORMAT_VERSION,
    graph: { ...graph, info: { ...DEFAULT_INFO, ...graph.info } },
  };
  return JSON.stringify(file, null, 2);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Structural check of a (possibly nested) graph read from disk. */
function graphProblem(g: unknown, where: string): string | null {
  if (!isObject(g)) return `${where} is missing`;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return `${where} has no nodes / links`;
  for (const n of g.nodes) {
    if (!isObject(n) || typeof n.id !== "string" || typeof n.type !== "string") {
      return `${where} has an invalid node`;
    }
    if (typeof n.x !== "number" || typeof n.y !== "number" || !isObject(n.params)) {
      return `${where} has an invalid node`;
    }
    if (n.body !== undefined) {
      const inner = graphProblem(n.body, `${where} › ${n.type}`);
      if (inner) return inner;
    }
  }
  for (const e of g.edges) {
    if (!isObject(e) || !isObject(e.from) || !isObject(e.to)) return `${where} has an invalid link`;
  }
  return null;
}

export type ParsedEffect = { ok: true; graph: NodeGraph } | { ok: false; error: string };

/** Parse and validate an `.effect` file's text. */
export function parseEffect(text: string): ParsedEffect {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "Not a valid effect file (bad JSON)" };
  }
  if (!isObject(data) || data.format !== EFFECT_FORMAT) {
    return { ok: false, error: "Not a Verve effect file" };
  }
  if (typeof data.formatVersion !== "number" || data.formatVersion > EFFECT_FORMAT_VERSION) {
    return { ok: false, error: "Made with a newer version of Verve" };
  }
  const problem = graphProblem(data.graph, "The graph");
  if (problem) return { ok: false, error: problem };
  const graph = data.graph as NodeGraph;
  if (graph.domain !== "shader") return { ok: false, error: "Not a shader graph" };
  // Arguments: keep well-formed entries of a known type (values are
  // re-validated against the type when used).
  const ARG_TYPES = ["float", "int", "bool", "vec2", "color"];
  const args = (Array.isArray(graph.arguments) ? graph.arguments : []).filter(
    (a: unknown): a is GraphArgument =>
      isObject(a) &&
      typeof a.id === "string" &&
      typeof a.name === "string" &&
      ARG_TYPES.includes(a.type as string) &&
      a.default !== undefined,
  );
  const info: Record<string, unknown> = isObject(graph.info) ? graph.info : {};
  const str = (k: keyof GraphInfo): string =>
    typeof info[k] === "string" ? (info[k] as string) : DEFAULT_INFO[k];
  return {
    ok: true,
    graph: {
      ...graph,
      ...(graph.arguments !== undefined && { arguments: args }),
      info: { name: str("name"), author: str("author"), description: str("description"), version: str("version") },
    },
  };
}
