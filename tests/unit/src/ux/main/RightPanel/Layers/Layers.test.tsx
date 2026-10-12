import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { LayerState } from "@/types";
import type { AppAction } from "@/core/store/AppContext";
import { Layers } from "@/ux/main/RightPanel/Layers/Layers";
import { group, ids, mask, pixel, renderWithAppStore, seedLayers } from "@tests/fakes/uxAppStore";

beforeEach(() => {
  vi.stubGlobal("api", { platform: "win32" });
});
afterEach(cleanup);

function setup(layers: LayerState[], active: string | null, extra: AppAction[] = []) {
  const props = {
    onMergeSelected: vi.fn(),
    onMergeVisible: vi.fn(),
    onMergeDown: vi.fn(),
    onFlattenImage: vi.fn(),
    onRasterizeLayer: vi.fn(),
    onDuplicateLayer: vi.fn(),
    onMergeGroup: vi.fn(),
    onGroupSelected: vi.fn(),
    onUngroup: vi.fn(),
    onCreateCompositeLayer: vi.fn(),
    onRefreshLinkedLayer: vi.fn(),
    captureHistory: vi.fn(),
    pendingLayerLabelRef: { current: null as string | null },
  };
  const utils = renderWithAppStore(<Layers {...props} />, [...seedLayers(layers, active), ...extra]);
  const list = () => screen.getByRole("listbox", { name: "Layers" });
  const row = (name: string) =>
    within(list())
      .getAllByRole("option")
      .find((o) => within(o).queryByText(name, { exact: true }))!;
  const rowNames = () =>
    within(list())
      .getAllByRole("option")
      .map((o) => o.querySelector("[title='Double-click to rename']")?.textContent);
  const state = () => utils.store.getState();
  return { ...props, ...utils, list, row, rowNames, state };
}

