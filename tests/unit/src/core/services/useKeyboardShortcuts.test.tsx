import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import { activeScope } from "@/core/store/scope";
import { useKeyboardShortcuts } from "@/core/services/useKeyboardShortcuts";

afterEach(cleanup);

type Opts = Parameters<typeof useKeyboardShortcuts>[0];

const HANDLERS = [
  "handleUndo",
  "handleRedo",
  "handleCopy",
  "handleCopyMerged",
  "handleCut",
  "handlePaste",
  "handlePasteInto",
  "handleDelete",
  "handleZoomIn",
  "handleZoomOut",
  "handleFitToWindow",
  "handleToggleGrid",
  "handleKeyboardShortcuts",
  "handleFreeTransform",
  "handleInvertSelection",
  "handleSelectAll",
  "handleDeselect",
  "handleSelectAllLayers",
  "handleCloneStamp",
  "handleContentAwareDelete",
  "handleFindLayers",
  "handleCycleLasso",
  "handleCycleWand",
  "handleNew",
  "handleOpen",
  "handleSave",
  "handleSaveAs",
  "handleExport",
  "handleNewLayer",
  "handleGroupLayers",
  "handleUngroupLayers",
  "handleToggleProofColors",
  "handleToggleGamutWarning",
] as const;

function setup(extra: Partial<Opts> = {}) {
  const h = Object.fromEntries(HANDLERS.map((k) => [k, vi.fn()])) as unknown as Record<
    (typeof HANDLERS)[number],
    ReturnType<typeof vi.fn>
  >;
  const r = renderHook(() => useKeyboardShortcuts({ ...(h as unknown as Opts), ...extra }));
  /** Names of the handlers called so far. */
  const called = () => HANDLERS.filter((k) => h[k].mock.calls.length > 0);
  return { h, called, ...r };
}

const key = (k: string, mods: Partial<KeyboardEventInit> = {}, target: Element = document.body) =>
  fireEvent.keyDown(target, { key: k, bubbles: true, ...mods });

describe("useKeyboardShortcuts", () => {
  it.each([
    ["z", { ctrlKey: true }, "handleUndo"],
    ["Z", { ctrlKey: true, shiftKey: true }, "handleRedo"],
    ["Z", { metaKey: true, shiftKey: true }, "handleRedo"],
    ["y", { ctrlKey: true }, "handleToggleProofColors"],
    ["Y", { ctrlKey: true, shiftKey: true }, "handleToggleGamutWarning"],
    ["z", { metaKey: true }, "handleUndo"],
    ["c", { ctrlKey: true }, "handleCopy"],
    ["C", { ctrlKey: true, shiftKey: true }, "handleCopyMerged"],
    ["x", { ctrlKey: true }, "handleCut"],
    ["v", { ctrlKey: true }, "handlePaste"],
    ["V", { ctrlKey: true, shiftKey: true }, "handlePasteInto"],
    ["=", { ctrlKey: true }, "handleZoomIn"],
    ["+", { ctrlKey: true }, "handleZoomIn"],
    ["-", { ctrlKey: true }, "handleZoomOut"],
    ["0", { ctrlKey: true }, "handleFitToWindow"],
    ["'", { ctrlKey: true }, "handleToggleGrid"],
    ["t", { ctrlKey: true }, "handleFreeTransform"],
    ["I", { ctrlKey: true, shiftKey: true }, "handleInvertSelection"],
    ["a", { ctrlKey: true }, "handleSelectAll"],
    ["a", { ctrlKey: true, altKey: true }, "handleSelectAllLayers"],
    ["d", { ctrlKey: true }, "handleDeselect"],
    ["F", { ctrlKey: true, altKey: true, shiftKey: true }, "handleFindLayers"],
    ["n", { ctrlKey: true }, "handleNew"],
    ["N", { ctrlKey: true, shiftKey: true }, "handleNewLayer"],
    ["o", { ctrlKey: true }, "handleOpen"],
    ["s", { ctrlKey: true }, "handleSave"],
    ["S", { ctrlKey: true, shiftKey: true }, "handleSaveAs"],
    ["e", { ctrlKey: true }, "handleExport"],
    ["g", { ctrlKey: true }, "handleGroupLayers"],
    ["G", { ctrlKey: true, shiftKey: true }, "handleUngroupLayers"],
    ["Delete", {}, "handleDelete"],
    ["Backspace", {}, "handleDelete"],
    ["Delete", { shiftKey: true }, "handleContentAwareDelete"],
    ["?", { shiftKey: true }, "handleKeyboardShortcuts"],
    ["s", {}, "handleCloneStamp"],
    ["l", {}, "handleCycleLasso"],
    ["W", {}, "handleCycleWand"],
  ] as const)("%s %o → %s only", (k, mods, expected) => {
    const { called } = setup();
    const ev = key(k, mods);
    expect(called()).toEqual([expected]);
    // Handled shortcuts suppress the browser default.
    expect(ev).toBe(false);
  });

  it("ignores keys typed into text inputs and textareas", () => {
    const { called } = setup();
    const input = document.createElement("input");
    const area = document.createElement("textarea");
    document.body.append(input, area);
    key("z", { ctrlKey: true }, input);
    key("Delete", {}, area);
    key("s", {}, input);
    expect(called()).toEqual([]);
    input.remove();
    area.remove();
  });

  it("plain letters with a modifier don't switch tools", () => {
    const { called } = setup();
    key("l", { altKey: true });
    key("w", { shiftKey: true });
    expect(called()).toEqual([]);
  });

  it("unbound Ctrl combos do nothing and keep the browser default", () => {
    const { called } = setup();
    expect(key("q", { ctrlKey: true })).toBe(true);
    expect(called()).toEqual([]);
  });

  it("Escape releases a releasable tool first, keeping the selection", () => {
    const clear = vi.spyOn(activeScope().selection, "clear");
    const handleReleaseTool = vi.fn(() => true);
    setup({ handleReleaseTool });
    key("Escape");
    expect(handleReleaseTool).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
  });

  it("Escape otherwise clears the selection and the crop", () => {
    const clearSel = vi.spyOn(activeScope().selection, "clear");
    const clearCrop = vi.spyOn(activeScope().crop, "clear");
    const { called } = setup({ handleReleaseTool: () => false });
    key("Escape");
    expect(clearSel).toHaveBeenCalledTimes(1);
    expect(clearCrop).toHaveBeenCalledTimes(1);
    expect(called()).toEqual([]);
  });

  it("removes its listener on unmount", () => {
    const { called, unmount } = setup();
    unmount();
    key("z", { ctrlKey: true });
    expect(called()).toEqual([]);
  });

  it("Ctrl+Shift+Y (Gamut Warning) does not trigger Redo", () => {
    const { h } = setup();
    key("Y", { ctrlKey: true, shiftKey: true });
    expect(h.handleRedo).not.toHaveBeenCalled();
  });
});
