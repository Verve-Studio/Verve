/**
 * Subgraph plumbing shared by every subgraph kind.
 *
 * A subgraph node (an `INode` with a `subgraph` spec, e.g. For Loop) owns a
 * nested graph in `GraphNode.body`. The body carries its interface —
 * `NodeGraph.subgraph = { kind, sockets }` — and two generic boundary
 * nodes (Subgraph Input / Subgraph Output). Ports on both sides of the
 * boundary are derived here from the spec of the owning kind plus the
 * sockets, so adding a new subgraph kind is just a spec on its node.
 */
import type { NodeGraph, SocketDecl } from "./graphTypes";
import type { NodePorts, ParamSpec, PortDef, PortType, SubgraphSpec } from "./INode";
import { nodeRegistry } from "./nodeRegistry";

export const SUBGRAPH_INPUT = "subgraphInput";
export const SUBGRAPH_OUTPUT = "subgraphOutput";

export function newSocketId(): string {
  return `s_${crypto.randomUUID().slice(0, 8)}`;
}

/** Spec of the subgraph kind a body graph belongs to. */
export function specOfBody(graph: NodeGraph | null): SubgraphSpec | undefined {
  const kind = graph?.subgraph?.kind;
  return kind ? nodeRegistry.get(kind)?.subgraph : undefined;
}

/** Inline editor for a socket's value on the owner (e.g. a loop value's
 *  initial value). */
export function socketValueSpec(type: PortType): ParamSpec | undefined {
  switch (type) {
    case "float":
      return { kind: "float", default: 0, step: 0.01 };
    case "int":
      return { kind: "int", default: 0 };
    case "bool":
      return { kind: "bool", default: false };
    case "vec2":
      return { kind: "vec2", default: [0, 0], step: 0.01 };
    case "color":
      return { kind: "color", default: [0, 0, 0, 0] };
    case "string":
      return { kind: "string", default: "" };
    default:
      return undefined;
  }
}

const passesIn = (s: SocketDecl): boolean => s.direction !== "out";
const passesOut = (s: SocketDecl): boolean => s.direction !== "in";

interface DerivedPorts {
  owner?: NodePorts;
  input?: NodePorts;
  output?: NodePorts;
}
// Socket lists are immutable, so ports are memoized on them per kind
// (layouts are cached on the returned objects).
const derived = new WeakMap<object, WeakMap<readonly SocketDecl[], DerivedPorts>>();
const NO_SPEC = {};
const EMPTY: readonly SocketDecl[] = [];

function memo(
  spec: SubgraphSpec | null,
  sockets: readonly SocketDecl[],
  key: keyof DerivedPorts,
  build: () => NodePorts,
): NodePorts {
  let bySockets = derived.get(spec ?? NO_SPEC);
  if (!bySockets) {
    bySockets = new WeakMap();
    derived.set(spec ?? NO_SPEC, bySockets);
  }
  let entry = bySockets.get(sockets);
  if (!entry) {
    entry = {};
    bySockets.set(sockets, entry);
  }
  return (entry[key] ??= build());
}

/** Ports of the subgraph node itself. */
export function ownerPorts(spec: SubgraphSpec, sockets: readonly SocketDecl[] = EMPTY): NodePorts {
  return memo(spec, sockets, "owner", () => ({
    inputs: [
      ...(spec.ownerInputs ?? []),
      ...sockets.filter(passesIn).map(
        (s): PortDef => ({ id: s.id, label: s.name, type: s.type, value: socketValueSpec(s.type) }),
      ),
    ],
    outputs: [
      ...(spec.ownerOutputs ?? []),
      ...sockets.filter(passesOut).map((s): PortDef => ({ id: s.id, label: s.name, type: s.type })),
    ],
  }));
}

/** Ports of the body's input boundary node: values flowing into the body. */
export function inputBoundaryPorts(spec: SubgraphSpec, sockets: readonly SocketDecl[]): NodePorts {
  return memo(spec, sockets, "input", () => ({
    inputs: [],
    outputs: [
      ...(spec.bodyInputs ?? []),
      ...sockets.filter(passesIn).map((s): PortDef => ({ id: s.id, label: s.name, type: s.type })),
    ],
  }));
}

/** Ports of the body's output boundary node: results leaving the body. */
export function outputBoundaryPorts(sockets: readonly SocketDecl[]): NodePorts {
  return memo(null, sockets, "output", () => ({
    inputs: sockets.filter(passesOut).map((s): PortDef => ({ id: s.id, label: s.name, type: s.type })),
    outputs: [],
  }));
}
