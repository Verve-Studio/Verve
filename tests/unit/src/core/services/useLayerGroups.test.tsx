import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import type { LayerState } from "@/types";
import type { AppAction } from "@/core/store/AppContext";
import { useLayerGroups } from "@/core/services/useLayerGroups";
import {
  group,
  ids,
  liveStateRef,
  mask,
  pixel,
  renderHookWithAppStore,
  seedLayers,
} from "@tests/fakes/uxAppStore";
import {
  handleRef,
  makeFakeCanvasHandle,
  type FakeCanvasHandle,
} from "@tests/fakes/uxFakeCanvasHandle";

const matchPaletteIndices = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => new Uint8Array(16)),
);
vi.mock("@/wasm", () => ({ matchPaletteIndices }));

afterEach(cleanup);

let fake: FakeCanvasHandle;
let alertSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fake = makeFakeCanvasHandle();
  alertSpy = vi.fn();
  vi.stubGlobal("alert", alertSpy);
  vi.spyOn(console, "error").mockImplementation(() => {});
  matchPaletteIndices.mockClear();
});

type Container = ReturnType<typeof group> | (Omit<ReturnType<typeof group>, "type"> & { type: "composite" });

const lockedComposite = (id: string, childIds: string[]): LayerState =>
  ({ ...group(id, childIds), type: "composite", blendMode: "normal", locked: true }) as LayerState;

function setup(
  layers: LayerState[],
  active: string | null = null,
  extra: AppAction[] = [],
  withHandle = true,
) {
  const pendingLayerLabelRef = { current: null as string | null };
  const h = renderHookWithAppStore(
    (store) =>
      useLayerGroups({
        canvasHandleRef: handleRef(withHandle ? fake.handle : null),
        stateRef: liveStateRef(store),
        dispatch: store.dispatch,
        pendingLayerLabelRef,
      }),
    [...seedLayers(layers, active), ...extra],
  );
  const state = () => h.store.getState();
  const find = (id: string) => state().layers.find((l) => l.id === id) as Container;
  return { ...h, cmd: h.result.current.commands, state, find, pendingLayerLabelRef };
}

describe("LayerGroupCommands.groupLayers", () => {
  it("wraps root layers in a new group above the topmost one", () => {
    const { cmd, state, find, pendingLayerLabelRef } = setup([pixel("a"), pixel("b"), pixel("c")]);
    let id = "";
    act(() => {
      id = cmd.groupLayers(["a", "b"]);
    });
    expect(id).toMatch(/^group-/);
    expect(ids(state().layers)).toEqual(["a", "b", id, "c"]);
    expect(find(id)).toMatchObject({ type: "group", name: "Group", childIds: ["a", "b"], blendMode: "pass-through" });
    expect(state().activeLayerId).toBe(id);
    expect(pendingLayerLabelRef.current).toBe("Group Layers");
  });

  it("creates a composite (normal blend) when asked, with the given name", () => {
    const { cmd, find, state, pendingLayerLabelRef } = setup([pixel("a"), pixel("b")]);
    let id = "";
    act(() => {
      id = cmd.groupLayers(["a", "b"], { kind: "composite", name: "Merged look" });
    });
    expect(id).toMatch(/^composite-/);
    expect(find(id)).toMatchObject({ type: "composite", blendMode: "normal", name: "Merged look" });
    expect(state().activeLayerId).toBe(id);
    expect(pendingLayerLabelRef.current).toBe("Group Into Composite");
  });

  it("groups siblings inside a group into a nested group", () => {
    const { cmd, find } = setup([pixel("a"), pixel("b"), pixel("c"), group("outer", ["a", "b", "c"])]);
    let id = "";
    act(() => {
      id = cmd.groupLayers(["a", "b"]);
    });
    expect(find("outer").childIds).toEqual([id, "c"]);
    expect(find(id).childIds).toEqual(["a", "b"]);
  });

  it("rejects empty, missing, attachment and mixed-parent selections", () => {
    const { cmd, state } = setup([pixel("a"), mask("m", "a"), pixel("b"), group("g", ["b"])]);
    const before = state().layers;
    expect(() => cmd.groupLayers([])).toThrow(/No layers/);
    expect(() => cmd.groupLayers(["a", "zzz"])).toThrow(/no longer exists/);
    expect(() => cmd.groupLayers(["a", "m"])).toThrow(/group the layer instead/);
    expect(() => cmd.groupLayers(["a", "b"])).toThrow(/same group/);
    expect(state().layers).toBe(before);
  });

  it("refuses to group layers inside a locked composite", () => {
    const { cmd, state, find, pendingLayerLabelRef } = setup([
      pixel("a"),
      pixel("b"),
      lockedComposite("c", ["a", "b"]),
    ]);
    expect(() => cmd.groupLayers(["a", "b"])).toThrow(/locked composite/);
    expect(pendingLayerLabelRef.current).toBeNull();
    expect(ids(state().layers)).toEqual(["a", "b", "c"]);
    expect(find("c").childIds).toEqual(["a", "b"]);
  });
});

