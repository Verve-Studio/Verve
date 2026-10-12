import { describe, expect, it, vi } from "vitest";
import { buildAdjustmentEntry, buildRenderPlan, buildSubPlan } from "@/ux/main/Canvas/canvasPlan";
import { effectRegistry } from "@/core/effects";
import type { PlanContext } from "@/core/effects/IPipelineEffect";
import type { EffectLayerState } from "@/core/effects/effectTypes";
import type { CompositeLayerState, GroupLayerState, LayerState, PixelFormat, PixelLayerState, RGBAColor } from "@/types";
import type { EffectRenderOp, GpuLayer, RenderPlanEntry } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { computeAdjGroupStaticKey } from "@/graphics/webgpu/rendering/cacheKeys";
import { nodeRegistry } from "@/core/nodes";
import { connect, createNode, setParam } from "@/core/nodes/graphOps";
import type { NodeGraph } from "@/core/nodes/graphTypes";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const px = (id: string, over: Partial<PixelLayerState> = {}): PixelLayerState => ({
  id,
  name: id,
  visible: true,
  opacity: 1,
  locked: false,
  blendMode: "normal",
  ...over,
});

const group = (id: string, childIds: string[], over: Partial<GroupLayerState> = {}): GroupLayerState => ({
  id,
  name: id,
  visible: true,
  opacity: 0.5,
  locked: false,
  blendMode: "multiply",
  type: "group",
  collapsed: false,
  childIds,
  ...over,
});

const composite = (id: string, childIds: string[], over: Partial<CompositeLayerState> = {}): CompositeLayerState => ({
  id,
  name: id,
  visible: true,
  opacity: 0.75,
  locked: false,
  blendMode: "screen",
  type: "composite",
  collapsed: false,
  childIds,
  ...over,
});

const adj = (
  id: string,
  parentId: string,
  effectType: "brightness-contrast" | "color-invert" | "custom-shader" = "brightness-contrast",
  over: Partial<EffectLayerState> = {},
): EffectLayerState =>
  ({
    id,
    name: id,
    visible: true,
    type: "adjustment",
    parentId,
    effectType,
    params: { ...(effectRegistry.get(effectType)!.defaultParams as object) },
    hasMask: false,
    ...over,
  }) as EffectLayerState;

const maskLayer = (id: string, parentId: string): LayerState => ({ id, name: id, visible: true, type: "mask", parentId });

const gl = (id: string, over: Partial<GpuLayer> = {}): GpuLayer =>
  ({
    id,
    name: id,
    offsetX: 0,
    offsetY: 0,
    layerWidth: 100,
    layerHeight: 80,
    contentVersion: 1,
    ...over,
  }) as GpuLayer;

const SWATCHES: RGBAColor[] = [{ r: 1, g: 2, b: 3, a: 255 }];

interface Doc {
  layers: LayerState[];
  gls?: GpuLayer[];
  masks?: [string, GpuLayer][];
  adjMasks?: [string, GpuLayer][];
  bypass?: string[];
  format?: PixelFormat;
}

function plan(d: Doc): RenderPlanEntry[] {
  const gls = new Map((d.gls ?? autoGls(d.layers)).map((g) => [g.id, g]));
  return buildRenderPlan(
    d.layers,
    gls,
    new Map(d.masks ?? []),
    new Map(d.adjMasks ?? []),
    new Set(d.bypass ?? []),
    SWATCHES,
    d.format,
  );
}

/** A GPU layer for every pixel-bearing layer. */
function autoGls(layers: LayerState[]): GpuLayer[] {
  return layers.filter((l) => !("type" in l)).map((l) => gl(l.id));
}

const kinds = (p: RenderPlanEntry[]) => p.map((e) => e.kind);
const ids = (ops: EffectRenderOp[]) => ops.map((o) => o.layerId);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("buildRenderPlan — pixel layers", () => {
  it("emits one layer entry per pixel layer in stack order with its mask", () => {
    const m = gl("mask-a");
    const p = plan({ layers: [px("a"), maskLayer("ma", "a"), px("b")], masks: [["a", m]] });
    expect(p).toEqual([
      { kind: "layer", layer: expect.objectContaining({ id: "a" }), mask: m },
      { kind: "layer", layer: expect.objectContaining({ id: "b" }), mask: undefined },
    ]);
  });

  it("skips layers without a GPU layer (not yet uploaded)", () => {
    const p = plan({ layers: [px("a"), px("b")], gls: [gl("b")] });
    expect(p).toHaveLength(1);
    expect((p[0] as { layer: GpuLayer }).layer.id).toBe("b");
  });

  it("keeps hidden pixel layers in the plan (visibility lives on the GPU layer)", () => {
    expect(plan({ layers: [px("a", { visible: false })] })).toHaveLength(1);
  });
});

