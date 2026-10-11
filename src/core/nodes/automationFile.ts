/**
 * `.automation` files: an automation workflow (node graph) saved to disk,
 * opened from the startup screen or the node editor's Automation tab. JSON:
 *
 *   { "format": "verve-automation", "formatVersion": 1, "graph": NodeGraph }
 *
 * Bump `AUTOMATION_FORMAT_VERSION` when the shape changes incompatibly.
 */
import type { NodeGraph } from "./graphTypes";
import { graphStructureProblem, isObject } from "./graphFile";

export const AUTOMATION_FORMAT = "verve-automation";
export const AUTOMATION_FORMAT_VERSION = 1;
export const AUTOMATION_EXTENSION = "automation";

export function serializeAutomation(graph: NodeGraph): string {
  return JSON.stringify(
    { format: AUTOMATION_FORMAT, formatVersion: AUTOMATION_FORMAT_VERSION, graph },
    null,
    2,
  );
}

export type ParsedAutomation = { ok: true; graph: NodeGraph } | { ok: false; error: string };

/** Parse and validate an `.automation` file's text. */
export function parseAutomation(text: string): ParsedAutomation {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "Not a valid automation file (bad JSON)" };
  }
  if (!isObject(data) || data.format !== AUTOMATION_FORMAT) {
    return { ok: false, error: "Not a Verve automation file" };
  }
  if (typeof data.formatVersion !== "number" || data.formatVersion > AUTOMATION_FORMAT_VERSION) {
    return { ok: false, error: "Made with a newer version of Verve" };
  }
  const problem = graphStructureProblem(data.graph, "The workflow");
  if (problem) return { ok: false, error: problem };
  const graph = data.graph as NodeGraph;
  if (graph.domain !== "automation") return { ok: false, error: "Not an automation workflow" };
  return { ok: true, graph };
}
