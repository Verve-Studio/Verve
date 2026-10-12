import { afterEach, describe, expect, it, vi } from "vitest";
import "@/core/nodes";
import { NodeGraphDocument, SubgraphView } from "@/core/nodes/NodeGraphDocument";
import { automationSession } from "@/core/nodes/automationSession";
import { graphAt } from "@/core/nodes/graphOps";
import type { NodeGraph } from "@/core/nodes/graphTypes";
import { GraphBuilder } from "@tests/fakes/nodesGraphKit";

const named = (g: NodeGraph, name: string): NodeGraph => ({ ...g, name });

function doc() {
  const base = new GraphBuilder("shader").graph;
  const d = new NodeGraphDocument(base);
  const notified = vi.fn();
  d.subscribe(notified);
  return { d, base, notified };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NodeGraphDocument", () => {
  it("commits, undoes and redoes", () => {
    const { d, base, notified } = doc();
    const g1 = named(base, "1");
    const g2 = named(base, "2");
    d.commit(g1);
    d.commit(g2);
    expect(d.graph).toBe(g2);
    d.undo();
    expect(d.graph).toBe(g1);
    d.undo();
    expect(d.graph).toBe(base);
    d.undo(); // nothing left
    expect(d.graph).toBe(base);
    d.redo();
    d.redo();
    expect(d.graph).toBe(g2);
    d.redo();
    expect(d.graph).toBe(g2);
    expect(notified).toHaveBeenCalledTimes(6);
    expect(d.getSnapshot()).toBe(g2);
  });

  it("ignores no-op commits and clears redo on a new commit", () => {
    const { d, base, notified } = doc();
    d.commit(base);
    expect(notified).not.toHaveBeenCalled();
    d.commit(named(base, "1"));
    d.undo();
    d.commit(named(base, "other"));
    d.redo();
    expect(d.graph.name).toBe("other");
  });

  it("merges commits with the same key inside the merge window", () => {
    const now = vi.spyOn(performance, "now");
    const { d, base } = doc();
    now.mockReturnValue(1000);
    d.commit(named(base, "a"), "scrub");
    now.mockReturnValue(1500);
    d.commit(named(base, "b"), "scrub");
    now.mockReturnValue(1900);
    d.commit(named(base, "c"), "scrub");
    d.undo();
    expect(d.graph).toBe(base);
    d.redo();
    // Window passed (> 1 s since the last merge) → a new step.
    now.mockReturnValue(5000);
    d.commit(named(base, "d"), "scrub");
    d.undo();
    expect(d.graph.name).toBe("c");
    // A different key never merges.
    now.mockReturnValue(5100);
    d.commit(named(base, "e"), "scrub");
    d.commit(named(base, "f"), "other");
    d.undo();
    expect(d.graph.name).toBe("e");
  });

  it("records a gesture as one undo step", () => {
    const { d, base, notified } = doc();
    d.beginGesture();
    expect(d.inGesture).toBe(true);
    d.preview(named(base, "1"));
    d.preview(named(base, "2"));
    d.commit(named(base, "3")); // commits inside a gesture are previews
    d.endGesture();
    expect(d.inGesture).toBe(false);
    expect(d.graph.name).toBe("3");
    d.undo();
    expect(d.graph).toBe(base);
    expect(notified).toHaveBeenCalledTimes(5); // 3 updates + end-of-gesture sync + undo
  });

  it("records nothing for an unchanged gesture and restores on cancel", () => {
    const { d, base } = doc();
    d.beginGesture();
    d.endGesture();
    d.commit(named(base, "1"));
    d.beginGesture();
    d.preview(named(base, "2"));
    d.cancelGesture();
    expect(d.graph.name).toBe("1");
    d.undo();
    expect(d.graph).toBe(base);
  });

  it("reset drops history", () => {
    const { d, base } = doc();
    d.commit(named(base, "1"));
    const loaded = named(base, "loaded");
    d.reset(loaded);
    d.undo();
    expect(d.graph).toBe(loaded);
  });

  it("caps the history at 200 steps", () => {
    const { d, base } = doc();
    for (let i = 1; i <= 250; i++) d.commit(named(base, String(i)));
    for (let i = 0; i < 300; i++) d.undo();
    expect(d.graph.name).toBe("50");
  });
});

