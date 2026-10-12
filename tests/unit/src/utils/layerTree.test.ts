import { describe, expect, it } from "vitest";
import type { CompositeLayerState, GroupLayerState, LayerState, MaskLayerState, PixelLayerState } from "@/types";
import {
  buildClusters,
  buildRootLayerIds,
  deepDuplicateGroup,
  getDescendantIds,
  getLayerDepth,
  getParentGroup,
  hasLockedCompositeAncestor,
  isDescendantOf,
  reorderRootLayers,
  walkLayerTree,
} from "@/utils/layerTree";

const base = { visible: true, opacity: 1, locked: false, blendMode: "normal" as const };
const pixel = (id: string): PixelLayerState => ({ id, name: id, ...base });
const group = (id: string, childIds: string[]): GroupLayerState => ({
  id, name: id, ...base, type: "group", collapsed: false, childIds,
});
const composite = (id: string, childIds: string[], locked = false): CompositeLayerState => ({
  id, name: id, ...base, locked, type: "composite", collapsed: false, childIds,
});
const mask = (id: string, parentId: string): MaskLayerState => ({ id, name: id, visible: true, type: "mask", parentId });
const adjustment = (id: string, parentId: string): LayerState =>
  ({ id, name: id, visible: true, type: "adjustment", parentId }) as unknown as LayerState;

/**
 * Render order (bottom → top): bg, g1{ a, g2{ b } }, top (+mask m on top,
 * adjustment adj on a).
 */
function doc(): LayerState[] {
  return [
    pixel("bg"),
    pixel("a"),
    adjustment("adj", "a"),
    pixel("b"),
    group("g2", ["b"]),
    group("g1", ["a", "g2"]),
    pixel("top"),
    mask("m", "top"),
  ];
}

describe("tree queries", () => {
  it("root ids are layers not inside any container, in flat order", () => {
    expect(buildRootLayerIds(doc())).toEqual(["bg", "adj", "g1", "top", "m"]);
  });

  it("finds parents", () => {
    const l = doc();
    expect(getParentGroup(l, "b")?.id).toBe("g2");
    expect(getParentGroup(l, "g2")?.id).toBe("g1");
    expect(getParentGroup(l, "bg")).toBeNull();
    expect(getParentGroup(l, "missing")).toBeNull();
  });

  it("collects descendants recursively", () => {
    const l = doc();
    expect(getDescendantIds(l, "g1")).toEqual(["a", "g2", "b"]);
    expect(getDescendantIds(l, "a")).toEqual([]);
    expect(getDescendantIds(l, "missing")).toEqual([]);
  });

  it("isDescendantOf follows nesting and is irreflexive", () => {
    const l = doc();
    expect(isDescendantOf(l, "b", "g1")).toBe(true);
    expect(isDescendantOf(l, "g1", "b")).toBe(false);
    expect(isDescendantOf(l, "g1", "g1")).toBe(false);
    expect(isDescendantOf(l, "top", "g1")).toBe(false);
  });

  it("computes depth", () => {
    const l = doc();
    expect(getLayerDepth(l, "bg")).toBe(0);
    expect(getLayerDepth(l, "a")).toBe(1);
    expect(getLayerDepth(l, "b")).toBe(2);
  });

  it("locked composite ancestors lock descendants (not the composite itself)", () => {
    const l: LayerState[] = [pixel("x"), group("g", ["x"]), composite("c", ["g"], true), pixel("y")];
    expect(hasLockedCompositeAncestor(l, "x")).toBe(true);
    expect(hasLockedCompositeAncestor(l, "g")).toBe(true);
    expect(hasLockedCompositeAncestor(l, "c")).toBe(false);
    expect(hasLockedCompositeAncestor(l, "y")).toBe(false);
    const unlocked = l.map((x) => (x.id === "c" ? composite("c", ["g"], false) : x));
    expect(hasLockedCompositeAncestor(unlocked, "x")).toBe(false);
  });
});

