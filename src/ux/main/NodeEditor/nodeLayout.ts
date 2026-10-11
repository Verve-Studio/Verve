/**
 * Node geometry. Every row has a fixed height, so socket positions are a
 * pure function of the node's ports and parameters — wires never wait on
 * DOM measurement, and dragging a node moves its wires in the same frame.
 *
 * Row order: exec inputs paired with exec outputs (Unreal-style flow row),
 * then the remaining outputs, then the remaining inputs (each with its
 * inline value editor), then the parameters (a kernel grid takes
 * 1 + size rows), then — on subgraph nodes — the interface socket editor
 * (one row per socket plus an "add" row).
 */
import { isKernelValue, type GraphNode, type NodeGraph } from "@/core/nodes/graphTypes";
import type { INode, NodePorts, ParamDef, PortDef } from "@/core/nodes/INode";
import { nodePorts } from "@/core/nodes/graphOps";

export const HEADER_H = 24;
export const ROW_H = 22;
export const BODY_PAD = 5;
export const DEFAULT_NODE_WIDTH = 160;

export type LayoutRow =
  | { kind: "ports"; input?: PortDef; output?: PortDef }
  | { kind: "param"; param: ParamDef; rows: number }
  | { kind: "sockets"; rows: number };

export interface NodeLayout {
  readonly width: number;
  readonly height: number;
  readonly rows: readonly LayoutRow[];
  /** Socket centre y, relative to the node's top edge. */
  readonly inputY: ReadonlyMap<string, number>;
  readonly outputY: ReadonlyMap<string, number>;
}

/** Rows a parameter occupies for the node's current value. */
function paramRows(param: ParamDef, node: GraphNode): number {
  if (param.spec.kind !== "kernel") return 1;
  const v = node.params[param.id];
  return 1 + (isKernelValue(v) ? v.size : param.spec.default.size);
}

// Keyed by the (memoized) port set, then by the parameter row counts.
const cache = new WeakMap<NodePorts, Map<string, NodeLayout>>();

export function nodeLayout(node: GraphNode, def: INode, graph: NodeGraph): NodeLayout {
  const ports = nodePorts(def, node, graph);
  const params = def.params ?? [];
  const counts = params.map((p) => paramRows(p, node));
  const socketRows = def.subgraph ? (node.body?.subgraph?.sockets.length ?? 0) + 1 : 0;
  const key = `${counts.join(",")}|${socketRows}`;
  let byKey = cache.get(ports);
  const hit = byKey?.get(key);
  if (hit) return hit;

  const rows: LayoutRow[] = [];
  const execIn = ports.inputs.filter((p) => p.type === "exec");
  const execOut = ports.outputs.filter((p) => p.type === "exec");
  for (let i = 0; i < Math.max(execIn.length, execOut.length); i++) {
    rows.push({ kind: "ports", input: execIn[i], output: execOut[i] });
  }
  for (const p of ports.outputs) if (p.type !== "exec") rows.push({ kind: "ports", output: p });
  for (const p of ports.inputs) if (p.type !== "exec") rows.push({ kind: "ports", input: p });
  params.forEach((p, i) => rows.push({ kind: "param", param: p, rows: counts[i] }));
  if (socketRows > 0) rows.push({ kind: "sockets", rows: socketRows });

  const inputY = new Map<string, number>();
  const outputY = new Map<string, number>();
  let y = HEADER_H + BODY_PAD;
  for (const row of rows) {
    if (row.kind === "ports") {
      if (row.input) inputY.set(row.input.id, y + ROW_H / 2);
      if (row.output) outputY.set(row.output.id, y + ROW_H / 2);
      y += ROW_H;
    } else {
      y += ROW_H * row.rows;
    }
  }

  const layout: NodeLayout = {
    width: def.width ?? DEFAULT_NODE_WIDTH,
    height: y + BODY_PAD,
    rows,
    inputY,
    outputY,
  };
  if (!byKey) {
    byKey = new Map();
    cache.set(ports, byKey);
  }
  byKey.set(key, layout);
  return layout;
}

/** Socket centre in graph space. */
export function socketPosition(
  node: GraphNode,
  layout: NodeLayout,
  side: "in" | "out",
  portId: string,
): { x: number; y: number } {
  const y = (side === "in" ? layout.inputY : layout.outputY).get(portId) ?? HEADER_H / 2;
  return { x: node.x + (side === "in" ? 0 : layout.width), y: node.y + y };
}

/** Horizontal-tangent bezier between two sockets (output → input). */
export function wirePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

const CATEGORY_COLORS: Record<string, string> = {
  Input: "#7d3a3a",
  Math: "#2f5a85",
  Color: "#857528",
  Texture: "#9a5a26",
  Output: "#6e3a64",
  Events: "#8a2f2f",
  Flow: "#5a5a5a",
  Layers: "#2d7056",
  File: "#3a5a8a",
  Values: "#4b5b6b",
  Debug: "#6a5a3a",
  Logic: "#5b4a8a",
  Loop: "#8a6a2a",
  Info: "#2f6f7a",
  Vector: "#44509a",
  Filter: "#7a4a3a",
  Subgraph: "#3f4a5c",
};

export function categoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? "#4a4a4a";
}
