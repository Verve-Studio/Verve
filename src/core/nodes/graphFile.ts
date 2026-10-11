/** Validation shared by the files that store node graphs (`.effect`,
 *  `.automation`). */

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Structural check of a (possibly nested) graph read from disk. */
export function graphStructureProblem(g: unknown, where: string): string | null {
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
      const inner = graphStructureProblem(n.body, `${where} › ${n.type}`);
      if (inner) return inner;
    }
  }
  for (const e of g.edges) {
    if (!isObject(e) || !isObject(e.from) || !isObject(e.to)) return `${where} has an invalid link`;
  }
  return null;
}
