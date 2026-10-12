import { describe, expect, it } from "vitest";
import "@/core/nodes";
import {
  SUBGRAPH_INPUT,
  SUBGRAPH_OUTPUT,
  inputBoundaryPorts,
  newSocketId,
  outputBoundaryPorts,
  ownerPorts,
  socketValueSpec,
  specOfBody,
} from "@/core/nodes/subgraphs";
import { createNode, findPort, nodePorts, nodeTitle, setSockets } from "@/core/nodes/graphOps";
import type { NodeGraph, SocketDecl } from "@/core/nodes/graphTypes";
import type { SubgraphSpec } from "@/core/nodes/INode";
import { GraphBuilder, def } from "@tests/fakes/nodesGraphKit";

const ids = (ports: readonly { id: string }[]): string[] => ports.map((p) => p.id);

describe("subgraph ports", () => {
  const spec: SubgraphSpec = {
    inputTitle: "In",
    outputTitle: "Out",
    socketsLabel: "Values",
    directions: ["in", "out", "both"],
    types: ["float", "color"],
    bodyInputs: [{ id: "index", label: "Index", type: "int" }],
    ownerInputs: [{ id: "count", label: "Count", type: "int" }],
    ownerOutputs: [{ id: "done", label: "Done", type: "bool" }],
    defaultSockets: [],
  };
  const sockets: SocketDecl[] = [
    { id: "s_in", name: "In", type: "float", direction: "in" },
    { id: "s_out", name: "Out", type: "color", direction: "out" },
    { id: "s_both", name: "Both", type: "color", direction: "both" },
  ];

  it("derive both sides of the boundary from the spec and sockets", () => {
    const owner = ownerPorts(spec, sockets);
    expect(ids(owner.inputs)).toEqual(["count", "s_in", "s_both"]);
    expect(ids(owner.outputs)).toEqual(["done", "s_out", "s_both"]);
    const input = inputBoundaryPorts(spec, sockets);
    expect(input.inputs).toEqual([]);
    expect(ids(input.outputs)).toEqual(["index", "s_in", "s_both"]);
    const output = outputBoundaryPorts(sockets);
    expect(ids(output.inputs)).toEqual(["s_out", "s_both"]);
    expect(output.outputs).toEqual([]);
  });

  it("give owner inputs an inline editor matching the socket type", () => {
    const owner = ownerPorts(spec, sockets);
    expect(owner.inputs.find((p) => p.id === "s_in")!.value).toEqual(socketValueSpec("float"));
    expect(socketValueSpec("color")).toMatchObject({ kind: "color" });
    expect(socketValueSpec("vec3")).toBeUndefined();
    expect(socketValueSpec("layer")).toBeUndefined();
  });

  it("are memoised on the (immutable) socket list", () => {
    expect(ownerPorts(spec, sockets)).toBe(ownerPorts(spec, sockets));
    expect(inputBoundaryPorts(spec, sockets)).toBe(inputBoundaryPorts(spec, sockets));
    expect(outputBoundaryPorts(sockets)).toBe(outputBoundaryPorts(sockets));
    expect(ownerPorts(spec, [...sockets])).not.toBe(ownerPorts(spec, sockets));
  });

  it("socket ids are unique", () => {
    const seen = new Set(Array.from({ length: 50 }, newSocketId));
    expect(seen.size).toBe(50);
    for (const id of seen) expect(id).toMatch(/^s_[0-9a-f]{8}$/);
  });
});

describe("For Loop body", () => {
  it("is created with boundary nodes and the default socket", () => {
    const loopDef = def("forLoop");
    const node = createNode(loopDef, 0, 0, "shader");
    const body = node.body!;
    expect(body.domain).toBe("shader");
    expect(body.nodes.map((n) => n.type)).toEqual([SUBGRAPH_INPUT, SUBGRAPH_OUTPUT]);
    expect(specOfBody(body)).toBe(loopDef.subgraph);
    const [socket] = body.subgraph!.sockets;
    expect(socket).toMatchObject({ name: "Color", type: "color", direction: "both" });
    // Owner: Count + the socket, both ways; inline values for every input.
    expect(ids(nodePorts(loopDef, node).inputs)).toEqual(["count", socket.id]);
    expect(ids(nodePorts(loopDef, node).outputs)).toEqual([socket.id]);
    expect(node.params.count).toBe(8);
    expect(node.params[socket.id]).toEqual([0, 0, 0, 0]);
  });

  it("titles and ports its boundary nodes from the spec", () => {
    const body = createNode(def("forLoop"), 0, 0).body!;
    const [start, end] = body.nodes;
    expect(nodeTitle(def(SUBGRAPH_INPUT), start, body)).toBe("Loop Start");
    expect(nodeTitle(def(SUBGRAPH_OUTPUT), end, body)).toBe("Loop End");
    const socket = body.subgraph!.sockets[0].id;
    expect(ids(nodePorts(def(SUBGRAPH_INPUT), start, body).outputs)).toEqual(["index", "count", socket]);
    expect(ids(nodePorts(def(SUBGRAPH_OUTPUT), end, body).inputs)).toEqual([socket]);
    // Outside a body they fall back to the generic definition.
    expect(nodePorts(def(SUBGRAPH_INPUT), start, null)).toBe(def(SUBGRAPH_INPUT));
    expect(nodeTitle(def(SUBGRAPH_INPUT), start, { ...body, subgraph: undefined })).toBe("Subgraph Input");
  });
});

