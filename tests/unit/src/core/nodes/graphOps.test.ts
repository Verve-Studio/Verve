import { describe, expect, it } from "vitest";
import "@/core/nodes";
import {
  addFrame,
  checkConnection,
  connect,
  createNode,
  extractFragment,
  firstCompatiblePort,
  graphAt,
  nodePorts,
  nodeTitle,
  paramValue,
  pasteFragment,
  removeEdges,
  removeFrames,
  removeNodes,
  setArguments,
  setFrameMembership,
  setGraphInfo,
  setNodePositions,
  setParam,
  updateAt,
  updateFrame,
} from "@/core/nodes/graphOps";
import type { GraphFrame, NodeGraph } from "@/core/nodes/graphTypes";
import { GraphBuilder, def } from "@tests/fakes/nodesGraphKit";

const frame = (id: string, nodeIds: string[]): GraphFrame => ({
  id,
  nodeIds,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  text: id,
  color: "#888",
});

const edgeKeys = (g: NodeGraph): string[] =>
  g.edges.map((e) => `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`).sort();

describe("nodePorts / paramValue", () => {
  it("uses the static ports for nodes without ports()", () => {
    const clamp = def("clamp");
    expect(nodePorts(clamp)).toBe(clamp);
  });

  it("fills parameter defaults before resolving dynamic ports", () => {
    const math = def("math");
    // No params stored → default op "add" → A and B.
    expect(nodePorts(math, { params: {} }).inputs.map((p) => p.id)).toEqual(["a", "b"]);
    expect(nodePorts(math, { params: { op: "abs" } }).inputs.map((p) => p.id)).toEqual(["a"]);
  });

  it("falls back from stored value to param default to inline default", () => {
    const math = def("math");
    expect(paramValue(math, { params: { op: "sin" } }, "op")).toBe("sin");
    expect(paramValue(math, { params: {} }, "op")).toBe("add");
    expect(paramValue(def("clamp"), { params: {} }, "max")).toBe(1);
    expect(paramValue(math, { params: {} }, "nothing")).toBe(0);
  });

  it("titles nodes by label unless the definition says otherwise", () => {
    const b = new GraphBuilder("shader");
    const m = b.add("math");
    expect(nodeTitle(def("math"), b.node(m), b.graph)).toBe("Math");
  });
});

describe("connect / checkConnection", () => {
  it("links compatible ports and rejects incompatible ones", () => {
    const b = new GraphBuilder("automation");
    const text = b.add("text");
    const math = b.add("math");
    const upper = b.add("textUpper");
    expect(checkConnection(b.graph, { node: text, port: "value" }, { node: math, port: "a" })).toBe(
      "Can't connect string to float",
    );
    expect(checkConnection(b.graph, { node: text, port: "value" }, { node: upper, port: "text" })).toBeNull();
    expect(checkConnection(b.graph, { node: math, port: "result" }, { node: upper, port: "text" })).toBe(
      "Can't connect float to string",
    );
  });

  it("rejects self links, missing nodes and missing ports", () => {
    const b = new GraphBuilder("shader");
    const m = b.add("math");
    const n = b.add("math");
    expect(checkConnection(b.graph, { node: m, port: "result" }, { node: m, port: "a" })).toMatch(/itself/);
    expect(checkConnection(b.graph, { node: "ghost", port: "result" }, { node: m, port: "a" })).toBe("Node not found");
    expect(checkConnection(b.graph, { node: m, port: "nope" }, { node: n, port: "a" })).toBe("Port not found");
    // Hidden port (B of a unary op) is not connectable.
    b.set(n, "op", "abs");
    expect(checkConnection(b.graph, { node: m, port: "result" }, { node: n, port: "b" })).toBe("Port not found");
  });

  it("rejects links that would close a cycle (direct and indirect)", () => {
    const b = new GraphBuilder("shader");
    const [x, y, z] = [b.add("math"), b.add("math"), b.add("math")];
    b.link(x, "result", y, "a").link(y, "result", z, "a");
    expect(checkConnection(b.graph, { node: z, port: "result" }, { node: x, port: "a" })).toBe(
      "That would create a cycle",
    );
    expect(checkConnection(b.graph, { node: y, port: "result" }, { node: x, port: "b" })).toBe(
      "That would create a cycle",
    );
    // A diamond is fine.
    expect(checkConnection(b.graph, { node: x, port: "result" }, { node: z, port: "b" })).toBeNull();
  });

  it("replaces the link into a data input; data outputs fan out", () => {
    const b = new GraphBuilder("shader");
    const [v1, v2, m1, m2] = [b.add("value"), b.add("value"), b.add("math"), b.add("math")];
    b.link(v1, "value", m1, "a").link(v1, "value", m2, "a");
    expect(b.graph.edges).toHaveLength(2);
    b.link(v2, "value", m1, "a");
    expect(edgeKeys(b.graph)).toEqual([`${v1}.value>${m2}.a`, `${v2}.value>${m1}.a`].sort());
    // Re-linking the same pair doesn't duplicate it.
    b.link(v2, "value", m1, "a");
    expect(b.graph.edges).toHaveLength(2);
  });

  it("exec outputs continue to one node; exec inputs merge", () => {
    const b = new GraphBuilder("automation");
    const run = b.add("onRun");
    const [p1, p2, p3] = [b.add("print"), b.add("print"), b.add("print")];
    b.link(run, "then", p1, "exec");
    b.link(run, "then", p2, "exec");
    expect(edgeKeys(b.graph)).toEqual([`${run}.then>${p2}.exec`]);
    b.link(p1, "then", p3, "exec").link(p2, "then", p3, "exec");
    expect(b.graph.edges.filter((e) => e.to.node === p3)).toHaveLength(2);
  });

  it("returns new graphs and leaves the input untouched", () => {
    const b = new GraphBuilder("shader");
    const [v, m] = [b.add("value"), b.add("math")];
    const before = b.graph;
    const r = connect(before, { node: v, port: "value" }, { node: m, port: "a" });
    expect(r.ok).toBe(true);
    expect(before.edges).toHaveLength(0);
  });
});

