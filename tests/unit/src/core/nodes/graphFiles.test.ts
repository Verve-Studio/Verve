import { describe, expect, it } from "vitest";
import "@/core/nodes";
import {
  AUTOMATION_FORMAT,
  AUTOMATION_FORMAT_VERSION,
  parseAutomation,
  serializeAutomation,
} from "@/core/nodes/automationFile";
import { graphStructureProblem, isObject } from "@/core/nodes/graphFile";
import type { NodeGraph } from "@/core/nodes/graphTypes";
import { GraphBuilder } from "@tests/fakes/nodesGraphKit";

function sampleWorkflow(): NodeGraph {
  const b = new GraphBuilder("automation");
  const run = b.add("onRun");
  const p = b.add("print", { message: "hi" });
  b.link(run, "then", p, "exec");
  return {
    ...b.graph,
    frames: [{ id: "f", nodeIds: [p], x: 1, y: 2, width: 3, height: 4, text: "note", color: "#123456" }],
  };
}

const wrap = (data: unknown): string => JSON.stringify(data);

describe(".automation files", () => {
  it("round-trips a workflow", () => {
    const g = sampleWorkflow();
    const text = serializeAutomation(g);
    expect(JSON.parse(text)).toMatchObject({ format: AUTOMATION_FORMAT, formatVersion: AUTOMATION_FORMAT_VERSION });
    expect(parseAutomation(text)).toEqual({ ok: true, graph: g });
  });

  it("rejects bad JSON, other formats and newer versions", () => {
    expect(parseAutomation("{ nope")).toEqual({ ok: false, error: "Not a valid automation file (bad JSON)" });
    expect(parseAutomation("[]")).toEqual({ ok: false, error: "Not a Verve automation file" });
    expect(parseAutomation(wrap({ format: "verve-effect", formatVersion: 1, graph: sampleWorkflow() }))).toEqual({
      ok: false,
      error: "Not a Verve automation file",
    });
    expect(
      parseAutomation(wrap({ format: AUTOMATION_FORMAT, formatVersion: AUTOMATION_FORMAT_VERSION + 1, graph: sampleWorkflow() })),
    ).toEqual({ ok: false, error: "Made with a newer version of Verve" });
    expect(parseAutomation(wrap({ format: AUTOMATION_FORMAT, formatVersion: "1", graph: sampleWorkflow() }))).toEqual({
      ok: false,
      error: "Made with a newer version of Verve",
    });
  });

  it("rejects shader graphs and malformed graphs", () => {
    const shader = new GraphBuilder("shader").graph;
    expect(parseAutomation(wrap({ format: AUTOMATION_FORMAT, formatVersion: 1, graph: shader }))).toEqual({
      ok: false,
      error: "Not an automation workflow",
    });
    expect(parseAutomation(wrap({ format: AUTOMATION_FORMAT, formatVersion: 1 }))).toEqual({
      ok: false,
      error: "The workflow is missing",
    });
    const badNode = { ...sampleWorkflow(), nodes: [{ id: "x", type: "print", x: "0", y: 0, params: {} }] };
    expect(parseAutomation(wrap({ format: AUTOMATION_FORMAT, formatVersion: 1, graph: badNode }))).toEqual({
      ok: false,
      error: "The workflow has an invalid node",
    });
  });
});

describe("graphStructureProblem", () => {
  const node = { id: "n", type: "math", x: 0, y: 0, params: {} };

  it("accepts well-formed graphs", () => {
    expect(graphStructureProblem({ nodes: [node], edges: [] }, "G")).toBeNull();
  });

  it.each([
    [null, "G is missing"],
    [[], "G is missing"],
    [{ nodes: [] }, "G has no nodes / links"],
    [{ nodes: {}, edges: [] }, "G has no nodes / links"],
    [{ nodes: [{ ...node, id: 1 }], edges: [] }, "G has an invalid node"],
    [{ nodes: [{ ...node, type: undefined }], edges: [] }, "G has an invalid node"],
    [{ nodes: [{ ...node, params: null }], edges: [] }, "G has an invalid node"],
    [{ nodes: [{ ...node, y: null }], edges: [] }, "G has an invalid node"],
    [{ nodes: [node], edges: [{ from: { node: "n" } }] }, "G has an invalid link"],
    [{ nodes: [node], edges: [null] }, "G has an invalid link"],
  ])("reports %j", (graph, problem) => {
    expect(graphStructureProblem(graph, "G")).toBe(problem);
  });

  it("checks nested bodies, naming the owner", () => {
    const owner = { ...node, type: "forLoop", body: { nodes: [{ ...node, x: "1" }], edges: [] } };
    expect(graphStructureProblem({ nodes: [owner], edges: [] }, "G")).toBe("G › forLoop has an invalid node");
  });

  it("isObject excludes arrays and null", () => {
    expect(isObject({})).toBe(true);
    expect(isObject([])).toBe(false);
    expect(isObject(null)).toBe(false);
    expect(isObject("x")).toBe(false);
  });
});