describe("setSockets", () => {
  /** Loop with links on both sides of the boundary for socket A and B. */
  function setup() {
    const b = new GraphBuilder("shader");
    const input = b.add("layerInput");
    const output = b.add("layerOutput");
    const loop = b.add("forLoop");
    const original = b.node(loop).body!.subgraph!.sockets[0];
    const extra: SocketDecl = { id: "s_extra", name: "Amount", type: "float", direction: "both" };
    b.graph = setSockets(b.graph, loop, [original, extra]);
    b.link(input, "color", loop, original.id).link(loop, original.id, output, "color");
    b.link(input, "alpha", loop, extra.id).link(loop, extra.id, output, "alpha");
    b.set(loop, extra.id, 0.5);
    // Inside the body: Loop Start → Invert → Loop End for the colour,
    // Loop Start → Math → Loop End for the amount.
    const body = new GraphBuilder(b.node(loop).body!);
    const start = body.graph.nodes.find((n) => n.type === SUBGRAPH_INPUT)!.id;
    const end = body.graph.nodes.find((n) => n.type === SUBGRAPH_OUTPUT)!.id;
    const inv = body.add("invert");
    const math = body.add("math");
    body.link(start, original.id, inv, "color").link(inv, "color", end, original.id);
    body.link(start, extra.id, math, "a").link(math, "result", end, extra.id);
    body.link(start, "index", math, "b");
    b.graph = { ...b.graph, nodes: b.graph.nodes.map((n) => (n.id === loop ? { ...n, body: body.graph } : n)) };
    return { b, loop, original, extra, start, end, inv, math };
  }

  const bodyOf = (g: NodeGraph, loop: string): NodeGraph => g.nodes.find((n) => n.id === loop)!.body!;

  it("prunes links on both sides when a socket is removed", () => {
    const { b, loop, original, start, end, inv, math } = setup();
    expect(b.graph.edges).toHaveLength(4);
    const g = setSockets(b.graph, loop, [original]);
    // Outer links of the removed socket are gone, the others stay.
    expect(g.edges.map((e) => [e.from.port, e.to.port]).sort()).toEqual([
      ["color", original.id],
      [original.id, "color"],
    ]);
    const body = bodyOf(g, loop);
    const inner = body.edges.map((e) => `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`).sort();
    // Links through the removed socket (start → math.a, math → end) are gone.
    expect(inner).toEqual(
      [
        `${start}.${original.id}>${inv}.color`,
        `${inv}.color>${end}.${original.id}`,
        `${start}.index>${math}.b`,
      ].sort(),
    );
    expect(body.subgraph!.sockets).toEqual([original]);
  });

  it("drops owner inline values that no longer fit a retyped socket", () => {
    const { b, loop, original, extra } = setup();
    expect(b.node(loop).params[extra.id]).toBe(0.5);
    const g = setSockets(b.graph, loop, [original, { ...extra, type: "color" }]);
    expect(g.nodes.find((n) => n.id === loop)!.params[extra.id]).toBeUndefined();
    // Numeric retyping keeps the (convertible) links.
    expect(g.edges).toHaveLength(4);
  });

  it("renames without touching links", () => {
    const { b, loop, original, extra } = setup();
    const g = setSockets(b.graph, loop, [original, { ...extra, name: "Strength" }]);
    expect(g.edges).toHaveLength(4);
    expect(bodyOf(g, loop).edges).toHaveLength(5);
    const owner = g.nodes.find((n) => n.id === loop)!;
    expect(findPort(g, owner, "in", extra.id)!.label).toBe("Strength");
  });

  it("ignores nodes without a body", () => {
    const b = new GraphBuilder("shader");
    const m = b.add("math");
    expect(setSockets(b.graph, m, [])).toBe(b.graph);
    expect(setSockets(b.graph, "ghost", [])).toBe(b.graph);
  });
});