describe("Layers panel", () => {
  it("lists layers top-most first and marks the active one", () => {
    const { rowNames, row } = setup([pixel("a"), pixel("b"), pixel("c")], "b");
    expect(rowNames()).toEqual(["c", "b", "a"]);
    expect(row("b").getAttribute("aria-selected")).toBe("true");
    expect(row("a").getAttribute("aria-selected")).toBe("false");
  });

  it("shows group children under their group and a mask under its layer", () => {
    const { rowNames } = setup([pixel("a"), mask("m", "a"), pixel("b"), group("g", ["b"])], "a");
    expect(rowNames()).toEqual(["g", "b", "a", "Layer Mask"]);
  });

  it("clicking a row makes it active; Ctrl-click and Shift-click build a multi-selection", () => {
    const { row, state } = setup([pixel("a"), pixel("b"), pixel("c"), pixel("d")], "a");
    fireEvent.click(row("d"));
    expect(state().activeLayerId).toBe("d");
    fireEvent.click(row("b"), { ctrlKey: true });
    expect(state().selectedLayerIds).toEqual(["b"]);
    fireEvent.click(row("b"), { ctrlKey: true });
    expect(state().selectedLayerIds).toEqual([]);
    fireEvent.click(row("c"));
    fireEvent.click(row("a"), { shiftKey: true });
    expect([...state().selectedLayerIds].sort()).toEqual(["a", "b", "c"]);
  });

  it("the eye button toggles visibility without selecting the row, and records history", () => {
    const { row, state, captureHistory } = setup([pixel("a"), pixel("b")], "b");
    fireEvent.click(within(row("a")).getByRole("button", { name: "Hide layer" }));
    expect(state().layers[0].visible).toBe(false);
    expect(state().activeLayerId).toBe("b");
    expect(captureHistory).toHaveBeenCalledWith("Layer Visibility");
    expect(within(row("a")).getByRole("button", { name: "Show layer" })).toBeTruthy();
  });

  it("double-click renames; Enter commits a trimmed name, Escape and empty names cancel", () => {
    const { row, state, captureHistory, list } = setup([pixel("a")], "a");
    const startEdit = () => {
      fireEvent.doubleClick(within(row("a") ?? list()).getByTitle("Double-click to rename"));
      return within(list()).getByRole("textbox") as HTMLInputElement;
    };
    let input = startEdit();
    expect(input.value).toBe("a");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(state().layers[0].name).toBe("a");

    input = startEdit();
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(state().layers[0].name).toBe("a");

    input = startEdit();
    fireEvent.change(input, { target: { value: "  Sky  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(state().layers[0].name).toBe("Sky");
    expect(captureHistory).toHaveBeenCalledWith("Rename Layer");
  });

  it("Delete removes the active and selected layers but never all of them", () => {
    const { state } = setup([pixel("a"), pixel("b"), pixel("c")], "c", [
      { type: "SET_SELECTED_LAYERS", payload: ["a"] },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Delete layer" }));
    expect(ids(state().layers)).toEqual(["b"]);
    expect((screen.getByRole("button", { name: "Delete layer" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("New layer adds a pixel layer on top", () => {
    const { state } = setup([pixel("a")], "a");
    fireEvent.click(screen.getByRole("button", { name: "New layer" }));
    expect(state().layers).toHaveLength(2);
    expect(state().layers[1]).toMatchObject({ name: "Layer 2", visible: true, opacity: 1 });
  });

  it("Add layer mask adds one mask, then disables itself", () => {
    const { state, pendingLayerLabelRef } = setup([pixel("a")], "a");
    const btn = screen.getByRole("button", { name: "Add layer mask" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(state().layers[1]).toMatchObject({ type: "mask", parentId: "a" });
    expect(pendingLayerLabelRef.current).toBe("Add Layer Mask");
    // The new mask is active now: masks can't get a mask.
    expect((screen.getByRole("button", { name: "Add layer mask" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("New group groups a multi-selection, or adds an empty group above the active layer", () => {
    const multi = setup([pixel("a"), pixel("b")], "b", [{ type: "SET_SELECTED_LAYERS", payload: ["a"] }]);
    fireEvent.click(screen.getByRole("button", { name: "New group" }));
    expect([...multi.onGroupSelected.mock.calls[0][0]].sort()).toEqual(["a", "b"]);
    cleanup();

    const single = setup([pixel("a"), pixel("b")], "a");
    fireEvent.click(screen.getByRole("button", { name: "New group" }));
    expect(single.state().layers[1]).toMatchObject({ type: "group", name: "Group", childIds: [] });
    expect(single.pendingLayerLabelRef.current).toBe("New Group");
  });

  it("New group with a nested active layer creates the group next to it, inside its group", () => {
    const { state, rowNames } = setup([pixel("a"), pixel("b"), group("g", ["a", "b"])], "a");
    fireEvent.click(screen.getByRole("button", { name: "New group" }));
    const created = state().layers.find((l) => l.name === "Group")!;
    const g = state().layers.find((l) => l.id === "g") as ReturnType<typeof group>;
    expect(g.childIds).toEqual(["a", created.id, "b"]);
    expect(rowNames()).toEqual(["g", "b", "Group", "a"]);
  });

  it("Duplicate and New composite delegate to the app", () => {
    const { onDuplicateLayer, onCreateCompositeLayer } = setup([pixel("a")], "a");
    fireEvent.click(screen.getByRole("button", { name: "Duplicate layer" }));
    fireEvent.click(screen.getByRole("button", { name: "New composite layer" }));
    expect(onDuplicateLayer).toHaveBeenCalledTimes(1);
    expect(onCreateCompositeLayer).toHaveBeenCalledTimes(1);
  });

  it("the filter shows matching layers, keeps the group of a matching child, and reports no matches", () => {
    const { rowNames } = setup(
      [pixel("Sky"), pixel("Tree"), group("Forest", ["Tree"]), pixel("Ground")],
      "Sky",
    );
    const filter = screen.getByRole("textbox", { name: "Filter layers by name" });
    fireEvent.change(filter, { target: { value: "tree" } });
    expect(rowNames()).toEqual(["Forest", "Tree"]);
    expect(screen.getByText("2 of 4")).toBeTruthy();
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(screen.getByText(/No layers match/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(rowNames()).toHaveLength(4);
  });

  it("collapsing a group hides its children and highlights the group for a hidden active child", () => {
    const { rowNames, row } = setup([pixel("a"), group("g", ["a"])], "a");
    fireEvent.click(screen.getByRole("button", { name: "Collapse group" }));
    expect(rowNames()).toEqual(["g"]);
    expect(row("g").getAttribute("aria-selected")).toBe("true");
  });
});