describe("buildRenderPlan — attached effects", () => {
  it("bundles visible attached effects into an adjustment-group in stack order", () => {
    const base = gl("a", { offsetX: 5, offsetY: 7, layerWidth: 20, layerHeight: 30 });
    const bm = gl("ma");
    const p = plan({
      layers: [px("a", { locked: true }), adj("e1", "a"), adj("e2", "a", "color-invert"), adj("hidden", "a", "brightness-contrast", { visible: false }), px("b")],
      gls: [base, gl("b")],
      masks: [["a", bm]],
    });
    expect(kinds(p)).toEqual(["adjustment-group", "layer"]);
    const g = p[0] as Extract<RenderPlanEntry, { kind: "adjustment-group" }>;
    expect(g.parentLayerId).toBe("a");
    expect(g.baseLayer).toBe(base);
    expect(g.baseMask).toBe(bm);
    expect(g.locked).toBe(true);
    expect(ids(g.adjustments)).toEqual(["e1", "e2"]);
    expect(g.adjustments.map((o) => o.kind)).toEqual(["brightness-contrast", "color-invert"]);
  });

  it("passes the parent layer's rect, the effect's own mask and the swatches to buildPlanEntry", () => {
    const effect = effectRegistry.get("brightness-contrast")!;
    const spy = vi.spyOn(effect, "buildPlanEntry");
    const am = gl("adj-mask");
    plan({
      layers: [px("a"), adj("e1", "a")],
      gls: [gl("a", { offsetX: 5, offsetY: 7, layerWidth: 20, layerHeight: 30 })],
      adjMasks: [["e1", am]],
    });
    const ctx = spy.mock.calls[0][1] as PlanContext;
    expect(ctx.parentRect).toEqual({ x: 5, y: 7, width: 20, height: 30 });
    expect(ctx.mask).toBe(am);
    expect(ctx.swatches).toBe(SWATCHES);
  });

  it("an unlocked layer's group carries no locked flag", () => {
    const p = plan({ layers: [px("a"), adj("e1", "a")] });
    expect((p[0] as { locked?: boolean }).locked).toBeUndefined();
  });

  it("drops preview-bypassed effects and falls back to a plain layer when none remain", () => {
    const p = plan({ layers: [px("a"), adj("e1", "a")], bypass: ["e1"] });
    expect(kinds(p)).toEqual(["layer"]);
    const p2 = plan({ layers: [px("a"), adj("e1", "a"), adj("e2", "a")], bypass: ["e1"] });
    expect(ids((p2[0] as { adjustments: EffectRenderOp[] }).adjustments)).toEqual(["e2"]);
  });

  it("emits no effects at all on indexed8 documents", () => {
    const p = plan({
      layers: [px("a"), adj("e1", "a"), composite("c", ["b"]), px("b"), adj("e2", "c")],
      format: "indexed8",
    });
    expect(kinds(p)).toEqual(["layer", "composite-layer"]);
    expect((p[1] as { adjustments: EffectRenderOp[] }).adjustments).toEqual([]);
  });

  it("produces the same cache keys when rebuilt from the same state (one plan per frame)", () => {
    const doc: Doc = { layers: [px("a"), adj("e1", "a"), adj("e2", "a", "color-invert")] };
    const k = (p: RenderPlanEntry[]) => computeAdjGroupStaticKey((p[0] as { adjustments: EffectRenderOp[] }).adjustments);
    expect(k(plan(doc))).toBe(k(plan(doc)));
  });
});

