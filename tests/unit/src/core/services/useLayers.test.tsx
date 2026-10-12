import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import type { LayerState } from "@/types";
import type { AppAction } from "@/core/store/AppContext";
import { useLayers } from "@/core/services/useLayers";
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
  raster,
  type FakeCanvasHandle,
} from "@tests/fakes/uxFakeCanvasHandle";

const matchPaletteIndices = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => new Uint8Array(16).fill(3)),
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

type GroupLayer = ReturnType<typeof group>;

function setup(
  layers: LayerState[],
  active: string | null = null,
  extra: AppAction[] = [],
  withHandle = true,
) {
  const pendingLayerLabelRef = { current: null as string | null };
  const h = renderHookWithAppStore(
    (store) =>
      useLayers({
        canvasHandleRef: handleRef(withHandle ? fake.handle : null),
        stateRef: liveStateRef(store),
        dispatch: store.dispatch,
        pendingLayerLabelRef,
      }),
    [...seedLayers(layers, active), ...extra],
  );
  const state = () => h.store.getState();
  const findGroup = (id: string) => state().layers.find((l) => l.id === id) as GroupLayer;
  return { ...h, cmd: h.result.current.commands, state, findGroup, pendingLayerLabelRef };
}

describe("LayerStackCommands.newLayer", () => {
  it("adds an empty pixel layer on top, makes it active and labels the history entry", () => {
    const { cmd, state, pendingLayerLabelRef } = setup([pixel("a"), pixel("b")], "a");
    let id = "";
    act(() => {
      id = cmd.newLayer();
    });
    expect(id).toMatch(/^layer-/);
    expect(ids(state().layers)).toEqual(["a", "b", id]);
    expect(state().layers[2].name).toBe("Layer 3");
    expect(state().activeLayerId).toBe(id);
    expect(pendingLayerLabelRef.current).toBe("New Layer");
  });

  it("uses the given name", () => {
    const { cmd, state } = setup([pixel("a")]);
    let id = "";
    act(() => {
      id = cmd.newLayer({ name: "Sky" });
    });
    expect(state().layers.find((l) => l.id === id)?.name).toBe("Sky");
  });

  it("returns unique ids when called in a loop", () => {
    const { cmd } = setup([pixel("a")]);
    const made = new Set<string>();
    act(() => {
      for (let i = 0; i < 20; i++) made.add(cmd.newLayer());
    });
    expect(made.size).toBe(20);
  });

  it("inserts above the reference layer's whole cluster (after its mask)", () => {
    const { cmd, state } = setup([pixel("a"), mask("m", "a"), pixel("b")]);
    let id = "";
    act(() => {
      id = cmd.newLayer({ aboveId: "a" });
    });
    expect(ids(state().layers)).toEqual(["a", "m", id, "b"]);
  });

  it("joins the reference layer's group directly above it", () => {
    const { cmd, state, findGroup } = setup([pixel("a"), pixel("b"), group("g", ["a", "b"])]);
    let id = "";
    act(() => {
      id = cmd.newLayer({ aboveId: "a" });
    });
    expect(findGroup("g").childIds).toEqual(["a", id, "b"]);
    expect(ids(state().layers)).toEqual(["a", id, "b", "g"]);
  });
});

