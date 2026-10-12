import { describe, expect, it } from "vitest";
import "@/core/effects";
import "@/core/nodes";
import { runAutomation } from "@/core/nodes/automationRunner";
import { nodeRegistry } from "@/core/nodes/nodeRegistry";
import { automationHostProvider } from "@/core/nodes/automationHostProvider";
import { GraphBuilder } from "@tests/fakes/nodesGraphKit";
import { FakeAutomationHost } from "@tests/fakes/nodesAutomationHost";

function workflow() {
  const b = new GraphBuilder("automation");
  const run = b.add("onRun");
  /** Append an exec node after `prev` (exec output `port`). */
  const chain = (prev: string, type: string, params = {}, port = "then"): string => {
    const id = b.add(type, params);
    b.link(prev, port, id, "exec");
    return id;
  };
  return { b, run, chain };
}

describe("runAutomation", () => {
  it("needs an On Run node", async () => {
    const b = new GraphBuilder("automation");
    b.add("print", { message: "x" });
    expect(await runAutomation(b.graph, new FakeAutomationHost())).toEqual({
      ok: false,
      nodeId: null,
      message: "Add an On Run node",
      cancelled: false,
    });
  });

  it("follows exec links from On Run, in order, and only those", async () => {
    const { b, run, chain } = workflow();
    const p1 = chain(run, "print", { message: "first" });
    chain(p1, "print", { message: "second" });
    b.add("print", { message: "not linked" });
    const host = new FakeAutomationHost();
    expect(await runAutomation(b.graph, host)).toEqual({ ok: true, steps: 3 });
    expect(host.logs).toEqual(["first", "second"]);
  });

  it("ignores comment frames", async () => {
    const { b, run, chain } = workflow();
    const p = chain(run, "print", { message: "framed" });
    const g = { ...b.graph, frames: [{ id: "f", nodeIds: [run, p], x: 0, y: 0, width: 1, height: 1, text: "", color: "#000" }] };
    const host = new FakeAutomationHost();
    expect(await runAutomation(g, host)).toEqual({ ok: true, steps: 2 });
    expect(host.logs).toEqual(["framed"]);
  });

  it("pulls pure nodes on demand", async () => {
    const { b, run, chain } = workflow();
    const math = b.add("math", { op: "multiply", a: 6, b: 7 });
    const p = chain(run, "print");
    b.link(math, "result", p, "message");
    const host = new FakeAutomationHost();
    await runAutomation(b.graph, host);
    expect(host.logs).toEqual(["42"]);
  });

  it("re-evaluates pure nodes for every exec step", async () => {
    const { b, run, chain } = workflow();
    const get = b.add("getVariable", { name: "x", default: "unset" });
    const p1 = chain(run, "print");
    const s1 = chain(p1, "setVariable", { name: "x", value: "one" });
    const p2 = chain(s1, "print");
    const s2 = chain(p2, "setVariable", { name: "x", value: "two" });
    const p3 = chain(s2, "print");
    for (const p of [p1, p2, p3]) b.link(get, "value", p, "message");
    const host = new FakeAutomationHost();
    expect((await runAutomation(b.graph, host)).ok).toBe(true);
    expect(host.logs).toEqual(["unset", "one", "two"]);
  });

  it("re-evaluates pure nodes inside loops (Repeat index)", async () => {
    const { b, run, chain } = workflow();
    const rep = chain(run, "repeat", { count: 3 });
    const add = b.add("math", { op: "add", b: 10 });
    b.link(rep, "index", add, "a");
    const p = chain(rep, "print", {}, "body");
    b.link(add, "result", p, "message");
    chain(rep, "print", { message: "done" }, "completed");
    const host = new FakeAutomationHost();
    expect(await runAutomation(b.graph, host)).toEqual({ ok: true, steps: 6 });
    expect(host.logs).toEqual(["10", "11", "12", "done"]);
  });

  it("re-reads While conditions before every pass", async () => {
    // while (n < 2) { print n; n = n + 1 }
    const { b, run, chain } = workflow();
    const loop = chain(run, "while");
    const get = b.add("getVariable", { name: "n" });
    b.set(get, "default", "0");
    const cmp = b.add("compare", { op: "lt", b: 2 });
    b.link(get, "value", cmp, "a").link(cmp, "result", loop, "condition");
    const p = chain(loop, "print", {}, "body");
    b.link(get, "value", p, "message");
    const inc = b.add("math", { op: "add", b: 1 });
    b.link(get, "value", inc, "a");
    const set = chain(p, "setVariable", { name: "n" });
    b.link(inc, "result", set, "value");
    const host = new FakeAutomationHost();
    expect((await runAutomation(b.graph, host)).ok).toBe(true);
    expect(host.logs).toEqual(["0", "1"]);
  });

  it("keeps variables to one run", async () => {
    const { b, run, chain } = workflow();
    const get = b.add("getVariable", { name: "x", default: "unset" });
    const p = chain(run, "print");
    b.link(get, "value", p, "message");
    chain(p, "setVariable", { name: "x", value: "set" });
    const host = new FakeAutomationHost();
    await runAutomation(b.graph, host);
    await runAutomation(b.graph, host);
    expect(host.logs).toEqual(["unset", "unset"]);
  });

  it("feeds any value into a list input as a one-item list", async () => {
    const { b, run, chain } = workflow();
    const value = b.add("value", { value: 5 });
    const len = b.add("listLength");
    b.link(value, "value", len, "list");
    const p = chain(run, "print");
    b.link(len, "length", p, "message");
    const p2 = chain(p, "print");
    b.link(value, "value", p2, "message");
    const host = new FakeAutomationHost();
    await runAutomation(b.graph, host);
    expect(host.logs).toEqual(["1", "5"]);
  });

  it("branches and sequences", async () => {
    const { b, run, chain } = workflow();
    const seq = chain(run, "sequence", { count: 3 });
    const br = chain(seq, "branch", { condition: false }, "then0");
    chain(br, "print", { message: "yes" }, "true");
    chain(br, "print", { message: "no" }, "false");
    chain(seq, "print", { message: "second" }, "then1");
    chain(seq, "print", { message: "third" }, "then2");
    const host = new FakeAutomationHost();
    expect((await runAutomation(b.graph, host)).ok).toBe(true);
    expect(host.logs).toEqual(["no", "second", "third"]);
  });

  it("reads an exec node's outputs after it ran", async () => {
    const { b, run, chain } = workflow();
    const nl = chain(run, "newLayer", { name: "Sky" });
    const p = chain(nl, "print");
    b.link(nl, "layer", p, "message");
    const host = new FakeAutomationHost();
    expect((await runAutomation(b.graph, host)).ok).toBe(true);
    expect(host.logs).toEqual(["Sky"]);
    expect(host.layerNames()).toEqual(["Sky", "Background"]);
  });

  it("reports reading an exec node that hasn't run", async () => {
    const { b, run, chain } = workflow();
    const nl = b.add("newLayer", { name: "Sky" });
    const p = chain(run, "print");
    b.link(nl, "layer", p, "message");
    const r = await runAutomation(b.graph, new FakeAutomationHost());
    expect(r).toEqual({ ok: false, nodeId: p, message: "New Layer hasn't run yet", cancelled: false });
  });

  it("propagates host errors with the failing node", async () => {
    const { b, run, chain } = workflow();
    const p = chain(run, "print", { message: "before" });
    const del = chain(p, "deleteLayer");
    chain(del, "print", { message: "after" });
    const host = new FakeAutomationHost().failOn("deleteLayer", "The layer is locked");
    const r = await runAutomation(b.graph, host);
    expect(r).toEqual({ ok: false, nodeId: del, message: "The layer is locked", cancelled: false });
    expect(host.logs).toEqual(["before"]);
  });

  it("uses the active layer for an unconnected Layer input", async () => {
    const { b, run, chain } = workflow();
    chain(run, "deleteLayer");
    const host = new FakeAutomationHost({ layers: ["Bottom", "Top"] });
    const active = host.activeLayer();
    await runAutomation(b.graph, host);
    expect(host.callsTo("deleteLayer")[0].args[0]).toEqual(active);
  });

  it("reports Stop With Error and stops", async () => {
    const { b, run, chain } = workflow();
    const stop = chain(run, "stop", { message: "Nope" });
    const r = await runAutomation(b.graph, new FakeAutomationHost());
    expect(r).toEqual({ ok: false, nodeId: stop, message: "Nope", cancelled: false });
  });

  it("rejects shader-only nodes", async () => {
    const { b, run, chain } = workflow();
    const p = chain(run, "print");
    const g = {
      ...b.graph,
      nodes: [...b.graph.nodes, { id: "noise", type: "noise", x: 0, y: 0, params: {} }],
      edges: [...b.graph.edges, { id: "e", from: { node: "noise", port: "value" }, to: { node: p, port: "message" } }],
    };
    const r = await runAutomation(g, new FakeAutomationHost());
    expect(r).toMatchObject({ ok: false, nodeId: "noise", message: "Noise can't be used in a workflow" });
  });

  it("stops runaway workflows at maxSteps", async () => {
    const { b, run, chain } = workflow();
    const rep = chain(run, "repeat", { count: 1000 });
    chain(rep, "print", { message: "x" }, "body");
    const host = new FakeAutomationHost();
    const r = await runAutomation(b.graph, host, { maxSteps: 10 });
    expect(r).toMatchObject({ ok: false, message: "Step limit reached", cancelled: false });
    expect(host.logs.length).toBeLessThan(10);
  });

  it("reports cancellation (before and during a run)", async () => {
    const { b, run, chain } = workflow();
    const rep = chain(run, "repeat", { count: 1000 });
    chain(rep, "print", { message: "x" }, "body");
    const pre = new AbortController();
    pre.abort();
    expect(await runAutomation(b.graph, new FakeAutomationHost(), { signal: pre.signal })).toEqual({
      ok: false,
      nodeId: null,
      message: "Cancelled",
      cancelled: true,
    });
    const during = new AbortController();
    const host = new FakeAutomationHost();
    const log = host.log.bind(host);
    host.log = (m: string) => {
      log(m);
      if (host.logs.length === 3) during.abort();
    };
    const r = await runAutomation(b.graph, host, { signal: during.signal });
    expect(r).toMatchObject({ ok: false, cancelled: true });
    expect(host.logs).toHaveLength(3);
  });

  it("applies generated effect nodes through the host with inline values", async () => {
    const effectNode = nodeRegistry
      .forDomain("automation")
      .find((n) => n.type.startsWith("effect.") && n.inputs.some((p) => p.value))!;
    const { b, run, chain } = workflow();
    const id = chain(run, effectNode.type);
    const host = new FakeAutomationHost();
    expect((await runAutomation(b.graph, host)).ok).toBe(true);
    const [call] = host.callsTo("addEffect");
    const options = call.args[0] as { effectType: string; values: Record<string, unknown>; bake: boolean; target: unknown };
    expect(`effect.${options.effectType}`).toBe(effectNode.type);
    expect(options.bake).toBe(false);
    expect(options.target).toEqual(host.layers({})[1]); // the active layer before the effect was added
    const fieldPorts = effectNode.inputs.filter((p) => p.value);
    expect(Object.keys(options.values).sort()).toEqual(fieldPorts.map((p) => p.id.slice(2)).sort());
    for (const p of fieldPorts) expect(options.values[p.id.slice(2)]).toEqual(b.node(id).params[p.id]);
  });
});

describe("automationHostProvider", () => {
  it("provides the host until its own disposer runs", () => {
    const a = new FakeAutomationHost();
    const b = new FakeAutomationHost();
    const disposeA = automationHostProvider.provide(a);
    expect(automationHostProvider.get()).toBe(a);
    const disposeB = automationHostProvider.provide(b);
    disposeA(); // stale disposer: b stays
    expect(automationHostProvider.get()).toBe(b);
    disposeB();
    expect(automationHostProvider.get()).toBeNull();
  });

  it("fans log messages out to listeners", () => {
    const seen: string[] = [];
    const off = automationHostProvider.onLog((m) => seen.push(m));
    automationHostProvider.emitLog("one");
    off();
    automationHostProvider.emitLog("two");
    expect(seen).toEqual(["one"]);
  });
});