describe("buildRenderPlan — containers", () => {
  it("groups recurse and are always full-opacity pass-through, keeping visibility", () => {
    const p = plan({ layers: [group("g", ["a", "b"], { visible: false }), px("a"), px("b"), px("top")] });
    expect(kinds(p)).toEqual(["layer-group", "layer"]);
    const g = p[0] as Extract<RenderPlanEntry, { kind: "layer-group" }>;
    expect(g).toMatchObject({ groupId: "g", opacity: 1, blendMode: "pass-through", visible: false });
    expect(g.children.map((c) => (c as { layer: GpuLayer }).layer.id)).toEqual(["a", "b"]);
  });

  it("nested groups nest in the plan and children don't leak to the root", () => {
    const p = plan({ layers: [group("outer", ["inner", "a"]), group("inner", ["b"]), px("a"), px("b")] });
    expect(kinds(p)).toEqual(["layer-group"]);
    const outer = p[0] as Extract<RenderPlanEntry, { kind: "layer-group" }>;
    expect(kinds(outer.children)).toEqual(["layer-group", "layer"]);
    expect(kinds((outer.children[0] as { children: RenderPlanEntry[] }).children)).toEqual(["layer"]);
  });

  it("composites flatten children and carry their own attached effects (whole canvas, no parent rect)", () => {
    const effect = effectRegistry.get("color-invert")!;
    const spy = vi.spyOn(effect, "buildPlanEntry");
    const p = plan({
      layers: [composite("c", ["a"], { locked: true }), adj("ce", "c", "color-invert"), adj("off", "c", "color-invert", { visible: false }), px("a"), adj("ae", "a")],
    });
    expect(kinds(p)).toEqual(["composite-layer"]);
    const c = p[0] as Extract<RenderPlanEntry, { kind: "composite-layer" }>;
    expect(c).toMatchObject({ layerId: "c", opacity: 0.75, blendMode: "screen", visible: true, locked: true });
    expect(ids(c.adjustments)).toEqual(["ce"]);
    expect(kinds(c.children)).toEqual(["adjustment-group"]);
    expect((spy.mock.calls[0][1] as PlanContext).parentRect).toBeUndefined();
  });

  it("composite effects honour preview bypass", () => {
    const p = plan({ layers: [composite("c", ["a"]), adj("ce", "c"), px("a")], bypass: ["ce"] });
    expect((p[0] as { adjustments: EffectRenderOp[] }).adjustments).toEqual([]);
  });
});

describe("buildRenderPlan — standalone (group-scoped) effects", () => {
  it("emits a visible effect parented to a group at its own stack position", () => {
    const am = gl("am");
    const p = plan({
      layers: [px("bottom"), group("g", ["a"]), adj("ge", "g"), px("a"), px("top")],
      adjMasks: [["ge", am]],
    });
    expect(kinds(p)).toEqual(["layer", "layer-group", "brightness-contrast", "layer"]);
    expect((p[2] as EffectRenderOp).selMaskLayer).toBe(am);
  });

  it("omits hidden or bypassed standalone effects, and all of them on indexed8", () => {
    const layers = [group("g", ["a"]), adj("ge", "g"), px("a")];
    expect(kinds(plan({ layers: [group("g", ["a"]), adj("ge", "g", "brightness-contrast", { visible: false }), px("a")] }))).toEqual(["layer-group"]);
    expect(kinds(plan({ layers, bypass: ["ge"] }))).toEqual(["layer-group"]);
    expect(kinds(plan({ layers, format: "indexed8" }))).toEqual(["layer-group"]);
  });

  it("an effect whose parent no longer exists is emitted standalone", () => {
    expect(kinds(plan({ layers: [px("a"), adj("orphan", "gone")] }))).toEqual(["layer", "brightness-contrast"]);
  });
});

describe("layer name resolution for effects that read other layers", () => {
  it("resolves names to the first pixel-bearing layer, ignoring masks and effect layers", () => {
    const effect = effectRegistry.get("brightness-contrast")!;
    const spy = vi.spyOn(effect, "buildPlanEntry");
    const first = gl("p1");
    plan({
      layers: [
        adj("Tex", "nothing-else"), // an effect layer named "Tex"
        px("p1", { name: "Tex" }),
        px("p2", { name: "Tex" }),
        maskLayer("m", "p1"),
        px("p3", { name: "Other" }),
        adj("e", "p3"),
      ],
      gls: [first, gl("p2"), gl("p3"), gl("m"), gl("Tex")],
    });
    const ctx = spy.mock.calls.at(-1)![1] as PlanContext;
    expect(ctx.resolveLayer("Tex")?.layer).toBe(first);
    expect(ctx.resolveLayer("m")).toBeUndefined();
    expect(ctx.resolveLayer("missing")).toBeUndefined();
  });
});

