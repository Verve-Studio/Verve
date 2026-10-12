import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewImageDialog } from "@/ux/modals/NewImageDialog/NewImageDialog";

afterEach(cleanup);

function setup() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const utils = render(<NewImageDialog open onConfirm={onConfirm} onCancel={onCancel} />);
  const width = screen.getByLabelText("Width") as HTMLInputElement;
  const height = screen.getByLabelText("Height") as HTMLInputElement;
  const ppi = screen.getByLabelText("Resolution") as HTMLInputElement;
  const units = screen.getByLabelText("Units") as HTMLSelectElement;
  const mode = screen.getByLabelText("Color Mode") as HTMLSelectElement;
  const set = (el: HTMLInputElement | HTMLSelectElement, v: string) =>
    fireEvent.change(el, { target: { value: v } });
  const create = () => fireEvent.click(screen.getByRole("button", { name: "Create" }));
  return { onConfirm, onCancel, width, height, ppi, units, mode, set, create, ...utils };
}

describe("NewImageDialog", () => {
  it("defaults to 1920×1080 rgba8 on white", () => {
    const { onConfirm, create, width, height } = setup();
    expect(width.value).toBe("1920");
    expect(height.value).toBe("1080");
    expect(screen.getByText("1920 × 1080 px")).toBeTruthy();
    create();
    expect(onConfirm).toHaveBeenCalledWith({
      width: 1920,
      height: 1080,
      backgroundFill: "white",
      pixelFormat: "rgba8",
    });
  });

  it("submits the chosen colour mode and background", () => {
    const { onConfirm, create, mode, set } = setup();
    for (const fmt of ["rgba32f", "indexed8"] as const) {
      set(mode, fmt);
      fireEvent.click(screen.getByLabelText("Transparent"));
      create();
      expect(onConfirm).toHaveBeenLastCalledWith(
        expect.objectContaining({ pixelFormat: fmt, backgroundFill: "transparent" }),
      );
    }
    fireEvent.click(screen.getByLabelText("Black"));
    create();
    expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ backgroundFill: "black" }));
  });

  it("presets set the pixel size", () => {
    const { onConfirm, create } = setup();
    fireEvent.click(screen.getByTitle("16 × 16 px"));
    create();
    expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ width: 16, height: 16 }));
    fireEvent.click(screen.getByRole("button", { name: /427 × 240/ }));
    create();
    expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ width: 427, height: 240 }));
  });

  it("print presets are portrait at 300 ppi", () => {
    const { onConfirm, create, ppi } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^A4/ }));
    expect(ppi.value).toBe("300");
    create();
    // 210 × 297 mm at 300 ppi
    expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ width: 2480, height: 3508 }));
  });

  it("typed pixel sizes are submitted", () => {
    const { onConfirm, create, width, height, set } = setup();
    set(width, "800");
    set(height, "600");
    expect(screen.getByText("800 × 600 px")).toBeTruthy();
    create();
    expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ width: 800, height: 600 }));
  });

  it("ignores zero, negative and empty sizes", () => {
    const { width, set } = setup();
    set(width, "0");
    set(width, "-5");
    set(width, "");
    expect(screen.getByText("1920 × 1080 px")).toBeTruthy();
  });

  it("clamps oversize documents to 16384 on create", () => {
    const { onConfirm, create, width, set } = setup();
    set(width, "50000");
    create();
    expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ width: 16384, height: 1080 }));
  });

  it("converts physical units through the resolution", () => {
    const { onConfirm, create, width, height, ppi, units, set } = setup();
    set(ppi, "100");
    set(units, "in");
    expect(width.value).toBe("19.2");
    expect(screen.getByText("19.2 × 10.8 in")).toBeTruthy();
    set(width, "3");
    set(height, "2.5");
    create();
    expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ width: 300, height: 250 }));

    set(units, "cm");
    set(width, "2.54");
    create();
    expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ width: 100 }));

    set(units, "mm");
    set(height, "50.8");
    create();
    expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ height: 200 }));
  });

  it("changing the resolution keeps pixels in px and the physical size otherwise", () => {
    const { onConfirm, create, ppi, units, set } = setup();
    set(ppi, "144");
    create();
    expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ width: 1920, height: 1080 }));
    set(units, "in"); // 1920 px @ 144 = 13.33 in
    set(ppi, "72");
    create();
    expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ width: 960, height: 540 }));
  });

  it("orientation buttons swap the sides", () => {
    const { onConfirm, create } = setup();
    const portrait = screen.getByRole("button", { name: "Portrait" });
    const landscape = screen.getByRole("button", { name: "Landscape" });
    expect(landscape.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(portrait);
    expect(portrait.getAttribute("aria-pressed")).toBe("true");
    create();
    expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ width: 1080, height: 1920 }));
    fireEvent.click(portrait); // already portrait: no change
    fireEvent.click(landscape);
    create();
    expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ width: 1920, height: 1080 }));
  });

  it("Clipboard Size takes the clipboard image's size", async () => {
    const clipboardImageSize = vi.fn(async () => ({ width: 333, height: 222 }));
    vi.stubGlobal("api", { clipboardImageSize });
    const { onConfirm, create } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Clipboard Size/ }));
    await waitFor(() => expect(screen.getByText("333 × 222 px")).toBeTruthy());
    create();
    expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ width: 333, height: 222 }));
  });

  it("Clipboard Size without an image changes nothing", async () => {
    const clipboardImageSize = vi.fn(async () => null);
    vi.stubGlobal("api", { clipboardImageSize });
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Clipboard Size/ }));
    await waitFor(() => expect(clipboardImageSize).toHaveBeenCalled());
    expect(screen.getByText("1920 × 1080 px")).toBeTruthy();
  });

  it("Enter creates; Escape and Cancel cancel", () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("resets to defaults when reopened", () => {
    const { width, set, rerender, onConfirm, onCancel } = setup();
    set(width, "10");
    rerender(<NewImageDialog open={false} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<NewImageDialog open onConfirm={onConfirm} onCancel={onCancel} />);
    expect((screen.getByLabelText("Width") as HTMLInputElement).value).toBe("1920");
  });
});
