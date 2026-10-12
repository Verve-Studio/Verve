import { afterEach, describe, expect, it, vi } from "vitest";
import { activeScope, createDocumentScope, setActiveScope, type DocumentScope } from "@/core/store/scope";

const initial = activeScope();
afterEach(() => {
  setActiveScope(initial);
});

describe("document scope", () => {
  it("a bootstrap scope exists before any tab is opened", () => {
    expect(initial).toBeDefined();
    expect(initial.selection).toBeDefined();
    expect(initial.history).toBeDefined();
  });

  it("createDocumentScope builds an independent store bundle", () => {
    const a = createDocumentScope();
    const b = createDocumentScope();
    const keys: (keyof DocumentScope)[] = [
      "selection",
      "history",
      "crop",
      "transform",
      "polygonalSelection",
      "inpaintMask",
      "cloneStamp",
      "adjustmentPreview",
      "paletteCycle",
      "brushOverrides",
      "healingSource",
    ];
    expect(Object.keys(a).sort()).toEqual([...keys].sort());
    for (const k of keys) expect(a[k]).not.toBe(b[k]);
    a.selection.setDimensions(4, 4);
    a.selection.setRect(0, 0, 1, 1);
    expect(b.selection.mask).toBeNull();
    a.history.dispose();
    b.history.dispose();
  });

  it("setActiveScope swaps what activeScope returns; no copying", () => {
    const tab = createDocumentScope();
    tab.selection.setDimensions(2, 2);
    tab.selection.setRect(0, 0, 0, 0);
    setActiveScope(tab);
    expect(activeScope()).toBe(tab);
    expect(activeScope().selection.mask).toBe(tab.selection.mask);
    tab.history.dispose();
  });

  it("subscribers registered under one tab keep receiving the next tab's changes", () => {
    const tab1 = createDocumentScope();
    const tab2 = createDocumentScope();
    setActiveScope(tab1);

    const seen: (Uint8Array | null)[] = [];
    const onSelection = (): void => {
      seen.push(activeScope().selection.mask);
    };
    activeScope().selection.subscribe(onSelection);
    const onCrop = vi.fn();
    activeScope().crop.subscribe(onCrop);
    const onHistory = vi.fn();
    const offHistory = activeScope().history.subscribe(onHistory);

    try {
      setActiveScope(tab2);
      // Switching notifies every store so subscribers re-read the new scope.
      expect(seen).toEqual([null]);
      expect(onCrop).toHaveBeenCalledTimes(1);
      expect(onHistory).toHaveBeenCalledTimes(1);

      tab2.selection.setDimensions(2, 2);
      tab2.selection.setRect(0, 0, 1, 1);
      expect(seen.at(-1)).toBe(tab2.selection.mask);
      tab2.crop.commitRect(0, 0, 5, 5);
      expect(onCrop).toHaveBeenCalledTimes(2);
    } finally {
      tab1.selection.unsubscribe(onSelection);
      tab1.crop.unsubscribe(onCrop);
      offHistory();
      tab1.history.dispose();
      tab2.history.dispose();
    }
  });

  it("re-activating the active scope does not notify", () => {
    const fn = vi.fn();
    initial.selection.subscribe(fn);
    setActiveScope(initial);
    expect(fn).not.toHaveBeenCalled();
    initial.selection.unsubscribe(fn);
  });

  it("each scope's per-document state stays with it across switches", () => {
    const tab1 = createDocumentScope();
    const tab2 = createDocumentScope();
    setActiveScope(tab1);
    activeScope().cloneStamp.setSource(3, 4, "layer-a");
    setActiveScope(tab2);
    expect(activeScope().cloneStamp.source).toBeNull();
    setActiveScope(tab1);
    expect(activeScope().cloneStamp.source).toEqual({ x: 3, y: 4, layerId: "layer-a" });
    tab1.history.dispose();
    tab2.history.dispose();
  });
});