describe("setParam", () => {
  it("drops links to ports that disappear (Math → unary op hides B)", () => {
    const b = new GraphBuilder("shader");
    const [va, vb, m, out] = [b.add("value"), b.add("value"), b.add("math"), b.add("layerOutput")];
    b.link(va, "value", m, "a").link(vb, "value", m, "b").link(m, "result", out, "color");
    b.set(m, "op", "abs");
    expect(edgeKeys(b.graph)).toEqual([`${m}.result>${out}.color`, `${va}.value>${m}.a`].sort());
  });

  it("keeps the graph's links when the ports don't change", () => {
    const b = new GraphBuilder("shader");
    const [va, m] = [b.add("value"), b.add("math")];
    b.link(va, "value", m, "a");
    const keys = edgeKeys(b.graph);
    b.set(m, "op", "multiply");
    expect(edgeKeys(b.graph)).toEqual(keys);
    // An inline value edit doesn't reshape ports: the links are untouched.
    const edges = b.graph.edges;
    b.set(m, "a", 3);
    expect(b.graph.edges).toBe(edges);
    expect(b.node(m).params.a).toBe(3);
  });

  it("drops inline values and links that no longer fit a retyped port (If / Else)", () => {
    const b = new GraphBuilder("automation");
    const ifElse = b.add("ifElse", { dataType: "string" });
    b.set(ifElse, "then", "yes");
    const upper = b.add("textUpper");
    const value = b.add("value");
    b.link(ifElse, "result", upper, "text");
    expect(checkConnection(b.graph, { node: value, port: "value" }, { node: ifElse, port: "else" })).toMatch(
      /float to string/,
    );
    expect(b.graph.edges).toHaveLength(1);
    b.set(ifElse, "dataType", "float");
    // "yes" doesn't fit a float editor; float result can't feed a string input.
    expect(b.node(ifElse).params.then).toBeUndefined();
    expect(b.graph.edges).toHaveLength(0);
    // Numeric retyping keeps compatible links (float → color converts).
    b.link(value, "value", ifElse, "then");
    b.set(ifElse, "dataType", "color");
    expect(b.graph.edges).toHaveLength(1);
  });

  it("only prunes around the changed node", () => {
    const b = new GraphBuilder("shader");
    const [v, m1, m2] = [b.add("value"), b.add("math"), b.add("math")];
    b.link(v, "value", m2, "b");
    b.set(m1, "op", "abs");
    expect(b.graph.edges).toHaveLength(1);
  });

  it("ignores unknown nodes", () => {
    const b = new GraphBuilder("shader");
    expect(setParam(b.graph, "ghost", "x", 1)).toBe(b.graph);
  });
});

