import { afterEach, describe, expect, it, vi } from "vitest";
import { cellPreviewStore } from "@/core/store/cellPreviewStore";

function bitmap(): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn(), width: 1, height: 1 } as unknown as ImageBitmap & {
    close: ReturnType<typeof vi.fn>;
  };
}

const paths: string[] = [];
afterEach(() => {
  for (const p of paths.splice(0)) cellPreviewStore.delete(p);
});

describe("cellPreviewStore", () => {
  it("keys paths case- and separator-insensitively", () => {
    const b = bitmap();
    paths.push("C:/Frames/f1.verve");
    cellPreviewStore.set("C:\\Frames\\F1.verve", b);
    expect(cellPreviewStore.get("c:/frames/f1.VERVE")).toBe(b);
    expect(cellPreviewStore.has("C:/FRAMES/f1.verve")).toBe(true);
  });

  it("replacing an entry closes the old bitmap (not the same one)", () => {
    const a = bitmap();
    const b = bitmap();
    paths.push("x");
    cellPreviewStore.set("x", a);
    cellPreviewStore.set("x", a);
    expect(a.close).not.toHaveBeenCalled();
    cellPreviewStore.set("x", b);
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(cellPreviewStore.get("x")).toBe(b);
  });

  it("delete closes the bitmap; deleting a missing path is silent", () => {
    const a = bitmap();
    cellPreviewStore.set("gone", a);
    const fn = vi.fn();
    const off = cellPreviewStore.subscribe(fn);
    const v = cellPreviewStore.version;
    cellPreviewStore.delete("gone");
    cellPreviewStore.delete("gone");
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(cellPreviewStore.has("gone")).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(cellPreviewStore.version).toBe(v + 1);
    off();
  });
});