describe("walkLayerTree", () => {
  it("yields top-of-panel first with attachments under their parent", () => {
    const out = [...walkLayerTree(doc())].map(({ layer, depth }) => `${layer.id}@${depth}`);
    expect(out).toEqual(["top@0", "m@1", "g1@0", "g2@1", "b@2", "a@1", "adj@2", "bg@0"]);
  });

  it("yields every layer exactly once", () => {
    const l = doc();
    const ids = [...walkLayerTree(l)].map((e) => e.layer.id);
    expect(ids.sort()).toEqual(l.map((x) => x.id).sort());
  });

  it("yields a group-scoped adjustment at the group's level", () => {
    const l: LayerState[] = [pixel("p"), group("g", ["p", "gadj"]), adjustment("gadj", "g")];
    const out = [...walkLayerTree(l)].map(({ layer, depth }) => `${layer.id}@${depth}`);
    expect(out).toEqual(["g@0", "gadj@1", "p@1"]);
  });
});

describe("reorderRootLayers / buildClusters", () => {
  it("clusters carry their children and attachments", () => {
    const { clusters, remaining } = buildClusters(doc());
    expect(clusters.map((c) => c.map((l) => l.id))).toEqual([["bg"], ["g1", "a", "g2", "b", "adj"], ["top", "m"]]);
    expect(remaining).toEqual([]);
  });

  it("moves a cluster to the top of the panel (dstIndex 0)", () => {
    const out = reorderRootLayers(doc(), "bg", 0);
    expect(out.map((l) => l.id)).toEqual(["g1", "a", "g2", "b", "adj", "top", "m", "bg"]);
  });

  it("moves a cluster to the bottom (dstIndex past the end clamps)", () => {
    const out = reorderRootLayers(doc(), "top", 99);
    expect(out.map((l) => l.id)).toEqual(["top", "m", "bg", "g1", "a", "g2", "b", "adj"]);
  });

  it("preserves the layer set and returns a copy for unknown ids", () => {
    const l = doc();
    const out = reorderRootLayers(l, "g1", 0);
    expect(out.map((x) => x.id).sort()).toEqual(l.map((x) => x.id).sort());
    const same = reorderRootLayers(l, "nope", 0);
    expect(same).toEqual(l);
    expect(same).not.toBe(l);
  });

  it("does not treat non-root layers as movable roots", () => {
    const l = doc();
    expect(reorderRootLayers(l, "b", 0).map((x) => x.id)).toEqual(l.map((x) => x.id));
  });
});

describe("deepDuplicateGroup", () => {
  it("duplicates the subtree with fresh ids and remapped references", () => {
    const l = doc();
    const { newLayers, idMap } = deepDuplicateGroup(l, "g1");
    expect([...idMap.keys()].sort()).toEqual(["a", "adj", "b", "g1", "g2"]);
    const newIds = new Set(newLayers.map((x) => x.id));
    expect(newIds.size).toBe(5);
    for (const old of l) expect(newIds.has(old.id)).toBe(false);

    const byId = new Map(newLayers.map((x) => [x.id, x]));
    const g1 = byId.get(idMap.get("g1")!) as GroupLayerState;
    expect(g1.childIds).toEqual([idMap.get("a"), idMap.get("g2")]);
    const g2 = byId.get(idMap.get("g2")!) as GroupLayerState;
    expect(g2.childIds).toEqual([idMap.get("b")]);
    const adj = byId.get(idMap.get("adj")!) as unknown as { parentId: string };
    expect(adj.parentId).toBe(idMap.get("a"));
    // The original is untouched.
    expect((l.find((x) => x.id === "g1") as GroupLayerState).childIds).toEqual(["a", "g2"]);
  });

  it("emits children before their containers", () => {
    const { newLayers, idMap } = deepDuplicateGroup(doc(), "g1");
    const pos = (old: string): number => newLayers.findIndex((x) => x.id === idMap.get(old));
    expect(pos("b")).toBeLessThan(pos("g2"));
    expect(pos("g2")).toBeLessThan(pos("g1"));
  });
});