describe("removeNodes / removeEdges / positions", () => {
  it("removes nodes with their links and frame memberships", () => {
    const b = new GraphBuilder("shader");
    const [v, m, out] = [b.add("value"), b.add("math"), b.add("layerOutput")];
    b.link(v, "value", m, "a").link(m, "result", out, "color");
    b.graph = addFrame(b.graph, frame("f", [v, m]));
    const g = removeNodes(b.graph, new Set([m]));
    expect(g.nodes.map((n) => n.id)).toEqual([v, out]);
    expect(g.edges).toHaveLength(0);
    expect(g.frames![0].nodeIds).toEqual([v]);
  });

  it("never removes subgraph boundary nodes", () => {
    const loop = createNode(def("forLoop"), 0, 0);
    const body = loop.body!;
    expect(removeNodes(body, new Set(body.nodes.map((n) => n.id)))).toBe(body);
  });

  it("returns the same graph when nothing changes", () => {
    const b = new GraphBuilder("shader");
    const m = b.add("math");
    expect(removeNodes(b.graph, new Set())).toBe(b.graph);
    expect(removeEdges(b.graph, new Set())).toBe(b.graph);
    expect(setNodePositions(b.graph, new Map())).toBe(b.graph);
    const moved = setNodePositions(b.graph, new Map([[m, { x: 5, y: 6 }]]));
    expect(moved.nodes[0]).toMatchObject({ x: 5, y: 6 });
  });
});

describe("frames", () => {
  it("moves nodes between frames (one frame per node)", () => {
    let g = new GraphBuilder("shader").graph;
    g = addFrame(addFrame(g, frame("a", ["n1", "n2"])), frame("b", ["n3"]));
    g = setFrameMembership(g, new Set(["n2"]), "b");
    expect(g.frames!.map((f) => f.nodeIds)).toEqual([["n1"], ["n3", "n2"]]);
    g = setFrameMembership(g, new Set(["n3"]), null);
    expect(g.frames!.map((f) => f.nodeIds)).toEqual([["n1"], ["n2"]]);
    expect(setFrameMembership(g, new Set(["n1"]), "a")).toBe(g);
  });

  it("updates and removes frames without touching nodes", () => {
    const b = new GraphBuilder("shader");
    const m = b.add("math");
    let g = addFrame(b.graph, frame("f", [m]));
    g = updateFrame(g, "f", { text: "Hello", color: "#f00" });
    expect(g.frames![0]).toMatchObject({ id: "f", text: "Hello", color: "#f00", nodeIds: [m] });
    g = removeFrames(g, new Set(["f"]));
    expect(g.frames).toEqual([]);
    expect(g.nodes).toHaveLength(1);
  });
});

