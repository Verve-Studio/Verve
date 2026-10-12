import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeScope, createDocumentScope, setActiveScope, type DocumentScope } from "@/core/store/scope";
import { PolygonalSelectionStore } from "@/core/store/polygonalSelectionStore";

let prev: DocumentScope;
let scope: DocumentScope;
beforeEach(() => {
  prev = activeScope();
  scope = createDocumentScope();
  scope.selection.setDimensions(10, 10);
  setActiveScope(scope);
});
afterEach(() => {
  setActiveScope(prev);
  scope.history.dispose();
});

describe("PolygonalSelectionStore", () => {
  it("start / addVertex build the vertex list and report active", () => {
    const p = new PolygonalSelectionStore();
    expect(p.isActive).toBe(false);
    p.start({ x: 1, y: 1 }, "add");
    const before = p.vertices;
    p.addVertex({ x: 5, y: 1 });
    expect(p.isActive).toBe(true);
    expect(p.vertices).toEqual([
      { x: 1, y: 1 },
      { x: 5, y: 1 },
    ]);
    // New array per change (subscribers compare by identity).
    expect(p.vertices).not.toBe(before);
    expect(p.lockedMode).toBe("add");
  });

  it("commit with ≥3 vertices writes into the active selection with the locked mode", () => {
    const p = new PolygonalSelectionStore();
    scope.selection.setRect(8, 8, 9, 9);
    p.start({ x: 0, y: 0 }, "add");
    p.addVertex({ x: 4, y: 0 });
    p.addVertex({ x: 4, y: 4 });
    p.addVertex({ x: 0, y: 4 });
    p.commit();
    const m = scope.selection.mask!;
    expect(m[2 * 10 + 2]).toBe(255);
    expect(m[9 * 10 + 9]).toBe(255); // "add" kept the old rect
    expect(p.isActive).toBe(false);
  });

  it("commit with fewer than 3 vertices only resets", () => {
    const p = new PolygonalSelectionStore();
    const spy = vi.spyOn(scope.selection, "setPolygon");
    p.start({ x: 0, y: 0 }, "set");
    p.addVertex({ x: 3, y: 3 });
    p.commit();
    expect(spy).not.toHaveBeenCalled();
    expect(p.vertices).toEqual([]);
  });

  it("cancel resets and clears the selection's pending preview", () => {
    const p = new PolygonalSelectionStore();
    scope.selection.setPending({ type: "path", points: [] });
    p.start({ x: 0, y: 0 }, "set");
    p.setCursor({ x: 2, y: 2 }, true);
    expect(p.nearClose).toBe(true);
    expect(p.cursor).toEqual({ x: 2, y: 2 });
    p.cancel();
    expect(p.isActive).toBe(false);
    expect(p.nearClose).toBe(false);
    expect(scope.selection.pending).toBeNull();
  });

  it("removeLastVertex pops, and cancels when only the origin is left", () => {
    const p = new PolygonalSelectionStore();
    p.start({ x: 0, y: 0 }, "set");
    p.addVertex({ x: 1, y: 0 });
    p.removeLastVertex();
    expect(p.vertices).toEqual([{ x: 0, y: 0 }]);
    p.removeLastVertex();
    expect(p.isActive).toBe(false);
  });

  it("notifies module-level subscribers", () => {
    const a = new PolygonalSelectionStore();
    const b = new PolygonalSelectionStore();
    const fn = vi.fn();
    a.subscribe(fn);
    b.start({ x: 0, y: 0 }, "set");
    b.setCursor({ x: 1, y: 1 }, false);
    a.unsubscribe(fn);
    b.addVertex({ x: 2, y: 2 });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
