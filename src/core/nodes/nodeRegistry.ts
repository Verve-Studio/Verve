import type { INode } from "./INode";
import type { GraphDomain } from "./graphTypes";

const nodes = new Map<string, INode>();
const providers: (() => readonly INode[])[] = [];

function add(node: INode): void {
  if (nodes.has(node.type)) {
    throw new Error(`Node type "${node.type}" registered twice`);
  }
  if (node.domains.includes("shader") && !node.generateShader) {
    throw new Error(`Node "${node.type}" lists the shader domain but has no generateShader()`);
  }
  if (node.domains.includes("automation") && !node.execute) {
    throw new Error(`Node "${node.type}" lists the automation domain but has no execute()`);
  }
  nodes.set(node.type, node);
}

/** Generated node sets (e.g. one node per registered effect) are built on
 *  use, so they include everything registered by then. Providers stay
 *  registered and only their new nodes are added. */
function resolveProviders(): void {
  for (const provide of providers) {
    for (const node of provide()) if (!nodes.has(node.type)) add(node);
  }
}

/** Runtime registry of node types, populated by side-effect imports in
 *  `@/core/nodes` (mirrors `toolRegistry` / `effectRegistry`). */
export const nodeRegistry = {
  register(node: INode): void {
    add(node);
  },

  /** Register nodes generated from another registry (built lazily, on
   *  lookups; must return the same node objects for the same sources). */
  registerProvider(provide: () => readonly INode[]): void {
    providers.push(provide);
  },

  get(type: string): INode | undefined {
    if (!nodes.has(type)) resolveProviders();
    return nodes.get(type);
  },

  forDomain(domain: GraphDomain): INode[] {
    resolveProviders();
    return [...nodes.values()].filter((n) => n.domains.includes(domain));
  },
};