describe("copy / paste fragments", () => {
  function setup() {
    const b = new GraphBuilder("shader");
    const [v, m1, m2, out] = [b.add("value"), b.add("math"), b.add("math"), b.add("layerOutput")];
    b.link(v, "value", m1, "a").link(m1, "result", m2, "a").link(m2, "result", out, "color");
    b.graph = addFrame(addFrame(b.graph, frame("both", [v, m1])), frame("partial", [m2, out]));
    return { b, v, m1, m2, out };
  }

  it("carries only the links inside the fragment and frames whose members are all copied", () => {
    const { b, v, m1, m2 } = setup();
    const frag = extractFragment(b.graph, new Set([v, m1, m2]));
    expect(frag.nodes.map((n) => n.id)).toEqual([v, m1, m2]);
    expect(frag.edges).toHaveLength(2);
    expect(frag.frames.map((f) => f.id)).toEqual(["both"]);
  });

  it("selecting a frame selects its members", () => {
    const { b, m2, out } = setup();
    const frag = extractFragment(b.graph, new Set(), new Set(["partial"]));
    expect(frag.nodes.map((n) => n.id).sort()).toEqual([m2, out].sort());
    expect(frag.frames.map((f) => f.id)).toEqual(["partial"]);
  });

  it("pastes with fresh ids, offsets and remapped links / frames", () => {
    const { b, v, m1 } = setup();
    const frag = extractFragment(b.graph, new Set([v, m1]));
    const { graph, newIds, newFrameIds } = pasteFragment(b.graph, frag, 10, 20);
    expect(graph.nodes).toHaveLength(6);
    expect(newIds.size).toBe(2);
    for (const id of newIds) expect([v, m1]).not.toContain(id);
    const pasted = graph.nodes.filter((n) => newIds.has(n.id));
    expect(pasted.map((n) => [n.x, n.y])).toEqual([
      [10, 20],
      [10, 20],
    ]);
    const newEdges = graph.edges.filter((e) => newIds.has(e.from.node));
    expect(newEdges).toHaveLength(1);
    expect(newIds.has(newEdges[0].to.node)).toBe(true);
    expect(newFrameIds.size).toBe(1);
    const f = graph.frames!.find((x) => newFrameIds.has(x.id))!;
    expect(new Set(f.nodeIds)).toEqual(newIds);
    expect([f.x, f.y]).toEqual([10, 20]);
    // The original frames are untouched.
    expect(graph.frames!.filter((x) => !newFrameIds.has(x.id)).map((x) => x.id)).toEqual(["both", "partial"]);
  });

  it("skips unique nodes already present and nodes from another domain", () => {
    const { b, out, v } = setup();
    const frag = extractFragment(b.graph, new Set([out, v]));
    const same = pasteFragment(b.graph, frag, 0, 0);
    expect(same.newIds.size).toBe(1); // the second Layer Output is skipped
    const auto = new GraphBuilder("automation").graph;
    const shaderOnly = extractFragment(b.graph, new Set([out]));
    expect(pasteFragment(auto, shaderOnly, 0, 0).graph.nodes).toHaveLength(0);
  });

  it("excludes subgraph boundary nodes from fragments", () => {
    const body = createNode(def("forLoop"), 0, 0).body!;
    expect(extractFragment(body, new Set(body.nodes.map((n) => n.id))).nodes).toEqual([]);
  });
});

describe("nested graphs", () => {
  it("finds and rebuilds bodies by owner path", () => {
    const b = new GraphBuilder("shader");
    const loop = b.add("forLoop");
    const body = b.node(loop).body!;
    expect(graphAt(b.graph, [loop])).toBe(body);
    expect(graphAt(b.graph, [])).toBe(b.graph);
    expect(graphAt(b.graph, ["ghost"])).toBeNull();
    const renamed = updateAt(b.graph, [loop], (g) => ({ ...g, name: "Renamed" }));
    expect(graphAt(renamed, [loop])!.name).toBe("Renamed");
    expect(renamed).not.toBe(b.graph);
    expect(updateAt(b.graph, [loop], (g) => g)).toBe(b.graph);
    expect(updateAt(b.graph, ["ghost"], (g) => ({ ...g, name: "x" }))).toBe(b.graph);
  });
});

describe("setArguments", () => {
  it("drops links from Layer Input sockets of removed arguments", () => {
    const b = new GraphBuilder({
      id: "g",
      name: "g",
      domain: "shader",
      nodes: [],
      edges: [],
      arguments: [
        { id: "a1", name: "One", type: "float", default: 1 },
        { id: "a2", name: "Two", type: "float", default: 2 },
      ],
    });
    const input = b.add("layerInput");
    const m = b.add("math");
    b.link(input, "a1", m, "a").link(input, "a2", m, "b");
    const g = setArguments(b.graph, [{ id: "a2", name: "Two", type: "float", default: 2 }]);
    expect(edgeKeys(g)).toEqual([`${input}.a2>${m}.b`]);
  });
});

describe("misc", () => {
  it("finds the first compatible port", () => {
    expect(firstCompatiblePort(def("mix"), "in", "color")?.id).toBe("factor");
    expect(firstCompatiblePort(def("textUpper"), "in", "float")).toBeUndefined();
    expect(firstCompatiblePort(def("separateRgba"), "out", "float")?.id).toBe("r");
  });

  it("merges graph info over defaults", () => {
    const g = setGraphInfo(new GraphBuilder("shader").graph, { name: "Glow" });
    expect(g.info).toEqual({ name: "Glow", author: "", description: "", version: "" });
    expect(setGraphInfo(g, { author: "Me" }).info).toEqual({ name: "Glow", author: "Me", description: "", version: "" });
  });
});