describe("LayerStackCommands.duplicateLayer", () => {
  it("copies the layer above itself with a ' copy' name and returns the new id", () => {
    const { cmd, state, pendingLayerLabelRef } = setup([
      pixel("a", { name: "Ink", opacity: 0.5 }),
      pixel("b"),
    ]);
    let id = "";
    act(() => {
      id = cmd.duplicateLayer("a");
    });
    expect(ids(state().layers)).toEqual(["a", id, "b"]);
    expect(state().layers[1]).toMatchObject({ name: "Ink copy", opacity: 0.5 });
    expect(state().activeLayerId).toBe(id);
    expect(fake.cloneLayerData).toHaveBeenCalledWith("a", id, "Ink copy");
    expect(pendingLayerLabelRef.current).toBe("Duplicate Layer");
  });

  it("brings the mask along, re-parented onto the copy", () => {
    const { cmd, state } = setup([pixel("a"), mask("m", "a")]);
    let id = "";
    act(() => {
      id = cmd.duplicateLayer("a", "Named");
    });
    const layers = state().layers;
    expect(layers).toHaveLength(4);
    const [, , copy, copyMask] = layers;
    expect(copy).toMatchObject({ id, name: "Named" });
    expect(copyMask).toMatchObject({ type: "mask", parentId: id });
    expect(copyMask.id).toMatch(/^mask-/);
    expect(fake.cloneLayerData).toHaveBeenCalledTimes(2);
  });

  it("duplicates a group with fresh ids for every child, leaving the original intact", () => {
    const { cmd, state, findGroup } = setup([pixel("a"), pixel("b"), group("g", ["a", "b"])]);
    let id = "";
    act(() => {
      id = cmd.duplicateLayer("g");
    });
    const layers = state().layers;
    expect(layers).toHaveLength(6);
    const copy = findGroup(id);
    expect(copy.name).toBe("g copy");
    expect(copy.childIds).toHaveLength(2);
    for (const c of copy.childIds) {
      expect(["a", "b"]).not.toContain(c);
      expect(layers.some((l) => l.id === c)).toBe(true);
    }
    expect(findGroup("g").childIds).toEqual(["a", "b"]);
  });

  it("adds a copy of a nested layer to its group right after the source", () => {
    const { cmd, findGroup } = setup([pixel("a"), pixel("b"), group("g", ["a", "b"])]);
    let id = "";
    act(() => {
      id = cmd.duplicateLayer("a");
    });
    expect(findGroup("g").childIds).toEqual(["a", id, "b"]);
  });

  it("throws for masks, missing layers and when the canvas isn't ready", () => {
    const { cmd } = setup([pixel("a"), mask("m", "a")]);
    expect(() => cmd.duplicateLayer("m")).toThrow(/can't be duplicated/);
    expect(() => cmd.duplicateLayer("nope")).toThrow(/no longer exists/);
    const noHandle = setup([pixel("a")], null, [], false);
    expect(() => noHandle.cmd.duplicateLayer("a")).toThrow(/isn't ready/);
  });
});

describe("LayerStackCommands.deleteLayer", () => {
  it("removes the layer together with its mask", () => {
    const { cmd, state } = setup([pixel("a"), mask("m", "a"), pixel("b")], "a");
    act(() => cmd.deleteLayer("a"));
    expect(ids(state().layers)).toEqual(["b"]);
    expect(state().activeLayerId).toBe("b");
  });

  it("refuses to delete the last layer or an unknown one", () => {
    const { cmd, state } = setup([pixel("a")]);
    expect(() => cmd.deleteLayer("a")).toThrow(/at least one layer/);
    expect(() => cmd.deleteLayer("zzz")).toThrow(/no longer exists/);
    expect(ids(state().layers)).toEqual(["a"]);
  });

  it("throws when the layer is inside a locked composite", () => {
    const composite = {
      ...group("c", ["a"]),
      type: "composite",
      blendMode: "normal",
      locked: true,
    } as LayerState;
    const { cmd, state } = setup([pixel("a"), composite, pixel("b")]);
    expect(() => cmd.deleteLayer("a")).toThrow(/locked composite/);
    expect(ids(state().layers)).toEqual(["a", "c", "b"]);
  });
});

describe("LayerStackCommands merges", () => {
  it("mergeLayers rasterizes the roots plus their attachments and puts the result at the topmost position", async () => {
    const { cmd, state, pendingLayerLabelRef } = setup([
      pixel("a"),
      mask("m", "a"),
      pixel("x"),
      pixel("b", { name: "Top" }),
    ]);
    let id = "";
    await act(async () => {
      id = await cmd.mergeLayers(["a", "b"]);
    });
    const [rasterized, reason] = fake.rasterizeLayers.mock.calls[0];
    expect(ids(rasterized)).toEqual(["a", "m", "b"]);
    expect(reason).toBe("merge");
    expect(ids(state().layers)).toEqual(["x", id]);
    expect(state().layers[1]).toMatchObject({ name: "Top", opacity: 1, blendMode: "normal", visible: true });
    expect(state().activeLayerId).toBe(id);
    expect(pendingLayerLabelRef.current).toBe("Merge Layers");
    expect(fake.prepareNewLayer).toHaveBeenCalledWith(
      id,
      "Top",
      expect.any(Uint8Array),
      undefined,
      undefined,
      undefined,
      undefined,
      "rgba8",
    );
  });

  it("mergeLayers ignores groups / masks and needs two mergeable layers", async () => {
    const { cmd } = setup([pixel("a"), mask("m", "a"), pixel("b"), group("g", ["b"])]);
    await expect(cmd.mergeLayers(["a", "m", "g"])).rejects.toThrow(/at least two/);
    expect(fake.rasterizeLayers).not.toHaveBeenCalled();
  });

  it("mergeDown merges into the layer below and keeps the lower layer's name", async () => {
    const { cmd, state, pendingLayerLabelRef } = setup([pixel("a", { name: "Base" }), pixel("b")]);
    let id = "";
    await act(async () => {
      id = await cmd.mergeDown("b");
    });
    expect(ids(state().layers)).toEqual([id]);
    expect(state().layers[0].name).toBe("Base");
    expect(pendingLayerLabelRef.current).toBe("Merge Down");
  });

  it("mergeDown rejects the bottom layer, non-pixel layers and unknown ids", async () => {
    const { cmd } = setup([pixel("a"), pixel("b"), group("g", [])]);
    await expect(cmd.mergeDown("a")).rejects.toThrow(/no layer below/);
    await expect(cmd.mergeDown("g")).rejects.toThrow(/Only pixel/);
    await expect(cmd.mergeDown("nope")).rejects.toThrow(/no longer exists/);
  });

  it("mergeVisible skips hidden layers and names the result 'Merged'", async () => {
    const { cmd, state } = setup([pixel("a"), pixel("hidden", { visible: false }), pixel("b")]);
    let id = "";
    await act(async () => {
      id = await cmd.mergeVisible();
    });
    expect(ids(fake.rasterizeLayers.mock.calls[0][0])).toEqual(["a", "b"]);
    expect(ids(state().layers)).toEqual(["hidden", id]);
    expect(state().layers[1].name).toBe("Merged");
  });

  it("mergeVisible needs two visible layers", async () => {
    const { cmd } = setup([pixel("a"), pixel("b", { visible: false })]);
    await expect(cmd.mergeVisible()).rejects.toThrow(/two visible/);
  });

  it("indexed8 documents map the merged RGBA back to palette indices", async () => {
    const { cmd } = setup([pixel("a"), pixel("b")], null, [
      { type: "SET_PIXEL_FORMAT", payload: "indexed8" },
    ]);
    let id = "";
    await act(async () => {
      id = await cmd.mergeVisible();
    });
    expect(matchPaletteIndices).toHaveBeenCalledTimes(1);
    expect(fake.prepareNewLayerIndexed).toHaveBeenCalledWith(id, "Merged", expect.any(Uint8Array));
    expect(fake.prepareNewLayer).not.toHaveBeenCalled();
  });

  it("rgba32f documents create a float layer from the float raster", async () => {
    const data = new Float32Array(64).fill(2.5);
    fake.rasterizeComposite.mockResolvedValueOnce(raster(4, 4, data));
    const { cmd } = setup([pixel("a"), pixel("b")], null, [
      { type: "SET_PIXEL_FORMAT", payload: "rgba32f" },
    ]);
    await act(async () => {
      await cmd.flatten();
    });
    const call = fake.prepareNewLayer.mock.calls[0];
    expect(call[2]).toBe(data);
    expect(call[7]).toBe("rgba32f");
  });

  it("flatten replaces the whole stack with one 'Background' layer", async () => {
    const { cmd, state, pendingLayerLabelRef } = setup([
      pixel("a"),
      mask("m", "a"),
      pixel("b"),
      group("g", ["b"]),
    ]);
    let id = "";
    await act(async () => {
      id = await cmd.flatten();
    });
    expect(fake.rasterizeComposite).toHaveBeenCalledWith("flatten");
    expect(state().layers).toEqual([expect.objectContaining({ id, name: "Background" })]);
    expect(state().activeLayerId).toBe(id);
    expect(pendingLayerLabelRef.current).toBe("Flatten Image");
  });

  it("merge commands reject when the canvas isn't ready", async () => {
    const { cmd } = setup([pixel("a"), pixel("b")], null, [], false);
    await expect(cmd.mergeVisible()).rejects.toThrow(/isn't ready/);
    await expect(cmd.flatten()).rejects.toThrow(/isn't ready/);
  });
});

describe("LayerStackCommands.rasterizeLayer", () => {
  it("bakes the layer with its mask into a pixel layer keeping opacity / blend / visibility", async () => {
    const text = {
      ...pixel("t", { name: "Title", opacity: 0.4, blendMode: "multiply", visible: false }),
      type: "text",
    } as unknown as LayerState;
    const { cmd, state, pendingLayerLabelRef } = setup([pixel("a"), text, mask("m", "t")]);
    let id = "";
    await act(async () => {
      id = await cmd.rasterizeLayer("t");
    });
    expect(ids(fake.rasterizeLayers.mock.calls[0][0])).toEqual(["t", "m"]);
    expect(ids(state().layers)).toEqual(["a", id]);
    expect(state().layers[1]).toEqual({
      id,
      name: "Title",
      visible: false,
      opacity: 0.4,
      locked: false,
      blendMode: "multiply",
    });
    expect(pendingLayerLabelRef.current).toBe("Rasterize Layer");
  });

  it("replaces the layer's id inside its parent group", async () => {
    const { cmd, findGroup } = setup([pixel("a"), pixel("b"), group("g", ["a", "b"])]);
    let id = "";
    await act(async () => {
      id = await cmd.rasterizeLayer("b");
    });
    expect(findGroup("g").childIds).toEqual(["a", id]);
  });

  it("rasterizing a group drops its descendants and their masks", async () => {
    const { cmd, state } = setup([
      pixel("a"),
      mask("m", "a"),
      pixel("b"),
      group("g", ["a", "b"]),
      pixel("top"),
    ]);
    let id = "";
    await act(async () => {
      id = await cmd.rasterizeLayer("g");
    });
    expect(ids(fake.rasterizeLayers.mock.calls[0][0])).toEqual(["a", "m", "b", "g"]);
    expect(ids(state().layers)).toEqual([id, "top"]);
  });

  it("refuses masks", async () => {
    const { cmd } = setup([pixel("a"), mask("m", "a")]);
    await expect(cmd.rasterizeLayer("m")).rejects.toThrow(/can't be rasterized/);
  });
});

describe("LayerStackCommands.addMask", () => {
  it("adds a mask directly above the layer and returns its id", () => {
    const { cmd, state, pendingLayerLabelRef } = setup([pixel("a"), pixel("b")]);
    let id = "";
    act(() => {
      id = cmd.addMask("a");
    });
    expect(id).toMatch(/^mask-/);
    expect(ids(state().layers)).toEqual(["a", id, "b"]);
    expect(state().layers[1]).toMatchObject({ type: "mask", parentId: "a" });
    expect(pendingLayerLabelRef.current).toBe("Add Layer Mask");
  });

  it("returns the existing mask instead of adding a second one", () => {
    const { cmd, state, pendingLayerLabelRef } = setup([pixel("a"), mask("m", "a")]);
    expect(cmd.addMask("a")).toBe("m");
    expect(state().layers).toHaveLength(2);
    expect(pendingLayerLabelRef.current).toBeNull();
  });

  it("throws for masks and clears the history label when the reducer refuses", () => {
    const composite = {
      ...group("c", []),
      type: "composite",
      blendMode: "normal",
      locked: true,
    } as LayerState;
    const { cmd, state, pendingLayerLabelRef } = setup([pixel("a"), mask("m", "a"), composite]);
    expect(() => cmd.addMask("m")).toThrow(/can't have a layer mask/);
    act(() => {
      cmd.addMask("c");
    });
    expect(state().layers).toHaveLength(3);
    expect(pendingLayerLabelRef.current).toBeNull();
  });
});

describe("useLayers menu handlers", () => {
  it("report command failures to the user instead of throwing", async () => {
    const { result } = setup([pixel("a"), pixel("b")], "a");
    act(() => result.current.handleMergeDown());
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    expect(alertSpy.mock.calls[0][0]).toMatch(/^Merge down failed\.\n\nThere's no layer below/);
  });

  it("handleMergeSelected does nothing with fewer than two ids", () => {
    const { result } = setup([pixel("a"), pixel("b")]);
    act(() => result.current.handleMergeSelected(["a"]));
    expect(fake.rasterizeLayers).not.toHaveBeenCalled();
  });

  it("handleDeleteActiveLayer keeps the last layer", () => {
    const { result, state } = setup([pixel("a")], "a");
    act(() => result.current.handleDeleteActiveLayer());
    expect(ids(state().layers)).toEqual(["a"]);
  });

  it("handleFlattenImage needs two non-mask layers", async () => {
    const { result } = setup([pixel("a"), mask("m", "a")], "a");
    act(() => result.current.handleFlattenImage());
    await Promise.resolve();
    expect(fake.rasterizeComposite).not.toHaveBeenCalled();
  });

  it("handleDuplicateLayer duplicates the active layer", async () => {
    const { result, state } = setup([pixel("a"), pixel("b")], "b");
    act(() => result.current.handleDuplicateLayer());
    await waitFor(() => expect(state().layers).toHaveLength(3));
    expect(state().layers[2].name).toBe("b copy");
  });
});