describe("LayerGroupCommands.ungroup", () => {
  it("moves the children up a level and removes the group", () => {
    const { cmd, state, pendingLayerLabelRef } = setup([pixel("a"), pixel("b"), group("g", ["a", "b"]), pixel("c")]);
    act(() => cmd.ungroup("g"));
    expect(ids(state().layers)).toEqual(["a", "b", "c"]);
    expect(state().activeLayerId).toBe("b");
    expect(pendingLayerLabelRef.current).toBe("Ungroup Layers");
  });

  it("splices a nested group's children into the parent at its position", () => {
    const { cmd, find } = setup([
      pixel("a"),
      pixel("b"),
      group("inner", ["a", "b"]),
      pixel("c"),
      group("outer", ["inner", "c"]),
    ]);
    act(() => cmd.ungroup("inner"));
    expect(find("outer").childIds).toEqual(["a", "b", "c"]);
  });

  it("ungroups a composite too", () => {
    const composite = { ...group("c", ["a"]), type: "composite", blendMode: "normal" } as LayerState;
    const { cmd, state } = setup([pixel("a"), composite]);
    act(() => cmd.ungroup("c"));
    expect(ids(state().layers)).toEqual(["a"]);
  });

  it("refuses to ungroup a locked composite or a group inside one", () => {
    const { cmd, state, find, pendingLayerLabelRef } = setup([
      pixel("a"),
      group("g", ["a"]),
      lockedComposite("c", ["g"]),
    ]);
    const before = state().layers;
    expect(() => cmd.ungroup("c")).toThrow(/locked composite/);
    expect(() => cmd.ungroup("g")).toThrow(/locked composite/);
    expect(state().layers).toBe(before);
    expect(find("c").type).toBe("composite");
    expect(pendingLayerLabelRef.current).toBeNull();
  });

  it("throws for non-groups", () => {
    const { cmd } = setup([pixel("a")]);
    expect(() => cmd.ungroup("a")).toThrow(/isn't a group/);
    expect(() => cmd.ungroup("nope")).toThrow(/isn't a group/);
  });
});

describe("LayerGroupCommands.newGroup", () => {
  it("adds an empty group on top by default", () => {
    const { cmd, state, find, pendingLayerLabelRef } = setup([pixel("a")]);
    let id = "";
    act(() => {
      id = cmd.newGroup();
    });
    expect(ids(state().layers)).toEqual(["a", id]);
    expect(find(id)).toMatchObject({ type: "group", name: "Group", childIds: [] });
    expect(pendingLayerLabelRef.current).toBe("New Group");
  });

  it("adds a composite above the reference layer, joining its parent group", () => {
    const { cmd, state, find, pendingLayerLabelRef } = setup([pixel("a"), pixel("b"), group("g", ["a", "b"])]);
    let id = "";
    act(() => {
      id = cmd.newGroup({ kind: "composite", aboveId: "a", name: "C" });
    });
    expect(ids(state().layers)).toEqual(["a", id, "b", "g"]);
    expect(find(id)).toMatchObject({ type: "composite", name: "C" });
    expect(find("g").childIds).toEqual(["a", id, "b"]);
    expect(pendingLayerLabelRef.current).toBe("New Composite Layer");
  });
});

describe("LayerGroupCommands.mergeGroup", () => {
  it("bakes the group into a pixel layer in its place, dropping descendants and their masks", async () => {
    const { cmd, state, find, pendingLayerLabelRef } = setup([
      pixel("a"),
      mask("m", "a"),
      pixel("b"),
      group("g", ["a", "b"], { name: "Trees", opacity: 0.7 }),
      group("outer", ["g"]),
    ]);
    let id = "";
    await act(async () => {
      id = await cmd.mergeGroup("g");
    });
    const [groupId, layersArg, , reason] = fake.rasterizeGroupChildren.mock.calls[0];
    expect(groupId).toBe("g");
    expect(ids(layersArg)).toEqual(["a", "m", "b", "g", "outer"]);
    expect(reason).toBe("merge");
    expect(ids(state().layers)).toEqual([id, "outer"]);
    // pass-through doesn't exist on pixel layers: it becomes normal.
    expect(state().layers[0]).toEqual({
      id,
      name: "Trees",
      visible: true,
      opacity: 0.7,
      locked: false,
      blendMode: "normal",
    });
    expect(find("outer").childIds).toEqual([id]);
    expect(state().activeLayerId).toBe(id);
    expect(pendingLayerLabelRef.current).toBe("Merge Group");
    expect(fake.prepareNewLayer.mock.calls[0][7]).toBe("rgba8");
  });

  it("keeps a group's non-pass-through blend mode", async () => {
    const { cmd, state } = setup([pixel("a"), group("g", ["a"], { blendMode: "screen" })]);
    await act(async () => {
      await cmd.mergeGroup("g");
    });
    expect(state().layers[0]).toMatchObject({ blendMode: "screen" });
  });

  it("indexed8 documents get an indexed layer", async () => {
    const { cmd } = setup([pixel("a"), group("g", ["a"])], null, [
      { type: "SET_PIXEL_FORMAT", payload: "indexed8" },
    ]);
    let id = "";
    await act(async () => {
      id = await cmd.mergeGroup("g");
    });
    expect(matchPaletteIndices).toHaveBeenCalledTimes(1);
    expect(fake.prepareNewLayerIndexed).toHaveBeenCalledWith(id, "g", expect.any(Uint8Array));
  });

  it("rejects non-groups and a missing canvas", async () => {
    const { cmd } = setup([pixel("a")]);
    await expect(cmd.mergeGroup("a")).rejects.toThrow(/isn't a group/);
    const noHandle = setup([pixel("a"), group("g", ["a"])], null, [], false);
    await expect(noHandle.cmd.mergeGroup("g")).rejects.toThrow(/isn't ready/);
  });
});

describe("useLayerGroups handlers", () => {
  it("handleCreateGroup groups the selection plus the active layer when there are two or more", () => {
    const { result, state } = setup([pixel("a"), pixel("b"), pixel("c")], "c", [
      { type: "SET_SELECTED_LAYERS", payload: ["a"] },
    ]);
    act(() => result.current.handleCreateGroup());
    const g = state().layers.find((l) => "type" in l && l.type === "group") as Container;
    expect([...g.childIds].sort()).toEqual(["a", "c"]);
  });

  it("handleCreateGroup adds an empty group above the active layer otherwise", () => {
    const { result, state } = setup([pixel("a"), pixel("b")], "a");
    act(() => result.current.handleCreateGroup());
    expect(state().layers).toHaveLength(3);
    expect(state().layers[1]).toMatchObject({ type: "group", childIds: [] });
  });

  it("handleGroupLayers reports invalid selections instead of throwing", () => {
    const { result } = setup([pixel("a"), pixel("b"), group("g", ["b"])]);
    act(() => result.current.handleGroupLayers(["a", "b"]));
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(String(alertSpy.mock.calls[0][0])).toMatch(/^Group layers failed/);
  });

  it("handleUngroupLayers ignores composites and plain layers", () => {
    const composite = { ...group("c", ["a"]), type: "composite", blendMode: "normal" } as LayerState;
    const { result, state } = setup([pixel("a"), composite]);
    const before = state().layers;
    act(() => {
      result.current.handleUngroupLayers("c");
      result.current.handleUngroupLayers("a");
    });
    expect(state().layers).toBe(before);
  });

  it("handleMergeGroup reports failures", async () => {
    fake.rasterizeGroupChildren.mockRejectedValueOnce(new Error("GPU lost"));
    const { result } = setup([pixel("a"), group("g", ["a"])]);
    await act(async () => {
      await result.current.handleMergeGroup("g");
    });
    expect(String(alertSpy.mock.calls[0][0])).toBe("Merge group failed.\n\nGPU lost");
  });
});
