import type { INode } from "./INode";
import type { GraphDomain } from "./graphTypes";

const nodes = new Map<string, INode>();

/** Runtime registry of node types, populated by side-effect imports in
 *  `@/core/nodes` (mirrors `toolRegistry` / `effectRegistry`). */
export const nodeRegistry = {
  register(node: INode): void {
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
  },

  get(type: string): INode | undefined {
    return nodes.get(type);
  },

  forDomain(domain: GraphDomain): INode[] {
    return [...nodes.values()].filter((n) => n.domains.includes(domain));
  },
};
