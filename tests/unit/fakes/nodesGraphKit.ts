/**
 * Builders for node-graph tests: create graphs through the real graph ops
 * (createNode / connect / setParam), so the tests exercise the same paths
 * as the editor.
 */
import "@/core/nodes";
import { nodeRegistry } from "@/core/nodes/nodeRegistry";
import { connect, createNode, setParam } from "@/core/nodes/graphOps";
import type { GraphDomain, GraphNode, NodeGraph, ParamValue } from "@/core/nodes/graphTypes";
import type { INode } from "@/core/nodes/INode";

export function emptyGraph(domain: GraphDomain, extra: Partial<NodeGraph> = {}): NodeGraph {
  return { id: `g-${domain}`, name: "Test", domain, nodes: [], edges: [], ...extra };
}

export function def(type: string): INode {
  const d = nodeRegistry.get(type);
  if (!d) throw new Error(`No node type "${type}"`);
  return d;
}

/** Mutable builder over an immutable graph value. */
export class GraphBuilder {
  graph: NodeGraph;

  constructor(domainOrGraph: GraphDomain | NodeGraph) {
    this.graph = typeof domainOrGraph === "string" ? emptyGraph(domainOrGraph) : domainOrGraph;
  }

  /** Add a node of `type` with default params, then apply `params`. */
  add(type: string, params: Readonly<Record<string, ParamValue>> = {}, id?: string): string {
    const created = createNode(def(type), 0, 0, this.graph.domain);
    const node: GraphNode = id ? { ...created, id } : created;
    this.graph = { ...this.graph, nodes: [...this.graph.nodes, node] };
    for (const [k, v] of Object.entries(params)) this.set(node.id, k, v);
    return node.id;
  }

  set(nodeId: string, key: string, value: ParamValue): this {
    this.graph = setParam(this.graph, nodeId, key, value);
    return this;
  }

  /** Link `from.port` → `to.port`; throws when the link is rejected. */
  link(from: string, fromPort: string, to: string, toPort: string): this {
    const r = connect(this.graph, { node: from, port: fromPort }, { node: to, port: toPort });
    if (!r.ok) throw new Error(`link ${from}.${fromPort} → ${to}.${toPort}: ${r.reason}`);
    this.graph = r.graph;
    return this;
  }

  node(id: string): GraphNode {
    const n = this.graph.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`No node ${id}`);
    return n;
  }
}