describe("SubgraphView", () => {
  function nested() {
    const b = new GraphBuilder("shader");
    const loop = b.add("forLoop");
    const d = new NodeGraphDocument(b.graph);
    return { d, loop, view: new SubgraphView(d, [loop]) };
  }

  it("edits the body through the document's history", () => {
    const { d, loop, view } = nested();
    const root = d.graph;
    view.commit({ ...view.graph, name: "Body!" });
    expect(graphAt(d.graph, [loop])!.name).toBe("Body!");
    expect(view.graph.name).toBe("Body!");
    d.undo();
    expect(d.graph).toBe(root);
    expect(view.graph).toBe(graphAt(root, [loop]));
  });

  it("namespaces merge keys and viewports by path", () => {
    const { d, view } = nested();
    view.view = { x: 1, y: 2, zoom: 3 };
    expect(d.view).toBeNull();
    expect(view.view).toEqual({ x: 1, y: 2, zoom: 3 });
    view.view = null;
    expect(view.view).toBeNull();
  });

  it("keeps showing the last body after its owner is removed", () => {
    const { d, view } = nested();
    const body = view.graph;
    d.commit({ ...d.graph, nodes: [] });
    expect(view.graph).toBe(body);
  });
});

describe("automationSession", () => {
  it("starts with an untitled workflow holding an On Run node", () => {
    automationSession.newWorkflow();
    const s = automationSession.getSnapshot();
    expect(s).toMatchObject({ path: null, name: "Untitled Workflow", dirty: false });
    expect(s.document.graph.domain).toBe("automation");
    expect(s.document.graph.nodes.map((n) => n.type)).toEqual(["onRun"]);
    expect(automationSession.getSnapshot()).toBe(s); // stable between changes
  });

  it("tracks dirty state from the document, including undo back to saved", () => {
    automationSession.newWorkflow();
    const listener = vi.fn();
    const unsubscribe = automationSession.subscribe(listener);
    const { document } = automationSession.getSnapshot();
    document.commit({ ...document.graph, name: "edited" });
    expect(automationSession.getSnapshot().dirty).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    document.commit({ ...document.graph, name: "edited again" });
    expect(listener).toHaveBeenCalledTimes(1); // still dirty: no new notification
    document.undo();
    document.undo();
    expect(automationSession.getSnapshot().dirty).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("names the workflow after its file and becomes clean when saved", () => {
    const g = new GraphBuilder("automation").graph;
    automationSession.open(g, "C:/flows/Batch Resize.automation");
    let s = automationSession.getSnapshot();
    expect(s).toMatchObject({ name: "Batch Resize", path: "C:/flows/Batch Resize.automation", dirty: false });
    expect(s.document.graph).toBe(g);
    s.document.commit({ ...g, name: "x" });
    expect(automationSession.getSnapshot().dirty).toBe(true);
    automationSession.markSaved("C:/flows/Other.automation");
    s = automationSession.getSnapshot();
    expect(s).toMatchObject({ name: "Other", dirty: false });
  });

  it("names the workflow after a Windows path's file name", () => {
    automationSession.open(new GraphBuilder("automation").graph, "C:\\flows\\Batch Resize.automation");
    expect(automationSession.getSnapshot().name).toBe("Batch Resize");
  });

  it("stops following a replaced document", () => {
    automationSession.newWorkflow();
    const old = automationSession.getSnapshot().document;
    automationSession.newWorkflow();
    old.commit({ ...old.graph, name: "stale edit" });
    expect(automationSession.getSnapshot().dirty).toBe(false);
  });
});
