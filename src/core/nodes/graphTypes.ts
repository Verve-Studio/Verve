/**
 * Serialized node-graph data model.
 *
 * A graph is plain JSON-safe data: the node editor edits it, the shader
 * compiler and automation runner read it. Node behaviour (ports, params,
 * evaluation) lives in the node definition looked up by `GraphNode.type`
 * in `nodeRegistry`; the graph itself only stores ids, positions and the
 * values the user typed in.
 */

import type { PortType } from "./INode";

/** Which engine a graph targets. The editor offers only the node
 *  definitions registered for the graph's domain. */
export type GraphDomain = "shader" | "automation";

export type { KernelValue, ParamValue } from "@/core/params/paramTypes";
export { isKernelValue } from "@/core/params/paramTypes";
import type { ParamValue } from "@/core/params/paramTypes";

export interface GraphNode {
  readonly id: string;
  /** Node definition id (see `nodeRegistry`). */
  readonly type: string;
  /** Top-left position in graph space. */
  readonly x: number;
  readonly y: number;
  /** Values for inline inputs and parameters, keyed by port / param id.
   *  Missing keys fall back to the definition's default. */
  readonly params: Readonly<Record<string, ParamValue>>;
  /** Nested graph owned by a subgraph node (e.g. a For Loop's body). */
  readonly body?: NodeGraph;
}

/**
 * How an interface socket of a subgraph crosses the boundary:
 *  - `in`:   owner input -> value on the body's input node
 *  - `out`:  body's output node -> owner output
 *  - `both`: all of the above (a For Loop's carried values)
 */
export type SocketDirection = "in" | "out" | "both";

/** A user-defined socket of a subgraph's interface. The id is stable across
 *  renames so links survive. */
export interface SocketDecl {
  readonly id: string;
  readonly name: string;
  readonly type: PortType;
  readonly direction: SocketDirection;
}

export interface PortRef {
  readonly node: string;
  readonly port: string;
}

/** A connection from an output port to an input port. */
export interface GraphEdge {
  readonly id: string;
  readonly from: PortRef;
  readonly to: PortRef;
}

/**
 * A titled box drawn behind a group of nodes — a comment on what they do.
 * Purely visual: compilation and execution ignore frames. The editor draws
 * it around its member nodes, so it grows with them; the stored rectangle
 * is the minimum extent (resizing can make a frame larger than its nodes).
 */
export interface GraphFrame {
  readonly id: string;
  /** Member nodes: they move with the frame and keep it fitted. A node
   *  belongs to at most one frame. */
  readonly nodeIds: readonly string[];
  /** Minimum top-left and size in graph space. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Comment shown in the header (may span several lines). */
  readonly text: string;
  /** Hex colour of the frame. */
  readonly color: string;
}

/** Descriptive metadata of a graph (shown and edited in the shader
 *  editor's properties panel; the name labels saved effects in the menu). */
export interface GraphInfo {
  readonly name: string;
  readonly author: string;
  readonly description: string;
  readonly version: string;
}

/** Value types an effect argument can have. */
export type ArgumentType = "float" | "int" | "bool" | "vec2" | "color";

/**
 * A user-facing input of an effect: shown as a socket on the start node
 * (Layer Input) and as a field in the effect's settings window. Numeric
 * types may declare a range (`min` / `max`, per component for vectors)
 * and a slider `step`. The id is stable across renames.
 */
export interface GraphArgument {
  readonly id: string;
  readonly name: string;
  readonly type: ArgumentType;
  readonly default: ParamValue;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export interface NodeGraph {
  readonly id: string;
  readonly name: string;
  readonly domain: GraphDomain;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Metadata (root graphs). */
  readonly info?: GraphInfo;
  /** Effect arguments (root shader graphs). */
  readonly arguments?: readonly GraphArgument[];
  /** Comment frames, drawn behind the nodes. */
  readonly frames?: readonly GraphFrame[];
  /** Present on a subgraph body: the owner node type (`kind`) and the
   *  interface sockets shared by the owner and the boundary nodes. */
  readonly subgraph?: { readonly kind: string; readonly sockets: readonly SocketDecl[] };
}

export function newGraphId(): string {
  return crypto.randomUUID();
}