describe("layers read by other layers' effects (Sample Layer)", () => {
  /** A Custom Shader layer on `parentId` whose graph samples `sampled`. */
  function sampler(id: string, parentId: string, sampled: string): EffectLayerState {
    const base = effectRegistry.get("custom-shader")!.defaultParams as { graph: NodeGraph };
    const node = createNode(nodeRegistry.get("sampleLayer")!, 160, 0);
    const graph = setParam({ ...base.graph, nodes: [...base.graph.nodes, node] }, node.id, "layer", sampled);
    const output = graph.nodes.find((n) => n.type === "layerOutput")!;
    const r = connect(graph, { node: node.id, port: "color" }, { node: output.id, port: "color" });
    if (!r.ok) throw new Error("connect failed");
    return adj(id, parentId, "custom-shader", { params: { graph: r.graph } } as Partial<EffectLayerState>);
  }
  const effectsOf = (p: RenderPlanEntry[], layerId: string): EffectRenderOp[] =>
    (p.find((e) => e.kind === "adjustment-group" && e.parentLayerId === layerId) as {
      adjustments: EffectRenderOp[];
    }).adjustments;

  it("resolves a source with its layer mask and its own effects", () => {
    const m = gl("mask-tex");
    const p = plan({
      layers: [px("tex"), maskLayer("mt", "tex"), adj("tex-fx", "tex", "color-invert"), px("a"), sampler("sa", "a", "tex")],
      masks: [["tex", m]],
    });
    const [source] = effectsOf(p, "a")[0].sourceLayers!;
    expect(source!.layer.id).toBe("tex");
    expect(source!.mask).toBe(m);
    expect(ids([...source!.adjustments])).toEqual(["tex-fx"]);
  });

  it("reads a layer sampling itself as its raw pixels", () => {
    const p = plan({ layers: [px("a"), sampler("sa", "a", "a")] });
    const [source] = effectsOf(p, "a")[0].sourceLayers!;
    expect(source!.layer.id).toBe("a");
    expect(source!.adjustments).toEqual([]);
  });

  it("cuts the cycle when two layers sample each other", () => {
    const p = plan({ layers: [px("a"), sampler("sa", "a", "b"), px("b"), sampler("sb", "b", "a")] });
    // a reads b with b's effect, which in turn reads a raw.
    const [bFromA] = effectsOf(p, "a")[0].sourceLayers!;
    expect(ids([...bFromA!.adjustments])).toEqual(["sb"]);
    const [aInsideB] = bFromA!.adjustments[0].sourceLayers!;
    expect(aInsideB!.layer.id).toBe("a");
    expect(aInsideB!.adjustments).toEqual([]);
    // And the other way round.
    const [aFromB] = effectsOf(p, "b")[0].sourceLayers!;
    expect(ids([...aFromB!.adjustments])).toEqual(["sa"]);
    expect(aFromB!.adjustments[0].sourceLayers![0]!.adjustments).toEqual([]);
  });

  it("cuts longer cycles too (a → b → c → a)", () => {
    const p = plan({
      layers: [px("a"), sampler("sa", "a", "b"), px("b"), sampler("sb", "b", "c"), px("c"), sampler("sc", "c", "a")],
    });
    const b = effectsOf(p, "a")[0].sourceLayers![0]!;
    const c = b.adjustments[0].sourceLayers![0]!;
    const a = c.adjustments[0].sourceLayers![0]!;
    expect([b.layer.id, c.layer.id, a.layer.id]).toEqual(["b", "c", "a"]);
    expect(a.adjustments).toEqual([]);
  });
});

describe("buildAdjustmentEntry / buildSubPlan", () => {
  it("throws for an unregistered effect type rather than dropping the layer", () => {
    const bad = { ...adj("x", "a"), effectType: "nope" } as unknown as EffectLayerState;
    expect(() => buildAdjustmentEntry(bad, undefined, [], () => undefined)).toThrow(/no effect registered/);
  });

  it("buildSubPlan plans just the given ids (merge / flatten of a group)", () => {
    const layers = [group("g", ["a", "b"]), px("a"), adj("e", "a"), px("b"), px("outside")];
    const gls = new Map(autoGls(layers).map((g) => [g.id, g]));
    const p = buildSubPlan(["a", "b"], layers, gls, new Map(), new Map(), new Set(), SWATCHES, "rgba32f");
    expect(kinds(p)).toEqual(["adjustment-group", "layer"]);
    expect(buildSubPlan(["missing"], layers, gls, new Map(), new Map(), new Set(), SWATCHES)).toEqual([]);
  });
});
